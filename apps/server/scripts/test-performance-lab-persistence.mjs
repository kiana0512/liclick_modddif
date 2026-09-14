import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { createServer } from 'node:http';
import { PGlite } from '@electric-sql/pglite';
import { createPostgresControlRepository } from '../dist/repositories/postgresControlRepository.js';

const migrations = await Promise.all([
  fs.readFile(new URL('../sql/001_project_documents_postgres.sql', import.meta.url), 'utf8'),
  fs.readFile(new URL('../sql/002_shared_control_plane.sql', import.meta.url), 'utf8'),
  fs.readFile(new URL('../sql/003_performance_lab_sessions.sql', import.meta.url), 'utf8'),
  fs.readFile(new URL('../sql/004_asset_storage_v2_shadow.sql', import.meta.url), 'utf8'),
]);

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
    close() {
      return engine.close();
    },
  };
}

function sha256(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

const engine = new PGlite();
await engine.waitReady;
for (const migration of migrations) await engine.exec(migration);
const sql = database(engine);
const repository = createPostgresControlRepository(sql);
const users = [
  {
    id: 'feishu-user-a',
    displayName: '飞书用户甲',
    email: 'user-a@example.invalid',
    avatarUrl: 'https://example.invalid/avatar-a.png',
  },
  {
    id: 'feishu-user-b',
    displayName: '飞书用户乙',
    email: 'user-b@example.invalid',
    avatarUrl: 'https://example.invalid/avatar-b.png',
  },
];

for (const user of users) {
  await repository.upsertUser({ ...user, authSource: 'feishu-oauth' });
}

const sessionA1 = `perf_${randomUUID()}`;
const sessionA2 = `perf_${randomUUID()}`;
const sessionB1 = `perf_${randomUUID()}`;
const startedAt = new Date('2026-08-26T08:00:00.000Z').toISOString();
const context = {
  browser: { hardwareConcurrency: 24 },
  webgl: { renderer: 'ANGLE (NVIDIA, Direct3D11)', angleBackend: 'd3d11' },
  unsupportedWithoutNativeComponent: ['DXGI scheduler counters'],
};

for (const [userId, sessionId] of [
  [users[0].id, sessionA1],
  [users[0].id, sessionA2],
  [users[1].id, sessionB1],
]) {
  await repository.createPerformanceLabSession({
    userId,
    sessionId,
    schemaVersion: 2,
    collectorVersion: '2.0.0',
    startedAt,
    clientContext: context,
  });
}

const duplicate = await repository.createPerformanceLabSession({
  userId: users[0].id,
  sessionId: sessionA1,
  schemaVersion: 2,
  collectorVersion: '2.0.0',
  startedAt,
  clientContext: context,
});
assert.equal(duplicate.sessionId, sessionA1, 'Session creation must be idempotent.');

const payload = {
  schemaVersion: 2,
  frames: [
    [0, 16.7],
    [16.7, 42.4],
  ],
  longTasks: [[16.7, 82.1, 'unknown']],
};
const chunkInput = {
  userId: users[0].id,
  sessionId: sessionA1,
  sequence: 0,
  startedAt,
  endedAt: new Date('2026-08-26T08:00:05.000Z').toISOString(),
  sampleCount: 3,
  byteCount: Buffer.byteLength(JSON.stringify(payload)),
  payloadSha256: sha256(payload),
  payload,
};
assert.deepEqual(await repository.appendPerformanceLabChunk(chunkInput), {
  accepted: true,
  idempotent: false,
});
assert.deepEqual(await repository.appendPerformanceLabChunk(chunkInput), {
  accepted: true,
  idempotent: true,
});
await assert.rejects(
  repository.appendPerformanceLabChunk({
    ...chunkInput,
    payload: { frames: [[0, 999]] },
    payloadSha256: sha256({ frames: [[0, 999]] }),
  }),
  /different performance chunk/i,
);
assert.equal(
  await repository.appendPerformanceLabChunk({ ...chunkInput, userId: users[1].id }),
  undefined,
  'A different Feishu user must not append to another user session.',
);

const summary = { averageFps: 41.2, frameP95Ms: 42.4, droppedFrameCount: 1 };
const report = { dataOrigin: 'client-browser', serverGpuMetricsIncluded: false };
const reportSha256 = sha256({ summary, report });
const completed = await repository.completePerformanceLabSession({
  userId: users[0].id,
  sessionId: sessionA1,
  endedAt: new Date('2026-08-26T08:00:10.000Z').toISOString(),
  summary,
  report,
  reportSha256,
});
assert.equal(completed.status, 'completed');
assert.equal(completed.chunkCount, 1);
assert.equal(completed.sampleCount, 3);
assert.deepEqual(
  await repository.completePerformanceLabSession({
    userId: users[0].id,
    sessionId: sessionA1,
    endedAt: new Date('2026-08-26T08:00:10.000Z').toISOString(),
    summary,
    report,
    reportSha256,
  }),
  completed,
  'Completion must be idempotent.',
);

const ownSessions = await repository.listPerformanceLabSessions({
  requesterUserId: users[0].id,
  includeAllUsers: false,
  limit: 100,
});
assert.deepEqual(
  new Set(ownSessions.map((session) => session.sessionId)),
  new Set([sessionA1, sessionA2]),
);
const maintainerSessions = await repository.listPerformanceLabSessions({
  requesterUserId: users[0].id,
  includeAllUsers: true,
  limit: 100,
});
assert.equal(maintainerSessions.length, 3);
assert.equal(
  await repository.getPerformanceLabSession({
    requesterUserId: users[1].id,
    includeAllUsers: false,
    sessionId: sessionA1,
  }),
  undefined,
  'A normal user must not read another user performance log.',
);
const detail = await repository.getPerformanceLabSession({
  requesterUserId: users[0].id,
  includeAllUsers: true,
  sessionId: sessionA1,
});
assert.equal(detail.chunks.length, 1);
assert.equal(detail.chunks[0].payload.webgl, undefined);
assert.equal(detail.clientContext.webgl.angleBackend, 'd3d11');
assert.equal(detail.user.displayName, users[0].displayName);
assert.equal(detail.user.avatarUrl, users[0].avatarUrl);

await sql.query('UPDATE cloud_users SET display_name=$2, avatar_url=$3 WHERE user_id=$1', [
  users[0].id,
  '飞书用户甲（新名称）',
  'https://example.invalid/avatar-a-new.png',
]);
const renamed = await repository.getPerformanceLabSession({
  requesterUserId: users[0].id,
  includeAllUsers: true,
  sessionId: sessionA1,
});
assert.equal(renamed.user.displayName, '飞书用户甲（新名称）');
assert.equal(renamed.user.snapshot.displayName, users[0].displayName);
assert.equal(renamed.user.snapshot.avatarUrl, users[0].avatarUrl);

const { createPerformanceLabRoute } = await import('../dist/routes/performanceLab.js');
const httpUsers = {
  user: {
    id: users[0].id,
    displayName: users[0].displayName,
    email: users[0].email,
    avatarUrl: users[0].avatarUrl,
    role: 'user',
    status: 'active',
    authSource: 'feishu-oauth',
    createdAt: startedAt,
    updatedAt: startedAt,
  },
  maintainer: {
    id: users[1].id,
    displayName: users[1].displayName,
    email: users[1].email,
    avatarUrl: users[1].avatarUrl,
    role: 'maintainer',
    status: 'active',
    authSource: 'feishu-oauth',
    createdAt: startedAt,
    updatedAt: startedAt,
  },
  otherAdmin: {
    id: 'user-other-admin',
    displayName: '非白名单管理员',
    email: 'other-admin@lilith.com',
    role: 'admin',
    status: 'active',
    authSource: 'feishu-oauth',
    createdAt: startedAt,
    updatedAt: startedAt,
  },
};
const { canReadAllPerformanceSessions } = await import('../dist/auth/performanceLabAccess.js');
assert.equal(canReadAllPerformanceSessions(httpUsers.maintainer, [users[1].email]), true);
for (const changes of [{ role: 'user' }, { authSource: 'dev-mock' }, { status: 'disabled' }, { email: users[0].email }]) {
  assert.equal(canReadAllPerformanceSessions({ ...httpUsers.maintainer, ...changes }, [users[1].email]), false);
}
const route = createPerformanceLabRoute({
  repository,
  maintainerEmails: [users[1].email],
  projectLoader: {
    async load(userId, projectId) {
      return userId === users[0].id && projectId === 'project-performance'
        ? { project: { id: projectId } }
        : undefined;
    },
  },
  async authenticate(request) {
    return httpUsers[request.headers['x-test-user'] ?? 'user'];
  },
});
const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', `http://${request.headers.host}`);
  if (!(await route(request, response, url))) {
    response.writeHead(404).end();
  }
});
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const address = server.address();
assert.ok(address && typeof address === 'object');
const baseUrl = `http://127.0.0.1:${address.port}`;
const requestJson = async (path, init = {}) => {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', 'x-test-user': 'user', ...init.headers },
  });
  const body = await response.json();
  return { status: response.status, body };
};
const httpSessionId = `perf_${randomUUID()}`;
const createdOverHttp = await requestJson('/api/performance-lab/sessions', {
  method: 'POST',
  body: JSON.stringify({
    sessionId: httpSessionId,
    projectId: 'project-performance',
    schemaVersion: 2,
    collectorVersion: '2.0.0',
    startedAt,
    clientContext: context,
  }),
});
assert.equal(createdOverHttp.status, 201);
assert.equal(createdOverHttp.body.session.user.displayName, '飞书用户甲（新名称）');
const httpPayload = { frames: [[0, 33.3]], eventTimings: [{ durationMs: 33.3 }] };
const chunkOverHttp = await requestJson(`/api/performance-lab/sessions/${httpSessionId}/chunks`, {
  method: 'POST',
  body: JSON.stringify({
    sequence: 0,
    startedAt,
    endedAt: new Date('2026-08-26T08:00:05.000Z').toISOString(),
    sampleCount: 2,
    payloadSha256: sha256(httpPayload),
    payload: httpPayload,
  }),
});
assert.equal(chunkOverHttp.status, 200);
const httpSummary = { frameCount: 1, frameP95Ms: 33.3 };
const httpReport = { dataOrigin: 'client-browser', serverGpuMetricsIncluded: false };
const completedOverHttp = await requestJson(
  `/api/performance-lab/sessions/${httpSessionId}/complete`,
  {
    method: 'POST',
    body: JSON.stringify({
      endedAt: new Date('2026-08-26T08:00:06.000Z').toISOString(),
      summary: httpSummary,
      report: httpReport,
      reportSha256: sha256({ summary: httpSummary, report: httpReport }),
    }),
  },
);
assert.equal(completedOverHttp.status, 200);
assert.equal(completedOverHttp.body.session.status, 'completed');
const listedOverHttp = await requestJson('/api/performance-lab/sessions?limit=100', {
  headers: { 'x-test-user': 'maintainer' },
});
assert.equal(listedOverHttp.status, 200);
assert.ok(listedOverHttp.body.sessions.some((session) => session.sessionId === httpSessionId));
const detailOverHttp = await requestJson(`/api/performance-lab/sessions/${httpSessionId}`, {
  headers: { 'x-test-user': 'maintainer' },
});
assert.equal(detailOverHttp.status, 200);
assert.equal(detailOverHttp.body.session.chunks[0].payload.frames[0][1], 33.3);
const forbiddenAdminList = await requestJson('/api/performance-lab/admin/sessions?limit=200');
assert.equal(forbiddenAdminList.status, 403);
assert.match(forbiddenAdminList.body.error, /administrator access/i);
const forbiddenAdminDetail = await requestJson(
  `/api/performance-lab/admin/sessions/${httpSessionId}`,
);
assert.equal(forbiddenAdminDetail.status, 403);
const forbiddenOtherAdmin = await requestJson('/api/performance-lab/admin/sessions?limit=200', {
  headers: { 'x-test-user': 'otherAdmin' },
});
assert.equal(forbiddenOtherAdmin.status, 403);
const adminList = await requestJson('/api/performance-lab/admin/sessions?limit=200', {
  headers: { 'x-test-user': 'maintainer' },
});
assert.equal(adminList.status, 200);
assert.ok(adminList.body.sessions.some((session) => session.sessionId === httpSessionId));
const adminDetail = await requestJson(`/api/performance-lab/admin/sessions/${httpSessionId}`, {
  headers: { 'x-test-user': 'maintainer' },
});
assert.equal(adminDetail.status, 200);
assert.equal(adminDetail.body.session.user.displayName, '飞书用户甲（新名称）');
assert.equal(adminDetail.body.session.chunks[0].payload.frames[0][1], 33.3);
assert.equal(adminDetail.body.session.analysis.version, '1.0.3');
const { analyzePerformanceSession } = await import('../dist/services/performanceLabAnalysis.js');
const analysis = analyzePerformanceSession([{ payload: {
  frames: [[100, 80], [120, 16], [NaN, 100]],
  longTasks: [[30, 60, 'script'], [101, 90, 'unrelated']],
  timelineEvents: [{ elapsedMs: 90, durationMs: 40, category: 'projection', name: 'apply', phase: 'end' }],
} }]);
assert.equal(analysis.采样帧数, 2);
assert.equal(analysis.慢帧定位.length, 1);
assert.equal(analysis.慢帧定位[0].开始秒, 0.02);
assert.deepEqual(analysis.慢帧定位[0].同时段任务.map(v => v.名称), ['script', 'apply']);
assert.match(analysis.说明, /不是因果证明/);
assert.deepEqual(analyzePerformanceSession([]).慢帧定位, []);
assert.equal(analyzePerformanceSession([{ payload: { frames: Array.from({length:100},(_,i)=>[i*100,40+i]) } }]).慢帧定位.length,12);
// Traverse beyond the 200-row page, including identical timestamps and new inserts.
for (let index = 0; index < 205; index++) {
  await repository.createPerformanceLabSession({
    userId: users[index % 2].id, sessionId: `perf_${randomUUID()}`,
    schemaVersion: 2, collectorVersion: '2.0.0', startedAt, clientContext: context,
  });
}
const firstPage = await requestJson('/api/performance-lab/admin/sessions?limit=200', {
  headers: { 'x-test-user': 'maintainer' },
});
assert.equal(firstPage.body.sessions.length, 200);
assert.ok(firstPage.body.nextCursor);
const insertedId = `perf_${randomUUID()}`;
await repository.createPerformanceLabSession({
  userId: users[0].id, sessionId: insertedId, schemaVersion: 2,
  collectorVersion: '2.0.0', startedAt: new Date().toISOString(), clientContext: context,
});
const secondPage = await requestJson(`/api/performance-lab/admin/sessions?limit=200&before=${firstPage.body.nextCursor}`, {
  headers: { 'x-test-user': 'maintainer' },
});
assert.equal(secondPage.status, 200);
assert.equal(secondPage.body.nextCursor, undefined);
const pageIds = [...firstPage.body.sessions, ...secondPage.body.sessions].map(s => s.sessionId);
assert.equal(pageIds.length, 209);
assert.equal(new Set(pageIds).size, 209);
assert.ok(!pageIds.includes(insertedId));
assert.equal((await requestJson(`/api/performance-lab/admin/sessions?before=${firstPage.body.nextCursor}`)).status, 403);
await new Promise((resolve, reject) =>
  server.close((error) => (error ? reject(error) : resolve())),
);

await sql.close();
process.stdout.write(
  'Performance Lab persistence passed: full HTTP start/chunk/complete/read flow, strict maintainer-only admin endpoints, multi-session Feishu grouping, ownership, idempotency, identity snapshots, and client-only GPU semantics.\n',
);
