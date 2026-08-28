import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'liclick-remote-bake-'));
const ownerUserId = 'bake-owner-user';
const otherUserId = 'different-user';
const png = Buffer.alloc(24);
Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
png.writeUInt32BE(1024, 16);
png.writeUInt32BE(1024, 20);
const validRoughnessPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);
let submittedBody = Buffer.alloc(0);
let roughnessBody = Buffer.alloc(0);
let statusPollCount = 0;
const artifactFiles = [
  'asset_base_color.png',
  'asset_roughness.png',
  'asset_metallic.png',
  'asset_ao.png',
  'asset_normal_dx.png',
  'asset_normal_gl.png',
  'asset_world_normal.png',
  'asset_curvature.png',
  'asset_thickness.png',
  'asset_position.png',
  'baker_result.json',
  'baker.log',
];
const artifactBodies = new Map(
  artifactFiles.map((fileName) => [
    fileName,
    fileName.endsWith('.png')
      ? png
      : Buffer.from(fileName.endsWith('.json') ? '{"ok":true}' : 'bake complete'),
  ]),
);

const mock = http.createServer(async (request, response) => {
  const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
  if (request.method === 'POST' && requestUrl.pathname === '/api/v1/services/modelview-roughness') {
    const chunks = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    roughnessBody = Buffer.concat(chunks);
    response.writeHead(200, {
      'content-type': 'image/png',
      'content-length': String(validRoughnessPng.length),
      'x-job-id': 'roughness-smoke-job',
    });
    response.end(validRoughnessPng);
    return;
  }
  if (request.method === 'POST' && requestUrl.pathname === '/api/v1/assets/bake/process') {
    const chunks = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    submittedBody = Buffer.concat(chunks);
    statusPollCount = 0;
    response.writeHead(202, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        job_id: 'remote-smoke-job',
        status: 'CLAIMED',
        progress: 1,
        stage: 'claimed',
        stage_message: 'Worker claimed the job',
        status_url: '/api/v1/assets/jobs/remote-smoke-job',
        events_url: '/api/v1/assets/jobs/remote-smoke-job/events',
        cancel_url: '/api/v1/assets/jobs/remote-smoke-job/cancel',
        timing: { queue_position: 2, estimated_start_seconds: 15 },
      }),
    );
    return;
  }
  if (
    request.method === 'POST' &&
    requestUrl.pathname === '/api/v1/assets/jobs/remote-smoke-job/cancel'
  ) {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        job_id: 'remote-smoke-job',
        status: 'CANCELLED',
        progress: 1,
        stage: 'cancelled',
        stage_message: 'Job cancelled',
      }),
    );
    return;
  }
  if (requestUrl.pathname === '/api/v1/assets/jobs/remote-smoke-job') {
    statusPollCount += 1;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      statusPollCount === 1
        ? JSON.stringify({
            job_id: 'remote-smoke-job',
            status: 'VALIDATING',
            progress: 5,
            stage: 'validating',
            stage_message: 'Validating inputs',
            worker_id: 'asset-worker-3090-b-windows',
          })
        : JSON.stringify({
            job_id: 'remote-smoke-job',
            status: 'SUCCEEDED',
            progress: 100,
            stage: 'published',
            stage_message: 'Artifacts published',
            worker_id: 'asset-worker-3090-b-windows',
            delivery_ready: true,
            artifacts: artifactFiles.map((filename, index) => {
              const body = artifactBodies.get(filename);
              return {
                id: `artifact-${index}`,
                kind: path.extname(filename).slice(1),
                filename,
                content_type: filename.endsWith('.png')
                  ? 'image/png'
                  : filename.endsWith('.json')
                    ? 'application/json'
                    : 'text/plain',
                size_bytes: body.length,
                sha256: createHash('sha256').update(body).digest('hex'),
                download_url: `/api/v1/assets/jobs/remote-smoke-job/artifacts/${encodeURIComponent(filename)}`,
              };
            }),
          }),
    );
    return;
  }
  if (requestUrl.pathname.includes('/artifacts/')) {
    const filename = decodeURIComponent(requestUrl.pathname.split('/').at(-1));
    const body = artifactBodies.get(filename);
    assert(body);
    response.writeHead(200, {
      'content-type': filename.endsWith('.png') ? 'image/png' : 'application/octet-stream',
      'content-length': String(body.length),
    });
    response.end(body);
    return;
  }
  response.writeHead(404, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ code: 'ASSET_JOB_NOT_FOUND' }));
});

await new Promise((resolve) => mock.listen(0, '127.0.0.1', resolve));
const address = mock.address();
assert(address && typeof address === 'object');
process.env.LICLICK_SUBSTANCE_BAKER_BASE_URL = `http://127.0.0.1:${address.port}`;
process.env.LICLICK_WORKSPACE_DIR = workspace;

