import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import * as jsx from 'react/jsx-runtime';
function load(path, dependencies) {
  const module = { exports: {} };
  const code = ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8').replace('import.meta.env.VITE_LICLICK_WORKSPACE_API', 'undefined'), {
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
