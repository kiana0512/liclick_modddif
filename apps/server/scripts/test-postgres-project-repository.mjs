import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { createPostgresProjectRepository } from '../dist/repositories/postgresProjectRepository.js';

process.env.LICLICK_RUNTIME_MODE = 'cloud';

const engine = new PGlite();
await engine.waitReady;
const migration = await fs.readFile(
  new URL('../sql/001_project_documents_postgres.sql', import.meta.url),
  'utf8',
);
await engine.exec(migration);

function connection(client) {
  return {
    async query(text, params = []) {
      const result = await client.query(text, params);
      return {
        rows: result.rows,
        affectedRows: result.affectedRows ?? 0,
      };
    },
  };
}

const database = {
  ...connection(engine),
  transaction(operation) {
    return engine.transaction((transaction) => operation(connection(transaction)));
  },
  close() {
    return engine.close();
  },
};

// Two independent repositories share one PostgreSQL engine, matching two API
// replicas connected to the same production database.
const repositoryA = createPostgresProjectRepository(database);
const repositoryB = createPostgresProjectRepository(database);
const userA = 'employee-postgres-a';
const userB = 'employee-postgres-b';

const created = await repositoryA.create(userA, { name: '事务项目', folderId: 'folder-a' });
assert.equal(created.project.workspaceMode, 'cloud-server');
assert.equal((await repositoryB.load(userB, created.project.id)), undefined);

const featureDocument = {
  ...created.project,
  objects: [
    {
      id: 'object-transactional',
      name: '完整模型',
      sourcePath: '/workspace/assets/models/full.glb',
    },
  ],
  references: [{ id: 'reference-1', url: '/workspace/assets/references/reference.png' }],
  captures: [{ id: 'capture-1', colorUrl: '/workspace/assets/captures/color.png' }],
  generations: [{ id: 'generation-1', resultUrl: '/workspace/assets/generations/result.png' }],
  layers: [{ id: 'layer-1', objectId: 'object-transactional', type: 'paint', visible: true }],
  bakedTextures: [{ id: 'baked-1', imageUrl: '/workspace/assets/baked/base-color.png' }],
  pipeline: {
    uv: { status: 'completed', taskId: 'uv-real-task', outputs: ['uv.glb'] },
    bake: { status: 'completed', taskId: 'bake-real-task', outputs: ['base-color.png'] },
  },
};
const featureSaved = await repositoryA.save(userA, created.project.id, featureDocument, {
  expectedRevisionId: created.project.revision.id,
  revisionSource: 'explicit',
});
assert.equal(featureSaved.project.objects.length, 1);
assert.equal(featureSaved.project.layers.length, 1);
assert.equal(featureSaved.project.pipeline.uv.taskId, 'uv-real-task');
assert.equal(featureSaved.project.pipeline.bake.taskId, 'bake-real-task');

const staleRevisionId = featureSaved.project.revision.id;
const snapshotA = { ...featureSaved.project, name: '实例 A 保存' };
const snapshotB = { ...featureSaved.project, name: '实例 B 保存' };
const concurrentResults = await Promise.allSettled([
  repositoryA.save(userA, created.project.id, snapshotA, {
    expectedRevisionId: staleRevisionId,
    revisionSource: 'explicit',
  }),
  repositoryB.save(userA, created.project.id, snapshotB, {
    expectedRevisionId: staleRevisionId,
    revisionSource: 'explicit',
  }),
]);
assert.equal(concurrentResults.filter((result) => result.status === 'fulfilled').length, 1);
const rejected = concurrentResults.find((result) => result.status === 'rejected');
assert.equal(rejected.reason.code, 'PROJECT_REVISION_CONFLICT');

const winner = await repositoryB.load(userA, created.project.id);
assert.ok(['实例 A 保存', '实例 B 保存'].includes(winner.project.name));
assert.equal(winner.project.objects.length, 1);
assert.equal(winner.project.layers.length, 1);
assert.equal(winner.project.pipeline.uv.taskId, 'uv-real-task');

const moved = await repositoryA.move(
  userA,
  created.project.id,
  'folder-b',
  winner.project.revision.id,
);
assert.equal(moved.project.folderId, 'folder-b');
const renamed = await repositoryB.rename(
  userA,
  created.project.id,
  '事务项目已完成',
  moved.project.revision.id,
);
assert.equal(renamed.project.name, '事务项目已完成');

const commandOptions = {
  commandId: 'command-postgres-idempotency-0001',
  commandSha256: 'a'.repeat(64),
  expectedRevisionId: renamed.project.revision.id,
  revisionSource: 'explicit',
};
const commandDocument = { ...renamed.project, name: '幂等命令只保存一次' };
const commandResults = await Promise.all([
  repositoryA.save(userA, created.project.id, commandDocument, commandOptions),
  repositoryB.save(userA, created.project.id, commandDocument, commandOptions),
]);
assert.equal(commandResults[0].project.revision.id, commandResults[1].project.revision.id);
assert.equal(commandResults[0].project.name, '幂等命令只保存一次');

const revisionRows = await database.query(
  `SELECT revision_number
     FROM project_document_revisions
    WHERE user_id = $1 AND project_id = $2
    ORDER BY revision_number`,
  [userA, created.project.id],
);
assert.deepEqual(
  revisionRows.rows.map((row) => row.revision_number),
  [1, 2, 3, 4, 5, 6],
);
const receiptRows = await database.query(
  `SELECT command_id
     FROM project_command_receipts
    WHERE user_id = $1 AND project_id = $2`,
  [userA, created.project.id],
);
assert.equal(receiptRows.rows.length, 1);

const duplicated = await repositoryA.duplicate(userA, created.project.id);
assert.notEqual(duplicated.project.id, created.project.id);
assert.equal(duplicated.project.objects.length, 1);
assert.equal(duplicated.project.layers.length, 1);
assert.equal((await repositoryB.list(userA)).length, 2);
assert.equal((await repositoryB.list(userB)).length, 0);

const deleted = await repositoryB.delete(userA, duplicated.project.id);
assert.equal(deleted.deleted, true);
assert.equal((await repositoryA.list(userA)).length, 1);
assert.equal(await repositoryA.load(userA, duplicated.project.id), undefined);

await database.close();
process.stdout.write(
  'PostgreSQL project repository passed: account isolation, full document parity, immutable revisions, cross-instance idempotency, conflict protection, rename/move/duplicate/delete.\n',
);
