import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { PGlite } from '@electric-sql/pglite';
import { createPostgresControlRepository } from '../dist/repositories/postgresControlRepository.js';
import { createPostgresProjectRepository } from '../dist/repositories/postgresProjectRepository.js';

const accountCount = Number.parseInt(process.env.LICLICK_CONTROL_PLANE_TEST_USERS ?? '100', 10);
const replicaCount = Number.parseInt(process.env.LICLICK_CONTROL_PLANE_TEST_REPLICAS ?? '8', 10);
assert.ok(accountCount >= 100 && accountCount <= 500);
assert.ok(replicaCount >= 2 && replicaCount <= 16);

const migrations = await Promise.all([
  fs.readFile(new URL('../sql/001_project_documents_postgres.sql', import.meta.url), 'utf8'),
  fs.readFile(new URL('../sql/002_shared_control_plane.sql', import.meta.url), 'utf8'),
  fs.readFile(new URL('../sql/003_performance_lab_sessions.sql', import.meta.url), 'utf8'),
  fs.readFile(new URL('../sql/004_asset_storage_v2_shadow.sql', import.meta.url), 'utf8'),
]);
const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'li3d-control-plane-'));
const databasePath = path.join(temporaryRoot, 'pgdata');

function connection(client) {
  return {
    async query(text, params = []) {
      const result = await client.query(text, params);
      return { rows: result.rows, affectedRows: result.affectedRows ?? 0 };
    },
  };
}

function database(engine) {
  return {
    ...connection(engine),
    transaction(operation) {
      return engine.transaction((transaction) => operation(connection(transaction)));
    },
    close() { return engine.close(); },
  };
}

const startedAt = performance.now();
let engine = new PGlite(databasePath);
await engine.waitReady;
for (const migration of migrations) await engine.exec(migration);
let sql = database(engine);
let replicas = Array.from({ length: replicaCount }, () => createPostgresControlRepository(sql));
let projectReplicas = Array.from({ length: replicaCount }, () => createPostgresProjectRepository(sql));
const users = Array.from({ length: accountCount }, (_, index) => ({
  id: `user-${String(index).padStart(3, '0')}`,
  email: `user-${index}@li3d.test`,
  name: `验收用户 ${index}`,
}));

await Promise.all(users.map((user, index) => replicas[index % replicaCount].upsertUser({
  id: user.id, displayName: user.name, email: user.email, authSource: 'feishu-oauth',
})));
const projects = await Promise.all(users.map((user, index) =>
  projectReplicas[index % replicaCount].create(user.id, { name: `项目 ${user.id}` }),
));

await Promise.all(users.flatMap((user, index) => {
  const repository = replicas[index % replicaCount];
  const now = new Date().toISOString();
  return [
    repository.createSession({
      id: `session-${user.id}`, userId: user.id, sessionTokenHash: `hash-${user.id}`,
      source: 'feishu-oauth', expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      createdAt: now, updatedAt: now,
    }),
    repository.createFolder(user.id, {
      id: `folder-${user.id}`, name: `工作区 ${user.id}`, order: 0, createdAt: now, updatedAt: now,
    }),
    repository.putAssetJob(`job-${user.id}`, {
      userId: user.id, createdAt: now, updatedAt: now, mode: 'uv', status: 'SUCCEEDED',
      sourceName: `${user.id}.fbx`, artifacts: [],
    }),
    repository.putAssetTransfer({
      userId: user.id, intentId: `intent-${user.id}`, assetId: `asset-${user.id}`,
      projectId: projects[index].project.id, status: 'verified', createdAt: now, verifiedAt: now,
    }),
    repository.putUserSettings(user.id, { theme: `theme-${index}`, shortcut: `Key${index % 10}` }),
  ];
}));

