import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { PGlite } from '@electric-sql/pglite';
import { createPostgresProjectRepository } from '../dist/repositories/postgresProjectRepository.js';

process.env.LICLICK_RUNTIME_MODE = 'cloud';

const rounds = Number.parseInt(process.env.LICLICK_POSTGRES_SOAK_ROUNDS ?? '15', 10);
const replicaCount = Number.parseInt(process.env.LICLICK_POSTGRES_SOAK_REPLICAS ?? '4', 10);
assert.ok(Number.isSafeInteger(rounds) && rounds >= 5 && rounds <= 200);
assert.ok(Number.isSafeInteger(replicaCount) && replicaCount >= 2 && replicaCount <= 16);

const migration = await fs.readFile(
  new URL('../sql/001_project_documents_postgres.sql', import.meta.url),
  'utf8',
);
const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'li3d-postgres-soak-'));
const databasePath = path.join(temporaryRoot, 'pgdata');

function connection(client, fault) {
  return {
    async query(text, params = []) {
      if (
        fault?.failNextRevisionInsert &&
        /^\s*INSERT INTO project_document_revisions/i.test(text)
      ) {
        fault.failNextRevisionInsert = false;
        throw new Error('Injected revision persistence failure.');
      }
      const result = await client.query(text, params);
      return { rows: result.rows, affectedRows: result.affectedRows ?? 0 };
    },
  };
}

function database(engine, fault) {
  return {
    ...connection(engine, fault),
    transaction(operation) {
      return engine.transaction((transaction) => operation(connection(transaction, fault)));
    },
    close() {
      return engine.close();
    },
  };
}

function commandOptions(project, round) {
  const payload = `${project.id}:${round}`;
  return {
    commandId: `command-soak-${project.id.slice(-8)}-${String(round).padStart(4, '0')}`,
    commandSha256: createHash('sha256').update(payload).digest('hex'),
    expectedRevisionId: project.revision.id,
    revisionSource: 'explicit',
  };
}

const startedAt = performance.now();
let engine = new PGlite(databasePath);
await engine.waitReady;
await engine.exec(migration);
const fault = { failNextRevisionInsert: false };
let sqlDatabase = database(engine, fault);
let replicas = Array.from({ length: replicaCount }, () =>
  createPostgresProjectRepository(sqlDatabase),
);

const users = ['soak-user-a', 'soak-user-b', 'soak-user-c', 'soak-user-d'];
const projects = await Promise.all(
  users.map((userId, index) =>
    replicas[index % replicas.length].create(userId, { name: `长稳项目 ${index + 1}` }),
  ),
);

for (let round = 1; round <= rounds; round += 1) {
  await Promise.all(
    projects.map(async ({ project: initialProject }, projectIndex) => {
      const userId = users[projectIndex];
      const authoritative = await replicas[projectIndex % replicas.length].load(
        userId,
        initialProject.id,
      );
      const options = commandOptions(authoritative.project, round);
      const document = {
        ...authoritative.project,
        name: `长稳项目 ${projectIndex + 1} · 第 ${round} 轮`,
        objects: [
          {
            id: `object-${projectIndex}`,
            name: '长稳模型',
            sourcePath: `/workspace/users/${userId}/model.glb`,
          },
        ],
        layers: [
          {
            id: `layer-${projectIndex}`,
            objectId: `object-${projectIndex}`,
            type: 'paint',
            visible: true,
          },
        ],
      };
      const results = await Promise.all(
        replicas.map((repository) =>
          repository.save(userId, initialProject.id, document, options),
        ),
      );
      const revisionIds = new Set(results.map((result) => result.project.revision.id));
      assert.equal(revisionIds.size, 1, 'Idempotent retries must resolve to one revision.');
      assert.equal(results[0].project.revision.number, round + 1);
      assert.equal(results[0].project.objects.length, 1);
      assert.equal(results[0].project.layers.length, 1);
    }),
  );
}

const faultTarget = await replicas[0].load(users[0], projects[0].project.id);
fault.failNextRevisionInsert = true;
await assert.rejects(
  replicas[1].save(
    users[0],
    projects[0].project.id,
    { ...faultTarget.project, name: '不应提交的故障写入' },
    {
      expectedRevisionId: faultTarget.project.revision.id,
      revisionSource: 'explicit',
    },
  ),
  /Injected revision persistence failure/,
);
const afterFault = await replicas[2].load(users[0], projects[0].project.id);
assert.equal(afterFault.project.revision.id, faultTarget.project.revision.id);
assert.equal(afterFault.project.name, faultTarget.project.name);

for (let ownerIndex = 0; ownerIndex < projects.length; ownerIndex += 1) {
  for (let otherIndex = 0; otherIndex < users.length; otherIndex += 1) {
    if (ownerIndex === otherIndex) continue;
    assert.equal(
      await replicas[otherIndex % replicas.length].load(
        users[otherIndex],
        projects[ownerIndex].project.id,
      ),
      undefined,
    );
  }
}

await sqlDatabase.close();
engine = new PGlite(databasePath);
await engine.waitReady;
sqlDatabase = database(engine);
replicas = Array.from({ length: replicaCount }, () =>
  createPostgresProjectRepository(sqlDatabase),
);
for (let index = 0; index < projects.length; index += 1) {
  const restored = await replicas[index % replicas.length].load(
    users[index],
    projects[index].project.id,
  );
  assert.equal(restored.project.revision.number, rounds + 1);
  assert.equal(restored.project.objects.length, 1);
  assert.equal(restored.project.layers.length, 1);
}

const receiptCount = await sqlDatabase.query(
  'SELECT COUNT(*)::int AS count FROM project_command_receipts',
);
const revisionCount = await sqlDatabase.query(
  'SELECT COUNT(*)::int AS count FROM project_document_revisions',
);
assert.equal(receiptCount.rows[0].count, users.length * rounds);
assert.equal(revisionCount.rows[0].count, users.length * (rounds + 1));

await sqlDatabase.close();
const resolvedTemporaryRoot = path.resolve(temporaryRoot);
assert.ok(resolvedTemporaryRoot.startsWith(path.resolve(os.tmpdir())));
await fs.rm(resolvedTemporaryRoot, { recursive: true, force: true });

const durationMs = performance.now() - startedAt;
process.stdout.write(
  `PostgreSQL soak passed: ${replicaCount} replicas, ${users.length} accounts, ${rounds} rounds, ${users.length * rounds * replicaCount} retry requests, rollback injection and restart recovery in ${durationMs.toFixed(0)}ms.\n`,
);
