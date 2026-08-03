import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'liclick-comfy-cancel-'));
const workflowPath = path.join(workspace, 'workflow.json');
const requiredFiles = [
  'render/01_white_render.png',
  'masks/01_object_mask.png',
  'controlnet_ready/control_depth.png',
  'material/02_material_reference_cropped.png',
  'geometry/08_normal_view.png',
];
const requiredNodeIds = [23, 25, 26, 28, 30];
fs.writeFileSync(
  workflowPath,
  JSON.stringify({
    nodes: requiredNodeIds.map((id) => ({
      id,
      type: 'LoadImage',
      widgets_values: ['placeholder.png', 'image'],
    })),
    links: [],
  }),
);

let interruptCount = 0;
let promptQueued;
let releaseHistory;
const promptQueuedPromise = new Promise((resolve) => {
  promptQueued = resolve;
});
const historyGate = new Promise((resolve) => {
  releaseHistory = resolve;
});

function sendJson(response, status, payload) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(payload));
}

const mock = http.createServer(async (request, response) => {
  const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
  if (request.method === 'GET' && requestUrl.pathname === '/system_stats') {
    sendJson(response, 200, { system: {} });
    return;
  }
  if (request.method === 'GET' && requestUrl.pathname === '/object_info') {
    sendJson(response, 200, {
      LoadImage: { input: { required: { image: ['STRING', {}] } } },
    });
    return;
  }
  if (request.method === 'POST' && requestUrl.pathname === '/upload/image') {
    request.resume();
    sendJson(response, 200, { name: 'input.png', subfolder: 'smoke' });
    return;
  }
  if (request.method === 'POST' && requestUrl.pathname === '/prompt') {
    request.resume();
    sendJson(response, 200, { prompt_id: 'prompt-smoke' });
    promptQueued();
    return;
  }
  if (request.method === 'GET' && requestUrl.pathname === '/history/prompt-smoke') {
    await historyGate;
    sendJson(response, 200, {
      'prompt-smoke': {
        outputs: {
          23: { images: [{ filename: 'cancelled.png', subfolder: '', type: 'output' }] },
        },
      },
    });
    return;
  }
  if (request.method === 'POST' && requestUrl.pathname === '/interrupt') {
    request.resume();
    interruptCount += 1;
    releaseHistory();
    sendJson(response, 200, { ok: true });
    return;
  }
  sendJson(response, 404, { error: 'not found' });
});

await new Promise((resolve) => mock.listen(0, '127.0.0.1', resolve));
const address = mock.address();
assert(address && typeof address === 'object');
process.env.COMFYUI_BASE_URL = `http://127.0.0.1:${address.port}`;
process.env.COMFYUI_TEXTURE_WORKFLOW_PATH = workflowPath;
process.env.LICLICK_WORKSPACE_DIR = workspace;

try {
  const service = await import('../apps/server/dist/services/comfyuiGenerationService.js');
  const ownerUserId = 'comfy-owner';
  const otherUserId = 'different-user';

  await assert.rejects(
    service.cancelComfyTextureMap('   ', ownerUserId),
    (error) => service.comfyCancelErrorStatus(error) === 400,
  );
  await assert.rejects(
    service.cancelComfyTextureMap('missing-job', ownerUserId),
    (error) => service.comfyCancelErrorStatus(error) === 404,
  );
  assert.equal(interruptCount, 0, 'Invalid cancellation must never call global /interrupt.');

  const input = {
    clientGenerationId: 'owner-job',
    projectId: 'smoke-project',
    prompt: 'smoke material',
    files: requiredFiles.map((filePath) => ({
      path: filePath,
      dataUrl:
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    })),
  };
  const generation = service.generateComfyTextureMap(input, ownerUserId).then(
    () => undefined,
    (error) => error,
  );
  await promptQueuedPromise;

  await assert.rejects(
    service.generateComfyTextureMap(input, otherUserId),
    /already active/,
    'A duplicate id must not overwrite an active job owner.',
  );
  await assert.rejects(
    service.cancelComfyTextureMap('owner-job', otherUserId),
    (error) => service.comfyCancelErrorStatus(error) === 404,
  );
  assert.equal(interruptCount, 0, 'A different user must not interrupt the owner job.');

  const cancelled = await service.cancelComfyTextureMap('owner-job', ownerUserId);
  assert.deepEqual(cancelled, { ok: true, cancelledJobId: 'owner-job' });
  assert.equal(interruptCount, 1);
  const generationError = await generation;
  assert(generationError instanceof Error);
  assert.match(generationError.message, /cancel|取消/i);
  console.log('ComfyUI cancellation ownership smoke passed.');
} finally {
  releaseHistory();
  await new Promise((resolve) => mock.close(resolve));
  fs.rmSync(workspace, { recursive: true, force: true });
}
