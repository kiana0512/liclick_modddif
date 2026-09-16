import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Pool } from 'pg';
import { createPgProjectSqlDatabase } from '../dist/repositories/postgresProjectRepository.js';

// Inject transport faults at the pg boundary; no production database is used.
const originalConnect = Pool.prototype.connect;
const originalError = console.error;
const logs = [];
const clients = [];
let activePool;
Pool.prototype.connect = async function () {
  activePool = this;
  const client = clients.shift();
  if (client instanceof Error) throw client;
  assert.ok(client, 'Unexpected connection/retry');
  return client;
};
console.error = (...args) => logs.push(args.join(' '));

function client(failures = {}) {
  const result = new EventEmitter();
  result.queries = [];
  result.releases = [];
  result.query = async (sql) => {
    result.queries.push(sql);
    if (failures[sql]) throw failures[sql];
    return { rows: [{ value: 1 }], rowCount: 1 };
  };
  result.release = (destroy) => result.releases.push(destroy);
  clients.push(result);
  return result;
}
const db = createPgProjectSqlDatabase('postgres://unused-test-only');
try {
  const healthy = client();
  assert.deepEqual(await db.transaction((connection) => connection.query('SELECT 1')), {
    rows: [{ value: 1 }], affectedRows: 1,
  });
  assert.deepEqual(healthy.queries, ['BEGIN', 'SELECT 1', 'COMMIT']);
  assert.deepEqual(healthy.releases, [false]);
  assert.equal(healthy.listenerCount('error'), 0);

  assert.doesNotThrow(() => activePool.emit('error', new Error('SECRET SQL TOKEN'), healthy));
  assert.equal(logs.length, 1);
  assert.ok(!logs[0].includes('SECRET'));

  const businessError = new Error('revision conflict');
  const rollback = client();
  await assert.rejects(db.transaction(async () => { throw businessError; }), (e) => e === businessError);
  assert.deepEqual(rollback.queries, ['BEGIN', 'ROLLBACK']);
  assert.deepEqual(rollback.releases, [false]);

  const disconnected = new Error('Connection terminated unexpectedly');
  const betweenQueries = client();
  await assert.rejects(db.transaction(async () => {
    await Promise.resolve();
    betweenQueries.emit('error', disconnected);
    return 'must not commit';
  }), (e) => e === disconnected);
  assert.deepEqual(betweenQueries.queries, ['BEGIN']);
  assert.deepEqual(betweenQueries.releases, [true]);
  assert.equal(betweenQueries.listenerCount('error'), 0);

  for (const stage of ['BEGIN', 'SELECT 1', 'COMMIT']) {
    const originalFailure = new Error(`original ${stage}`);
    const broken = client({ [stage]: originalFailure, ROLLBACK: new Error('rollback also failed') });
    await assert.rejects(db.transaction((connection) => connection.query('SELECT 1')), (e) => e === originalFailure);
    assert.equal(broken.queries.filter((sql) => sql === stage).length, 1, 'Never retry uncertain writes');
    assert.deepEqual(broken.releases, [true]);
    assert.equal(broken.listenerCount('error'), 0);
  }

  clients.push(disconnected);
  await assert.rejects(db.transaction(async () => assert.fail('must not execute')), (e) => e === disconnected);
  const recovered = client();
  assert.equal(await db.transaction(async () => 'next request succeeds'), 'next request succeeds');
  assert.deepEqual(recovered.queries, ['BEGIN', 'COMMIT']);
  assert.deepEqual(recovered.releases, [false]);
  assert.equal(clients.length, 0);
} finally {
  Pool.prototype.connect = originalConnect;
  console.error = originalError;
  await db.close();
}
console.log('PostgreSQL lifecycle passed: idle/checked-out errors, rollback failure, no write replay, fresh recovery.');
