import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import * as jsx from 'react/jsx-runtime';
function load(path, dependencies) {
  const module = { exports: {} };
  const code = ts.transpileModule(pipelineTraceDisabled(readFileSync(new URL(path, import.meta.url), 'utf8')).replace('import.meta.env.VITE_LICLICK_WORKSPACE_API', 'undefined'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
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
assert.equal(request.normalBackground, undefined, 'Legacy callers retain their background');
for (const background of ['black', 'blue']) {
  await captureLocalRepaintNormal(capture, camera, controller.signal, background);
  assert.equal(request.normalBackground, background);
  assert.equal(request.cameraSnapshot, camera);
}
output = { ...output, width: 1024 };
await assert.rejects(captureLocalRepaintNormal(capture, camera, controller.signal), /尺寸不一致/);
controller.abort();
await assert.rejects(captureLocalRepaintNormal(capture, camera, controller.signal), { name: 'AbortError' });
assert.equal(calls, 4);

const originalFetch = globalThis.fetch;
const serverClient = load('../src/services/modelviewApiClient.ts', {
  './workspaceApiBase': { getWorkspaceApiBase: () => '' },
  './personalRepaintMode': { personalRepaintEnabled: false },
  './workspaceApiClient': {},
});
globalThis.window = { setTimeout, clearTimeout };
for (const [provider, path] of [['modelview-int8', 'status'], ['modelview-single-view', 'status'], ['modelview-single-view-inpaint', 'status']]) {
  globalThis.fetch = async url => {
    assert.equal(url, `/api/modelview/${path}`);
    return new Response(JSON.stringify({serviceUrl:'https://user:secret@compute.example:8443/run?token=private'}));
  };
  assert.equal(await serverClient.getGenerationServerLabel(provider), 'LI3D 后端 · compute.example:8443');
}
globalThis.fetch = async () => { throw new Error('offline'); };
assert.equal(await serverClient.getGenerationServerLabel('modelview-int8'), 'LI3D 后端 · 服务器信息暂不可用');
assert.equal(await serverClient.getGenerationServerLabel('liclick-atlas'), '莉刻服务 · 算力服务器未公开');
assert.equal(await serverClient.getGenerationServerLabel(undefined), '服务器信息暂不可用');
globalThis.window = { setTimeout, clearTimeout };
let submitted;
globalThis.fetch = async (url, options) => {
  submitted = { url, body: JSON.parse(options.body) };
  return { ok: true, json: async () => ({ id: 'job', resultUrl: 'result' }) };
};
try {
  const { createModelviewApiClient } = load('../src/services/modelviewApiClient.ts', {
    './workspaceApiBase': { getWorkspaceApiBase: () => '' },
    './personalRepaintMode': load('../src/services/personalRepaintMode.ts', {}),
    './workspaceApiClient': { urlToDataUrl: async url => `data:${url}` },
  });
  const input = { clientGenerationId: 'job', projectId: 'project', referenceViewCount: 6,
    image: { path: 'image.png', dataUrl: 'raw-effect' },
    materialImage: { path: 'material.png', dataUrl: 'raw-material' },
    mask: { path: 'mask.png', dataUrl: 'raw-mask' },
    normalImage: { path: 'normal.png', dataUrl: 'raw-normal' },
  };
  const generation = await createModelviewApiClient().generateInpaint(input);
  assert.equal(submitted.url, '/api/modelview/inpaint');
  assert.deepEqual(submitted.body, input);
  assert.equal(generation.metadata.modelviewWorkflow, 'modelview-inpaint');
  for (const referenceRole of ['single-view', 'multi-view']) {
    for (const method of ['generateSingleView', 'generateSingleViewInpaint']) {
      await createModelviewApiClient()[method]({ ...input, materialReferenceRole: referenceRole });
      assert.equal(submitted.url, '/api/modelview/inpaint');
      assert.equal(submitted.body.referenceViewCount, referenceRole === 'single-view' ? 1 : 6);
      assert.deepEqual(submitted.body.mask, input.mask);
      assert.deepEqual(submitted.body.normalImage, input.normalImage);
    }
  }
  const blendCamera = { projection: 'orthographic', projectionMatrix: Array(16).fill(1) };
  const frozen = { ...capture, camera: blendCamera };
  const client = createModelviewApiClient();
  const blend = await client.prepareResultBlend('original-colour-with-alpha', frozen);
  assert.equal(blend.currentImage.dataUrl, 'data:original-colour-with-alpha');
  assert.equal(blend.objectMask.dataUrl, 'data:authored-mask');
  assert.notEqual(blend.camera.projectionMatrix, blendCamera.projectionMatrix);
  await assert.rejects(client.prepareResultBlend(undefined, frozen), /当前视角图/);
  await assert.rejects(client.prepareResultBlend('base', frozen, controller.signal), { name: 'AbortError' });
  globalThis.fetch = async (_url, options) => {
    assert.deepEqual(JSON.parse(options.body).resultBlend, blend);
    return { ok: true, json: async () => ({ id: 'job', resultUrl: 'final', resultComposition: 'single-view-ndv-v1',
      rawResultUrl: 'raw', resultBlendMaskUrl: 'weight', resultBlendBaseUrl: 'base' }) };
  };
  const blended = await client.generateSingleViewInpaint({ ...input, resultBlend: blend });
  assert.equal(blended.resultUrl, 'final');
  assert.equal(blended.metadata.rawResultUrl, 'raw');
  assert.equal(blended.metadata.resultBlendMaskUrl, 'weight');
  assert.equal(blended.metadata.resultBlendBaseUrl, 'base');
  assert.equal(blended.metadata.resultComposition, 'single-view-ndv-v1');
} finally {
  globalThis.fetch = originalFetch;
  delete globalThis.window;
}
console.log('ModelView raw normal: frozen camera, 2K dimensions, cancellation and exact API serialization passed.');

// Execute the real UI switch, including both locks and repeated toggles.
const panel = readFileSync(new URL('../src/components/panels/GeneratePanel.tsx', import.meta.url), 'utf8');
const start = panel.lastIndexOf('<div ', panel.indexOf('<span>法线黑色背景</span>'));
assert(start > 0);
const markup = panel.slice(start, panel.indexOf('</div>', start) + 6);
const code = ts.transpileModule(`function Toggle({ normalBlackBackground, workflowConfigurationLocked, workflowSubmissionLocked, setNormalBlackBackground }) { return (${markup}); }`, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const Toggle = new Function('require', 'exports', `${code}; return Toggle;`)(() => jsx, {});
for (const enabled of [false, true]) for (const configLock of [false, true]) for (const submitLock of [false, true]) {
  let changed;
  const view = Toggle({ normalBlackBackground: enabled, workflowConfigurationLocked: configLock,
    workflowSubmissionLocked: submitLock, setNormalBlackBackground: value => { changed = value; } });
  const button = view.props.children[1];
  assert.equal(button.props['aria-checked'], enabled);
  assert.equal(button.props.disabled, configLock || submitLock);
  button.props.onClick();
  assert.equal(changed, configLock || submitLock ? undefined : !enabled);
}
assert.match(panel, /\[normalBlackBackground, setNormalBlackBackground\] = useState\(false\)/);
assert.match(panel, /normalBackground: singleViewProvider === 'remote' \? normalBackground : undefined/);
assert.match(panel, /\[captureObjectId, resolution, setLastCapture, t, singleViewProvider, normalBackground\]/);
console.log('Normal background toggle: default off, blue/black forwarding and both runtime locks passed.');

// Both branches start before either resolves; failure/cancellation drains owners.
for (const mode of ['success', 'input-failure', 'normal-failure', 'abort', 'pre-abort']) {
  const pending = {};
  const started = [];
  const revoked = [];
  const deferred = name => new Promise((resolve, reject) => {
    started.push(name); pending[name] = { resolve, reject };
  });
  const { prepareRepaintInputs } = load('../src/engine/localRepaint/prepareRepaintInputs.ts', {
    './generationInputWorker': { prepareLocalRepaintGenerationInput: value => {
      assert.equal(value, capture); return deferred('input');
    } },
    '@/utils/blobUrlRegistry': { revokeRegisteredObjectUrl: url => { if (url) revoked.push(url); } },
  });
  const abort = new globalThis.AbortController();
  if (mode === 'pre-abort') abort.abort();
  let settled = false;
  const task = prepareRepaintInputs(capture, () => deferred('normal'), abort.signal);
  void task.then(() => { settled = true; }, () => { settled = true; });
  if (mode === 'pre-abort') {
    await assert.rejects(task, { name: 'AbortError' });
    assert.deepEqual(started, []);
    continue;
  }
  await Promise.resolve();
  assert.deepEqual(started, ['input', 'normal']);
  const inputResult = { compositeUrl: 'composite', submittedMaskUrl: 'submitted', selectionMaskUrl: 'selection' };
  if (mode === 'input-failure') pending.input.reject(new Error(mode));
  else pending.input.resolve(inputResult);
  await Promise.resolve(); await Promise.resolve();
  assert.equal(settled, false, 'Must drain the normal capture before releasing the workflow lock');
  if (mode === 'abort') abort.abort();
  if (mode === 'normal-failure') pending.normal.reject(new Error(mode));
  else pending.normal.resolve(result);
  if (mode === 'success') {
    const value = await task;
    assert.equal(value.prepared, inputResult);
    assert.equal(value.capture, result);
    assert.deepEqual(revoked, []);
  } else {
    await assert.rejects(task, mode === 'abort' ? { name: 'AbortError' } : new RegExp(mode));
    assert.deepEqual(revoked, mode === 'input-failure' ? ['blob:raw-normal'] :
      mode === 'normal-failure' ? ['composite', 'submitted', 'selection'] :
      ['composite', 'submitted', 'selection', 'blob:raw-normal']);
  }
}
assert.match(panel, /await prepareRepaintInputs\(preparationInput/);
console.log('Repaint preparation overlap: exact results, parallel start, failure draining, cancellation and URL cleanup passed.');
import { pipelineTraceDisabled } from './pipeline-trace-test-build.mjs';