async function waitForJob(service, jobId, userId, predicate, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  let latest;
  while (Date.now() < deadline) {
    latest = service.getNormalBakeJob(jobId, userId);
    if (latest && predicate(latest)) return latest;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for bake job ${jobId}; latest status: ${latest?.status}`);
}

try {
  const service = await import('../apps/server/dist/services/substanceBakeService.js');
  const status = await service.getSubstanceBakerStatus();
  assert.equal(status.available, true);

  const roughness = await service.generateRemoteRoughness({
    fileName: 'jacket_base_color.png',
    data: validRoughnessPng,
  });
  assert.equal(roughness.jobId, 'roughness-smoke-job');
  assert.equal(roughness.contentType, 'image/png');
  assert.deepEqual(roughness.data, validRoughnessPng);
  assert.match(roughnessBody.toString('latin1'), /name="image"/);

  const created = await service.createNormalBakeJob({
    userId: ownerUserId,
    projectId: 'smoke-project',
    objectId: 'smoke-object',
    high: { fileName: '中文模型.FBX', data: Buffer.alloc(32, 1) },
    low: { fileName: '中文模型.FBX', data: Buffer.alloc(32, 2) },
    color: { fileName: '中文贴图.PNG', data: png },
    roughness: { fileName: '中文贴图.PNG', data: png },
    metallic: { fileName: '中文贴图.PNG', data: png },
    settings: {
      resolution: 1024,
      padding: 16,
      sampling: '2x2',
      normalOrientation: 'opengl',
      device: 'gpu',
      udim: 1001,
      frontalDistance: 0.1,
      rearDistance: 0.1,
      matchMode: 'always',
      projectionMode: 'distance',
      hitStrategy: 'inward',
      ignoreBackfaces: false,
      channels: [
        'baseColor',
        'normal',
        'roughness',
        'metallic',
        'ambientOcclusion',
        'curvature',
        'worldNormal',
        'thickness',
        'position',
      ],
    },
  });
  assert.equal(created.remote?.profile, 'li3d-pbr-full-v2');
  assert.equal(created.remote?.status, 'CLAIMED');
  assert.equal(created.status, 'running');
  assert.equal(created.stage, 'baking-maps');
  assert(created.startedAt);
  assert.equal(created.finishedAt, undefined);
  assert.deepEqual(created.displayInput, {
    high: '中文模型.FBX',
    low: '中文模型.FBX',
    color: '中文贴图.PNG',
    roughness: '中文贴图.PNG',
    metallic: '中文贴图.PNG',
  });
  const safeInputNames = Object.values(created.input);
  assert.equal(new Set(safeInputNames.map((name) => name.toLowerCase())).size, safeInputNames.length);
  for (const fileName of safeInputNames) {
    assert.match(fileName, /^[a-z0-9._-]+$/);
  }
  assert.match(created.input.high, /\.fbx$/);
  assert.match(created.input.low, /\.fbx$/);
  assert.match(created.input.color, /\.png$/);
  assert.match(created.input.roughness, /\.png$/);
  assert.match(created.input.metallic, /\.png$/);

  const persistedCreated = JSON.parse(
    fs.readFileSync(path.join(workspace, 'bake-jobs', created.id, 'job.json'), 'utf8'),
  );
  assert.deepEqual(persistedCreated.displayInput, created.displayInput);
  assert.deepEqual(persistedCreated.input, created.input);

  const validating = await waitForJob(
    service,
    created.id,
    ownerUserId,
    (job) => job.remote?.status === 'VALIDATING',
  );
  assert.equal(validating.status, 'running');
  assert.notEqual(validating.status, 'cancelled');
  assert.equal(validating.finishedAt, undefined);

  const completed = await waitForJob(
    service,
    created.id,
    ownerUserId,
    (job) => job.status === 'succeeded',
  );
  assert.equal(completed.status, 'succeeded');
  for (const channel of completed.settings.channels) assert(completed.outputs?.[channel]);
  assert.equal(completed.ownerUserId, ownerUserId);
  assert.equal(service.getNormalBakeJob(created.id, otherUserId), undefined);
  assert.equal(service.getNormalBakeOutputPath(created.id, otherUserId, 'normal'), undefined);
  assert(service.getNormalBakeOutputPath(created.id, ownerUserId, 'normal'));
  assert.equal(await service.cancelNormalBakeJob(created.id, otherUserId), undefined);
  assert(await service.cancelNormalBakeJob(created.id, ownerUserId));

  const archiveService = await import('../apps/server/dist/services/bakeArchiveService.js');
  assert(archiveService.getBakeArchive(created.id, ownerUserId, 'owner-export'));
  assert.equal(
    archiveService.getBakeArchive(created.id, otherUserId, 'forbidden-export'),
    undefined,
  );

  const legacyId = 'bake_legacy_without_owner';
  const legacyDirectory = path.join(workspace, 'bake-jobs', legacyId);
  fs.mkdirSync(legacyDirectory, { recursive: true });
  const legacyJob = { ...completed, id: legacyId };
  delete legacyJob.ownerUserId;
  fs.writeFileSync(path.join(legacyDirectory, 'job.json'), JSON.stringify(legacyJob));
  assert.equal(
    service.getNormalBakeJob(legacyId, ownerUserId),
    undefined,
    'Legacy bake jobs without an owner must default to deny.',
  );

  const multipart = submittedBody.toString('latin1');
  assert.match(multipart, /name="low_mesh"/);
  assert.match(multipart, /name="high_mesh"/);
  assert.match(multipart, /name="base_color_texture"/);
  assert.match(multipart, /name="roughness_texture"/);
  assert.match(multipart, /name="metallic_texture"/);
  assert.match(multipart, /"profile":"li3d-pbr-full-v2"/);
  assert.match(multipart, /"texture_cache_mb":32768/);
  const submittedFilenames = Array.from(
    multipart.matchAll(/filename="([^"]+)"/g),
    (match) => match[1],
  );
  assert.deepEqual(submittedFilenames, [
    created.input.low,
    created.input.high,
    created.input.color,
    created.input.roughness,
    created.input.metallic,
  ]);
  assert.equal(
    submittedFilenames.every((fileName) => /^[a-z0-9._-]+$/.test(fileName)),
    true,
  );

  const baseColorOnly = await service.createNormalBakeJob({
    userId: ownerUserId,
    projectId: 'smoke-project',
    objectId: 'base-color-only',
    high: { fileName: 'chair_high.fbx', data: Buffer.alloc(32, 1) },
    low: { fileName: 'chair_low.fbx', data: Buffer.alloc(32, 2) },
    color: { fileName: 'chair_base_color.png', data: png },
    settings: {
      resolution: 1024,
      padding: 16,
      sampling: '2x2',
      normalOrientation: 'directx',
      device: 'gpu',
      udim: 1001,
      frontalDistance: 0.1,
      rearDistance: 0.1,
      matchMode: 'always',
      projectionMode: 'distance',
      hitStrategy: 'inward',
      ignoreBackfaces: false,
      channels: ['baseColor'],
    },
  });
  assert.equal(baseColorOnly.remote?.profile, 'li3d-pbr-full-v2');
  assert.equal(baseColorOnly.input.high, 'chair_high.fbx');
  assert.equal(baseColorOnly.input.low, 'chair_low.fbx');
  assert.equal(baseColorOnly.displayInput?.high, 'chair_high.fbx');
  assert.equal(baseColorOnly.displayInput?.low, 'chair_low.fbx');
  assert.equal(baseColorOnly.input.roughness, 'liclick_neutral_roughness.png');
  assert.equal(baseColorOnly.input.metallic, 'liclick_neutral_metallic.png');
  const baseColorMultipart = submittedBody.toString('latin1');
  assert.match(baseColorMultipart, /filename="liclick_neutral_roughness.png"/);
  assert.match(baseColorMultipart, /filename="liclick_neutral_metallic.png"/);

  const baseColorCompleted = await waitForJob(
    service,
    baseColorOnly.id,
    ownerUserId,
    (job) => job.status === 'succeeded',
  );
  assert.equal(baseColorCompleted.status, 'succeeded');
  assert(baseColorCompleted.outputs?.baseColor);
  assert.equal(baseColorCompleted.outputs?.roughness, undefined);

  const cancelledCandidate = await service.createNormalBakeJob({
    userId: ownerUserId,
    projectId: 'smoke-project',
    objectId: 'cancelled-object',
    high: { fileName: 'chair_high.fbx', data: Buffer.alloc(32, 1) },
    low: { fileName: 'chair_low.fbx', data: Buffer.alloc(32, 2) },
    settings: {
      resolution: 1024,
      padding: 16,
      sampling: '2x2',
      normalOrientation: 'directx',
      device: 'gpu',
      udim: 1001,
      frontalDistance: 0.1,
      rearDistance: 0.1,
      matchMode: 'always',
      projectionMode: 'distance',
      hitStrategy: 'inward',
      ignoreBackfaces: false,
      channels: ['ambientOcclusion'],
    },
  });
  await waitForJob(
    service,
    cancelledCandidate.id,
    ownerUserId,
    (job) => job.remote?.status === 'VALIDATING',
  );
  const cancelled = await service.cancelNormalBakeJob(cancelledCandidate.id, ownerUserId);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.stage, 'finished');
  assert(cancelled.finishedAt);
  console.log('Remote Substance bake smoke test passed.');
} finally {
  await new Promise((resolve) => mock.close(resolve));
  fs.rmSync(workspace, { recursive: true, force: true });
}