const oauthPayload = { id: 'oauth-login-cross-replica', state: 'oauth-state-once', startedAt: Date.now() };
await replicas[0].putOAuthLogin(
  oauthPayload.id,
  oauthPayload.state,
  oauthPayload,
  new Date(Date.now() + 600_000).toISOString(),
);
assert.equal((await replicas[replicaCount - 1].consumeOAuthState(oauthPayload.state))?.id, oauthPayload.id);
assert.equal(await replicas[1].consumeOAuthState(oauthPayload.state), undefined, 'OAuth state replay was accepted.');
await replicas[2].putOAuthLogin(oauthPayload.id, oauthPayload.state, { ...oauthPayload, completed: true }, new Date(Date.now() + 600_000).toISOString());
assert.equal((await replicas[3].getOAuthLogin(oauthPayload.id))?.completed, true);
await replicas[4].deleteOAuthLogin(oauthPayload.id);

for (let index = 0; index < users.length; index += 1) {
  const user = users[index];
  const repository = replicas[(index + 3) % replicaCount];
  assert.equal((await repository.verifySession(`hash-${user.id}`))?.id, user.id);
  assert.deepEqual((await repository.listFolders(user.id)).map((folder) => folder.id), [`folder-${user.id}`]);
  assert.equal((await repository.listAssetJobs(user.id, 10))[0]?.record.userId, user.id);
  assert.equal((await repository.getAssetTransferByAsset(user.id, `asset-${user.id}`))?.userId, user.id);
  assert.equal((await repository.getUserSettings(user.id))?.theme, `theme-${index}`);
  assert.deepEqual((await projectReplicas[(index + 5) % replicaCount].list(user.id)).map((project) => project.id), [projects[index].project.id]);
  const other = users[(index + 1) % users.length];
  assert.equal(await repository.getAssetJob(user.id, `job-${other.id}`), undefined, 'Cross-account job access leaked.');
  assert.equal(await repository.getAssetTransferByAsset(user.id, `asset-${other.id}`), undefined, 'Cross-account asset access leaked.');
  assert.equal(
    await projectReplicas[(index + 7) % replicaCount].load(user.id, projects[(index + 1) % users.length].project.id),
    undefined,
    'Cross-account project access leaked.',
  );
}

await sql.close();
engine = new PGlite(databasePath);
await engine.waitReady;
sql = database(engine);
replicas = Array.from({ length: replicaCount }, () => createPostgresControlRepository(sql));
projectReplicas = Array.from({ length: replicaCount }, () => createPostgresProjectRepository(sql));
for (let index = 0; index < users.length; index += 1) {
  const user = users[index];
  const repository = replicas[index % replicaCount];
  assert.equal((await repository.verifySession(`hash-${user.id}`))?.email, user.email);
  assert.equal((await repository.listFolders(user.id))[0]?.name, `工作区 ${user.id}`);
  assert.equal((await repository.listAssetJobs(user.id, 10))[0]?.record.sourceName, `${user.id}.fbx`);
  assert.equal((await repository.getAssetTransferByIntent(user.id, `intent-${user.id}`))?.status, 'verified');
  assert.equal((await repository.getUserSettings(user.id))?.shortcut, `Key${index % 10}`);
  assert.equal((await projectReplicas[index % replicaCount].load(user.id, projects[index].project.id))?.project.name, `项目 ${user.id}`);
}

const counts = await Promise.all(['cloud_users', 'cloud_user_sessions', 'workspace_folders', 'asset_job_history', 'asset_transfers', 'user_settings'].map(
  (table) => sql.query(`SELECT COUNT(*)::int AS count FROM ${table}`),
));
for (const count of counts) assert.equal(count.rows[0].count, accountCount);

await sql.close();
await fs.rm(temporaryRoot, { recursive: true, force: true });
process.stdout.write(
  `共享控制面验收通过：${accountCount} 个账号、${replicaCount} 个应用副本，项目/会话/OAuth一次性状态/文件夹/任务历史/对象元数据/用户设置严格隔离并通过重启恢复；耗时 ${(performance.now() - startedAt).toFixed(0)}ms。\n`,
);
