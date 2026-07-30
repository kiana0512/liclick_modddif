import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'liclick-remote-bake-'));
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
  if (
    request.method === 'POST' &&
    requestUrl.pathname === '/api/v1/services/modelview-roughness'
  ) {
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
    response.writeHead(202, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        job_id: 'remote-smoke-job',
        status: 'QUEUED',
        progress: 0,
        status_url: '/api/v1/assets/jobs/remote-smoke-job',
        events_url: '/api/v1/assets/jobs/remote-smoke-job/events',
        cancel_url: '/api/v1/assets/jobs/remote-smoke-job/cancel',
        timing: { queue_position: 2, estimated_start_seconds: 15 },
      }),
    );
    return;
  }
  if (requestUrl.pathname === '/api/v1/assets/jobs/remote-smoke-job') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
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
    projectId: 'smoke-project',
    objectId: 'smoke-object',
    high: { fileName: 'chair_high.fbx', data: Buffer.alloc(32, 1) },
    low: { fileName: 'chair_low.fbx', data: Buffer.alloc(32, 2) },
    color: { fileName: 'chair_base_color.png', data: png },
    roughness: { fileName: 'chair_roughness.png', data: png },
    metallic: { fileName: 'chair_metallic.png', data: png },
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

  let completed = created;
  for (let attempt = 0; attempt < 100 && completed.status !== 'succeeded'; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    completed = service.getNormalBakeJob(created.id);
  }
  assert.equal(completed.status, 'succeeded');
  for (const channel of completed.settings.channels) assert(completed.outputs?.[channel]);

  const multipart = submittedBody.toString('latin1');
  assert.match(multipart, /name="low_mesh"/);
  assert.match(multipart, /name="high_mesh"/);
  assert.match(multipart, /name="base_color_texture"/);
  assert.match(multipart, /name="roughness_texture"/);
  assert.match(multipart, /name="metallic_texture"/);
  assert.match(multipart, /"profile":"li3d-pbr-full-v2"/);
  assert.match(multipart, /"texture_cache_mb":32768/);

  const baseColorOnly = await service.createNormalBakeJob({
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
  assert.equal(baseColorOnly.input.roughness, 'liclick_neutral_roughness.png');
  assert.equal(baseColorOnly.input.metallic, 'liclick_neutral_metallic.png');
  const baseColorMultipart = submittedBody.toString('latin1');
  assert.match(baseColorMultipart, /filename="liclick_neutral_roughness.png"/);
  assert.match(baseColorMultipart, /filename="liclick_neutral_metallic.png"/);

  let baseColorCompleted = baseColorOnly;
  for (
    let attempt = 0;
    attempt < 100 && baseColorCompleted.status !== 'succeeded';
    attempt += 1
  ) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    baseColorCompleted = service.getNormalBakeJob(baseColorOnly.id);
  }
  assert.equal(baseColorCompleted.status, 'succeeded');
  assert(baseColorCompleted.outputs?.baseColor);
  assert.equal(baseColorCompleted.outputs?.roughness, undefined);
  console.log('Remote Substance bake smoke test passed.');
} finally {
  await new Promise((resolve) => mock.close(resolve));
  fs.rmSync(workspace, { recursive: true, force: true });
}
