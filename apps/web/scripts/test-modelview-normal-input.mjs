import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
function load(path, dependencies) {
  const module = { exports: {} };
  const code = ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8').replace('import.meta.env.VITE_LICLICK_WORKSPACE_API', 'undefined'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new Function('module', 'exports', 'require', code)(module, module.exports, (name) => {
    assert(name in dependencies, name);
    return dependencies[name];
  });
  return module.exports;
}
let calls = 0;
let request;
let output = { width: 2048, height: 2048, normalUrl: 'blob:raw-normal' };
const { captureLocalRepaintNormal } = load('../src/engine/localRepaint/captureLocalRepaintNormal.ts', {
  '../capture/captureCurrentView': { captureCurrentNormalGuide: async (input) => {
    calls++; request = input; return output;
  } },
});
const capture = { id: 'capture', objectId: 'model', width: 2048, height: 2048,
  colorUrl: 'white-filled', maskUrl: 'authored-mask' };
const camera = { camera: {}, aspect: 1, target: {} };
const controller = new globalThis.AbortController();
const result = await captureLocalRepaintNormal(capture, camera, controller.signal);
assert.equal(request.cameraSnapshot, camera);
assert.equal(request.resolution, 2048);
assert.equal(request.framing, 'current');
assert.equal(request.aspect, 1);
assert.deepEqual(result, { ...capture, normalUrl: 'blob:raw-normal' });
assert.equal(capture.normalUrl, undefined);
output = { ...output, width: 1024 };
await assert.rejects(captureLocalRepaintNormal(capture, camera, controller.signal), /尺寸不一致/);
controller.abort();
await assert.rejects(captureLocalRepaintNormal(capture, camera, controller.signal), { name: 'AbortError' });
assert.equal(calls, 2);

const originalFetch = globalThis.fetch;
globalThis.window = { setTimeout, clearTimeout };
let submitted;
globalThis.fetch = async (url, options) => {
  submitted = { url, body: JSON.parse(options.body) };
  return { ok: true, json: async () => ({ id: 'job', resultUrl: 'result' }) };
};
try {
  const { createModelviewApiClient } = load('../src/services/modelviewApiClient.ts', {
    './workspaceApiBase': { getWorkspaceApiBase: () => '' },
  });
  const input = { clientGenerationId: 'job', projectId: 'project',
    image: { path: 'image.png', dataUrl: 'raw-effect' },
    materialImage: { path: 'material.png', dataUrl: 'raw-material' },
    mask: { path: 'mask.png', dataUrl: 'raw-mask' },
    normalImage: { path: 'normal.png', dataUrl: 'raw-normal' },
  };
  const generation = await createModelviewApiClient().generateInpaint(input);
  assert.equal(submitted.url, '/api/modelview/inpaint');
  assert.deepEqual(submitted.body, input);
  assert.equal(generation.metadata.modelviewWorkflow, '2026.09.18-refcontrol-normal-4step-r1');
} finally {
  globalThis.fetch = originalFetch;
  delete globalThis.window;
}
console.log('ModelView raw normal: frozen camera, 2K dimensions, cancellation and exact API serialization passed.');
