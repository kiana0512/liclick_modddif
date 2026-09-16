/* global console, process */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { STORAGE_INVENTORY_RULE_VERSION } from '@liclick/contracts';

const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'li3d-storage-management-'));

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

async function waitForCleanup(getJob, userId, jobId) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const job = await getJob(userId, jobId);
    if (job?.status === 'completed' || job?.status === 'failed') return job;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Timed out waiting for local storage cleanup.');
}

async function waitForPurge(getJob, userId, jobId) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const job = await getJob(userId, jobId);
    if (job?.status === 'completed' || job?.status === 'failed') return job;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Timed out waiting for local storage purge.');
}

try {
  process.env.LICLICK_WORKSPACE_DIR = path.join(temporaryRoot, 'workspace');
  process.env.LICLICK_STORAGE_FAST_GROUP_MIN_FILES = '4';
  delete process.env.LICLICK_PROJECT_REPOSITORY;
  delete process.env.LICLICK_CLOUD_DATABASE_URL;

  const {
    getStorageCleanupJob,
    getStorageOverview,
    getStoragePurgeJob,
    getStorageQuarantineStatus,
    startStorageCleanup,
    startStoragePurge,
    startStorageScan,
    storageManagementInternals,
  } = await import('../dist/services/storageManagementService.js');

  assert.deepEqual(
    [...storageManagementInternals.extractCloudAssetIds({
      imageUrl: 'https://cloud.test/api/projects/p/assets/asset-current-12345678/content',
      relativePath: 'objects/asset-other-12345678',
    })],
    ['asset-current-12345678', 'asset-other-12345678'],
  );
  assert.deepEqual([...storageManagementInternals.extractCloudAssetIds(undefined)], []);
  assert.deepEqual(
    [...storageManagementInternals.extractLocalAssetPaths(
      '{"imageUrl":"/workspace/users/u/projects/p/assets/layers/current.png"}',
    )],
    ['assets/layers/current.png'],
  );

  const userId = 'storage-local-user';
  const projectRoot = path.join(
    process.env.LICLICK_WORKSPACE_DIR,
    'users',
    userId,
    'projects',
    'project-one',
  );
  const assetsRoot = path.join(projectRoot, 'assets', 'layers');
  await fs.mkdir(path.join(projectRoot, 'autosaves'), { recursive: true });
  await fs.mkdir(path.join(projectRoot, '.commands'), { recursive: true });
  await fs.mkdir(assetsRoot, { recursive: true });
  await fs.writeFile(
    path.join(projectRoot, 'project-one.json'),
    JSON.stringify({ imageUrl: 'assets/layers/current.png' }),
  );
  await fs.writeFile(
    path.join(projectRoot, 'autosaves', 'revision.json'),
    JSON.stringify({ imageUrl: 'assets/layers/history.png' }),
  );
  await fs.writeFile(
    path.join(projectRoot, '.commands', 'receipt.json'),
    JSON.stringify({ resultUrl: 'assets/layers/command-result.png' }),
  );
  await fs.writeFile(path.join(assetsRoot, 'current.png'), Buffer.alloc(101, 1));
  await fs.writeFile(path.join(assetsRoot, 'history.png'), Buffer.alloc(202, 2));
  await fs.writeFile(path.join(assetsRoot, 'command-result.png'), Buffer.alloc(151, 4));
  await fs.writeFile(path.join(assetsRoot, 'unused.png'), Buffer.alloc(303, 3));
  await fs.writeFile(path.join(assetsRoot, 'late-protected.png'), Buffer.alloc(404, 5));
  const oldAssetTime = new Date(Date.now() - 2 * 60 * 60_000);
  await Promise.all([
    fs.utimes(path.join(assetsRoot, 'unused.png'), oldAssetTime, oldAssetTime),
    fs.utimes(path.join(assetsRoot, 'late-protected.png'), oldAssetTime, oldAssetTime),
  ]);

  const overview = await startStorageScan(userId);
  assert.equal(overview.status, 'ready');
  assert.equal(overview.backend, 'workspace-file');
  assert.equal(overview.reclaimableBytes, 707);
  assert.equal(
    overview.buckets.find((bucket) => bucket.id === 'project-resources')?.bytes,
    101,
  );
  assert.ok((overview.buckets.find((bucket) => bucket.id === 'history')?.bytes ?? 0) >= 353);
  assert.equal((await getStorageOverview(userId)).scanId, overview.scanId);

  await fs.writeFile(
    path.join(projectRoot, 'project-one.json'),
    JSON.stringify({
      imageUrl: 'assets/layers/current.png',
      restoredUrl: 'assets/layers/late-protected.png',
    }),
  );
  await fs.writeFile(path.join(assetsRoot, 'late-new.png'), Buffer.alloc(505, 6));

  const idempotencyKey = `storage-cleanup-${randomUUID()}`;
  const [queued, concurrentReplay] = await Promise.all([
    startStorageCleanup({
      userId,
      scanId: overview.scanId,
      idempotencyKey,
    }),
    startStorageCleanup({
      userId,
      scanId: overview.scanId,
      idempotencyKey: `storage-cleanup-${randomUUID()}`,
    }),
  ]);
  assert.equal(queued?.status, 'queued');
  assert.equal(concurrentReplay?.jobId, queued.jobId);
  const completed = await waitForCleanup(getStorageCleanupJob, userId, queued.jobId);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.processedBytes, 303);
  assert.equal(completed.processedCount, 1);
  assert.equal(completed.skippedCount, 1);
  assert.equal(
    await fs.readFile(path.join(assetsRoot, 'current.png')).then((buffer) => buffer.length),
    101,
  );
  assert.equal(
    await fs.readFile(path.join(assetsRoot, 'history.png')).then((buffer) => buffer.length),
    202,
  );
  assert.equal(
    await fs.readFile(path.join(assetsRoot, 'command-result.png')).then((buffer) => buffer.length),
    151,
  );
  assert.equal(
    await fs.readFile(path.join(assetsRoot, 'late-protected.png')).then((buffer) => buffer.length),
    404,
  );
  assert.equal(
    await fs.readFile(path.join(assetsRoot, 'late-new.png')).then((buffer) => buffer.length),
    505,
  );
  await assert.rejects(fs.stat(path.join(assetsRoot, 'unused.png')), { code: 'ENOENT' });
  assert.equal(
    await fs
      .stat(
        path.join(
          process.env.LICLICK_WORKSPACE_DIR,
          'users',
          userId,
          'storage-quarantine',
          queued.jobId,
          'projects',
          'project-one',
          'assets',
          'layers',
          'unused.png',
        ),
      )
      .then((stat) => stat.size),
    303,
  );
  assert.equal(
    (await startStorageCleanup({ userId, scanId: overview.scanId, idempotencyKey }))?.jobId,
    queued.jobId,
  );

  const fastUserId = 'storage-fast-user';
  const fastProjectRoot = path.join(
    process.env.LICLICK_WORKSPACE_DIR,
    'users',
    fastUserId,
    'projects',
    'fast-project',
  );
  const fastAssetsRoot = path.join(fastProjectRoot, 'assets', 'captures');
  await fs.mkdir(fastAssetsRoot, { recursive: true });
  await fs.writeFile(
    path.join(fastProjectRoot, 'fast-project.json'),
    JSON.stringify({ imageUrl: 'assets/captures/current.png' }),
  );
  await fs.writeFile(path.join(fastAssetsRoot, 'current.png'), Buffer.alloc(10, 1));
  await fs.writeFile(path.join(fastAssetsRoot, 'late-protected.png'), Buffer.alloc(20, 3));
  const fastUnusedNames = [
    'unused-a.png',
    'unused-b.png',
    'unused-c.png',
    'unused-d.png',
    'unused-e.png',
    'unused-f.png',
    'unused-g.png',
    'unused-h.png',
  ];
  for (const name of fastUnusedNames) {
    const assetPath = path.join(fastAssetsRoot, name);
    await fs.writeFile(assetPath, Buffer.alloc(20, 2));
    await fs.utimes(assetPath, oldAssetTime, oldAssetTime);
  }
  await fs.utimes(
    path.join(fastAssetsRoot, 'late-protected.png'),
    oldAssetTime,
    oldAssetTime,
  );
  const fastOverview = await startStorageScan(fastUserId);
  assert.equal(fastOverview.reclaimableBytes, 180);
  await fs.writeFile(
    path.join(fastProjectRoot, 'fast-project.json'),
    JSON.stringify({
      imageUrl: 'assets/captures/current.png',
      restoredUrl: 'assets/captures/late-protected.png',
    }),
  );
  const fastQueued = await startStorageCleanup({
    userId: fastUserId,
    scanId: fastOverview.scanId,
    idempotencyKey: `storage-fast-cleanup-${randomUUID()}`,
  });
  const fastCompleted = await waitForCleanup(
    getStorageCleanupJob,
    fastUserId,
    fastQueued.jobId,
  );
  assert.equal(fastCompleted.status, 'completed');
  assert.equal(fastCompleted.processedCount, 8);
  assert.equal(fastCompleted.processedBytes, 160);
  assert.equal(fastCompleted.skippedCount, 1);
  assert.equal((await fs.stat(path.join(fastAssetsRoot, 'current.png'))).size, 10);
  assert.equal((await fs.stat(path.join(fastAssetsRoot, 'late-protected.png'))).size, 20);
  await assert.rejects(fs.stat(path.join(fastAssetsRoot, 'unused-a.png')), { code: 'ENOENT' });
  assert.equal(
    (
      await fs.stat(
        path.join(
          process.env.LICLICK_WORKSPACE_DIR,
          'users',
          fastUserId,
          'storage-quarantine',
          fastQueued.jobId,
          'projects',
          'fast-project',
          'assets',
          'captures',
          'unused-a.png',
        ),
      )
    ).size,
    20,
  );
  const quarantineBeforePurge = await getStorageQuarantineStatus(fastUserId);
  assert.equal(quarantineBeforePurge.purgeSupported, true);
  assert.equal(quarantineBeforePurge.bytes, 160);
  assert.equal(quarantineBeforePurge.itemCount, 8);
  const purgeStartedAt = Date.now();
  const [purgeQueued, concurrentPurgeReplay] = await Promise.all([
    startStoragePurge({
      userId: fastUserId,
      idempotencyKey: `storage-purge-${randomUUID()}`,
    }),
    startStoragePurge({
      userId: fastUserId,
      idempotencyKey: `storage-purge-${randomUUID()}`,
    }),
  ]);
  assert.ok(purgeQueued);
  assert.equal(concurrentPurgeReplay?.jobId, purgeQueued.jobId);
  assert.ok(Date.now() - purgeStartedAt < 500, 'Purge creation must return without deleting inline.');
  const purgeCompleted = await waitForPurge(
    getStoragePurgeJob,
    fastUserId,
    purgeQueued.jobId,
  );
  assert.equal(purgeCompleted.status, 'completed');
  assert.equal(purgeCompleted.targetBytes, 160);
  assert.equal(purgeCompleted.targetCount, 8);
  assert.equal((await getStorageQuarantineStatus(fastUserId)).bytes, 0);
  await assert.rejects(
    fs.stat(
      path.join(
        process.env.LICLICK_WORKSPACE_DIR,
        'users',
        fastUserId,
        'storage-quarantine',
        fastQueued.jobId,
      ),
    ),
    { code: 'ENOENT' },
  );

  const migrations = await Promise.all([
    fs.readFile(new URL('../sql/001_project_documents_postgres.sql', import.meta.url), 'utf8'),
    fs.readFile(new URL('../sql/002_shared_control_plane.sql', import.meta.url), 'utf8'),
    fs.readFile(new URL('../sql/004_asset_storage_v2_shadow.sql', import.meta.url), 'utf8'),
  ]);
  const engine = new PGlite(path.join(temporaryRoot, 'pgdata'));
  await engine.waitReady;
  for (const migration of migrations) await engine.exec(migration);
  const sql = database(engine);
  const { createPostgresAssetStorageRepository } = await import(
    '../dist/repositories/postgresAssetStorageRepository.js'
  );
  const repository = createPostgresAssetStorageRepository(sql);
  const timeoutCalls = [];
  const jsonBatchParameters = [];
  const timeoutConnection = {
    async query(statement, parameters) {
      if (statement.includes('jsonb_to_recordset') && typeof parameters?.[2] === 'string') {
        jsonBatchParameters.push(parameters[2]);
      }
      return { rows: [], affectedRows: 0 };
    },
  };
  const timeoutRepository = createPostgresAssetStorageRepository({
    ...timeoutConnection,
    async transaction(operation) {
      return operation(timeoutConnection);
    },
    async withStatementTimeout(timeoutMs, operation) {
      timeoutCalls.push(timeoutMs);
      return operation(timeoutConnection);
    },
  });
  await timeoutRepository.listLegacyAssetPage('bounded-user', 'scan-bounded', undefined, 128);
  await timeoutRepository.listStorageDocumentPage('bounded-user', 'current', undefined, 4);
  await timeoutRepository.appendInventoryReferences({
    userId: 'bounded-user',
    scanId: 'scan-bounded',
    references: [{ assetId: 'asset-bounded-12345678', bucketId: 'project-resources' }],
  });
  await timeoutRepository.appendInventoryCandidates({
    userId: 'bounded-user',
    scanId: 'scan-bounded',
    createdAt: new Date().toISOString(),
    candidates: [{
      candidateId: 'candidate-bounded-12345678',
      assetId: 'asset-bounded-12345678',
      projectId: 'project-bounded',
      category: 'layers',
      sizeBytes: 1,
      proof: { reason: 'bounded-driver-json' },
    }],
  });
  assert.deepEqual(timeoutCalls, [45_000, 45_000, 45_000, 45_000]);
  assert.equal(jsonBatchParameters.length, 2);
  assert.deepEqual(jsonBatchParameters.map((value) => JSON.parse(value).length), [1, 1]);
  const now = new Date().toISOString();
  await sql.query(
    `INSERT INTO cloud_users (
       user_id, display_name, role, status, auth_source, created_at, updated_at
     ) VALUES ($1,$2,'user','active','feishu-oauth',$3::timestamptz,$3::timestamptz)`,
    ['storage-cloud-user', 'Storage Cloud User', now],
  );
  await sql.query(
    `INSERT INTO project_documents (
       user_id, project_id, slug, name, document_json, revision_id,
       revision_number, created_at, updated_at, deleted_at
     ) VALUES
       ($1,'project-active','project-active','Active',$2::jsonb,'revision-current',2,$4,$4,NULL),
       ($1,'project-trash','project-trash','Trash',$3::jsonb,'revision-trash-current',2,$4,$4,$4)`,
    [
      'storage-cloud-user',
      { imageUrl: '/api/projects/project-active/assets/asset-current-12345678/content' },
      { imageUrl: '/api/projects/project-trash/assets/asset-trash-12345678/content' },
      now,
    ],
  );
  await sql.query(
    `INSERT INTO project_document_revisions (
       user_id, project_id, revision_id, revision_number, document_json, created_at
     ) VALUES
       ($1,'project-active','revision-history',1,$2::jsonb,$4),
       ($1,'project-trash','revision-trash',1,$3::jsonb,$4)`,
    [
      'storage-cloud-user',
      {
        imageUrl: 'objects/asset-history-12345678',
        retainedCurrentImageUrl: 'objects/asset-current-12345678',
      },
      { imageUrl: 'objects/asset-trash-12345678' },
      now,
    ],
  );
  for (const [index, assetId] of [
    'asset-current-12345678',
    'asset-history-12345678',
    'asset-trash-12345678',
    'asset-unused-12345678',
  ].entries()) {
    await sql.query(
      `INSERT INTO asset_transfers (
         user_id, intent_id, asset_id, project_id, status, record_json, created_at, updated_at
       ) VALUES ($1,$2,$3,'project-active','verified',$4::jsonb,$5,$5)`,
      [
        'storage-cloud-user',
        `intent-${index}`,
        assetId,
        {
          assetId,
          projectId: 'project-active',
          category: 'layers',
          filename: `${assetId}.png`,
          mimeType: 'image/png',
          sizeBytes: 100 + index,
          sha256: String(index + 1).repeat(64),
          objectKey: `objects/${assetId}`,
          createdAt: now,
        },
        now,
      ],
    );
  }
  const pagingScanId = 'scan-paging-12345678';
  await repository.beginInventoryScan('storage-cloud-user', pagingScanId);
  const directReferenceScanId = 'scan-direct-reference-12345678';
  await repository.beginInventoryScan('storage-cloud-user', directReferenceScanId);
  for (const kind of ['current', 'history', 'trash']) {
    let cursor;
    do {
      const page = await repository.appendStorageDocumentReferencePage(
        'storage-cloud-user',
        directReferenceScanId,
        kind,
        cursor,
        1,
      );
      cursor = page.nextCursor;
    } while (cursor);
  }
  const directBuckets = new Map();
  let directAssetCursor;
  do {
    const page = await repository.listLegacyAssetPage(
      'storage-cloud-user',
      directReferenceScanId,
      directAssetCursor,
      2,
    );
    for (const asset of page.assets) directBuckets.set(asset.assetId, asset.referenceBucket);
    directAssetCursor = page.nextCursor;
  } while (directAssetCursor);
  assert.deepEqual(Object.fromEntries(directBuckets), {
    'asset-current-12345678': 'project-resources',
    'asset-history-12345678': 'history',
    'asset-trash-12345678': 'trash',
    'asset-unused-12345678': undefined,
  });
  await repository.discardInventoryScan('storage-cloud-user', directReferenceScanId);
  const referencePages = await Promise.all([
    repository.listStorageDocumentPage('storage-cloud-user', 'current', undefined, 1),
    repository.listStorageDocumentPage('storage-cloud-user', 'history', undefined, 1),
    repository.listStorageDocumentPage('storage-cloud-user', 'trash', undefined, 1),
  ]);
  assert.equal(referencePages[0]?.documents[0]?.assetIds.includes('asset-current-12345678'), true);
  assert.equal(referencePages[1]?.documents[0]?.assetIds.includes('asset-history-12345678'), true);
  assert.equal(referencePages[1]?.documents[0]?.assetIds.includes('asset-current-12345678'), true);
  assert.equal(referencePages[2]?.documents[0]?.assetIds.includes('asset-trash-12345678'), true);
  await repository.appendInventoryReferences({
    userId: 'storage-cloud-user',
    scanId: pagingScanId,
    references: referencePages.flatMap((page) =>
      page.documents.flatMap((document) =>
        document.assetIds.map((assetId) => ({
          assetId,
          bucketId:
            document.kind === 'current' ? 'project-resources' : document.kind,
        })),
      ),
    ),
  });
  const assetBuckets = new Map();
  let assetCursor;
  do {
    const page = await repository.listLegacyAssetPage(
      'storage-cloud-user',
      pagingScanId,
      assetCursor,
      2,
    );
    for (const asset of page.assets) assetBuckets.set(asset.assetId, asset.referenceBucket);
    assetCursor = page.nextCursor;
  } while (assetCursor);
  assert.deepEqual(Object.fromEntries(assetBuckets), {
    'asset-current-12345678': 'project-resources',
    'asset-history-12345678': 'history',
    'asset-trash-12345678': 'trash',
    'asset-unused-12345678': undefined,
  });
  await repository.discardInventoryScan('storage-cloud-user', pagingScanId);
  await sql.query(
    `INSERT INTO cloud_users (
       user_id, display_name, role, status, auth_source, created_at, updated_at
     ) VALUES ($1,$2,'user','active','feishu-oauth',$3::timestamptz,$3::timestamptz)`,
    ['storage-large-document-user', 'Storage Large Document User', now],
  );
  await sql.query(
    `INSERT INTO project_documents (
       user_id, project_id, slug, name, document_json, revision_id,
       revision_number, created_at, updated_at
     ) VALUES ($1,'project-large','project-large','Large',$2::jsonb,'revision-large',1,$3,$3)`,
    [
      'storage-large-document-user',
      {
        imageUrl: 'objects/asset-large-12345678',
        padding: 'x'.repeat(5_600_000),
      },
      now,
    ],
  );
  const largeDocumentPage = await repository.listStorageDocumentPage(
    'storage-large-document-user',
    'current',
    undefined,
    8,
  );
  assert.deepEqual(largeDocumentPage.documents[0]?.assetIds, ['asset-large-12345678']);
  assert.ok(
    JSON.stringify(largeDocumentPage).length < 1_024,
    'Cloud inventory must project asset IDs in PostgreSQL instead of returning full project JSON.',
  );
  const cloudOverview = {
    schemaVersion: 1,
    ruleVersion: STORAGE_INVENTORY_RULE_VERSION,
    backend: 'cloud-object-storage',
    status: 'ready',
    quarantineDays: 7,
    scanId: 'scan-cloud-12345678',
    usedBytes: 4096,
    reclaimableBytes: 4096,
    lastScannedAt: now,
    buckets: [
      { id: 'project-resources', bytes: 0, itemCount: 0, reclaimable: false, protected: true },
      { id: 'history', bytes: 0, itemCount: 0, reclaimable: false, protected: true },
      { id: 'temporary', bytes: 4096, itemCount: 1, reclaimable: true, protected: false },
      { id: 'trash', bytes: 0, itemCount: 0, reclaimable: false, protected: true },
    ],
  };
  await repository.replaceInventory({
    userId: 'storage-cloud-user',
    overview: cloudOverview,
    startedAt: now,
    candidates: [
      {
        candidateId: 'candidate-asset-unused-12345678',
        assetId: 'asset-unused-12345678',
        projectId: 'project-active',
        category: 'layers',
        sizeBytes: 103,
        proof: { reason: 'test-unreferenced' },
      },
    ],
  });
  assert.deepEqual(await repository.getLatestOverview('storage-cloud-user'), cloudOverview);
  const cloudJob = await repository.createQuarantineJob({
    userId: 'storage-cloud-user',
    scanId: cloudOverview.scanId,
    idempotencyKey: 'cloud-cleanup-idempotency-12345678',
    jobId: 'cleanup-cloud-12345678',
    now,
    deleteAfter: new Date(Date.now() + 7 * 86_400_000).toISOString(),
  });
  assert.equal(cloudJob?.status, 'completed');
  assert.equal(cloudJob?.processedBytes, 103);
  assert.equal(
    (
      await repository.createQuarantineJob({
        userId: 'storage-cloud-user',
        scanId: cloudOverview.scanId,
        idempotencyKey: 'cloud-cleanup-idempotency-12345678',
        jobId: 'cleanup-cloud-different',
        now,
        deleteAfter: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      })
    )?.jobId,
    cloudJob?.jobId,
  );
  const quarantineCount = await sql.query(
    `SELECT COUNT(*)::int AS count FROM asset_storage_quarantine
      WHERE user_id='storage-cloud-user'`,
  );
  assert.equal(quarantineCount.rows[0].count, 1);
  await repository.appendInventoryReferences({
    userId: 'storage-cloud-user',
    scanId: cloudOverview.scanId,
    references: [{
      assetId: 'asset-unused-12345678',
      bucketId: 'project-resources',
    }],
  });
  assert.deepEqual(await repository.getCloudQuarantineSummary('storage-cloud-user'), {
    itemCount: 0,
    bytes: 0,
  });
  assert.equal(
    await repository.createPurgeJob({
      userId: 'storage-cloud-user',
      idempotencyKey: 'cloud-purge-protected-12345678',
      jobId: 'purge-cloud-protected-12345678',
      now,
    }),
    undefined,
  );
  await repository.discardInventoryScan('storage-cloud-user', cloudOverview.scanId);
  assert.deepEqual(await repository.getCloudQuarantineSummary('storage-cloud-user'), {
    itemCount: 1,
    bytes: 103,
  });
  const purgeJob = await repository.createPurgeJob({
    userId: 'storage-cloud-user',
    idempotencyKey: 'cloud-purge-idempotency-12345678',
    jobId: 'purge-cloud-12345678',
    now,
  });
  assert.equal(purgeJob?.status, 'queued');
  assert.equal(purgeJob?.targetBytes, 103);
  assert.equal(purgeJob?.targetCount, 1);
  assert.equal(
    (
      await repository.createPurgeJob({
        userId: 'storage-cloud-user',
        idempotencyKey: 'cloud-purge-idempotency-12345678',
        jobId: 'purge-cloud-replayed',
        now,
      })
    )?.jobId,
    purgeJob?.jobId,
  );
  const runningPurge = await repository.markPurgeJobRunning('storage-cloud-user', purgeJob);
  const purgeItems = await repository.listPurgeItemPage(
    'storage-cloud-user',
    runningPurge.jobId,
    undefined,
    64,
  );
  assert.deepEqual(purgeItems.items, [{
    assetId: 'asset-unused-12345678',
    objectKey: 'objects/asset-unused-12345678',
    sizeBytes: 103,
  }]);
  await repository.markPurgeItemDeleted({
    userId: 'storage-cloud-user',
    jobId: runningPurge.jobId,
    assetId: 'asset-unused-12345678',
    now,
  });
  const completedPurge = await repository.finishPurgeJob({
    userId: 'storage-cloud-user',
    job: runningPurge,
  });
  assert.equal(completedPurge.status, 'completed');
  assert.equal(
    (await repository.getPurgeJob('storage-cloud-user', runningPurge.jobId))?.status,
    'completed',
  );
  assert.deepEqual(await repository.getCloudQuarantineSummary('storage-cloud-user'), {
    itemCount: 0,
    bytes: 0,
  });
  await sql.close();

  console.log('storage management tests passed');
} finally {
  await fs.rm(temporaryRoot, { recursive: true, force: true });
}
