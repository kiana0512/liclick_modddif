import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import * as THREE from 'three';
import * as jsx from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
function evaluate(source, dependencies = {}) {
  const module = { exports: {} };
  const code = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText;
  new Function('module', 'exports', 'require', code)(module, module.exports, (name) => {
    assert.ok(name in dependencies, `Unexpected dependency ${name}`);
    return dependencies[name];
  });
  return module.exports;
}
const load = (path, dependencies) => evaluate(read(path), dependencies);
function functions(path, names) {
  const source = read(path);
  const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  return names.map((name) => {
    const fn = ast.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === name);
    assert.ok(fn, name);
    return fn.getText(ast);
  }).join('\n');
}

const { resolveGptRepaintReference } = load('../src/engine/localRepaint/gptRepaintReference.ts');
const { buildGptRepaintPrompt } = load('../src/engine/localRepaint/gptRepaintPrompt.ts');
const material = { id: 'material', name: 'material.png', url: 'data:image/png;base64,AQID', width: 512, height: 512, isPrimary: false };
const paired = { ...material, id: 'pair', referenceGroupId: 'material', referenceRole: 'multi-view' };
assert.equal(resolveGptRepaintReference({ enabled: false, references: [material], selectedReferenceIds: ['material'] }), undefined);
assert.equal(resolveGptRepaintReference({ enabled: false, references: [], selectedReferenceIds: [] }), undefined);
assert.throws(() => resolveGptRepaintReference({ enabled: true, references: [material], selectedReferenceIds: [] }), /先选择/);
assert.throws(() => resolveGptRepaintReference({ enabled: true, references: [material], selectedReferenceIds: ['deleted'] }), /先选择/);
const selected = resolveGptRepaintReference({ enabled: true, references: [material, paired], selectedReferenceIds: ['material'] });
assert.equal(selected.id, material.id, 'Explicit single selection must not be silently replaced by a paired view');
assert.notEqual(selected, material, 'Detach the request snapshot from UI reference state');
assert.equal(resolveGptRepaintReference({ enabled: true, references: [paired], selectedReferenceIds: ['pair'] }).id, 'pair');
for (const enabled of [false, true]) {
  const prompt = buildGptRepaintPrompt('  修复接缝  ', enabled);
  assert.ok(prompt.endsWith('用户修改要求：\n修复接缝'));
  assert.equal(prompt.includes('图三'), enabled);
  for (const rule of ['彩色编码不是材质颜色', '不得跨越空隙', '不要机械连接', '没有出现在法线图中', '弱光影', '背景保持透明'])
    assert.ok(prompt.includes(rule), rule);
}
assert.match(buildGptRepaintPrompt(' \n '), /修复待补全区域，与周围已有材质自然衔接/);

const gptOptions = load('../src/engine/generation/gptTextureModels.ts');
const { buildGptLocalRepaintRequest } = load('../src/services/gptLocalRepaintRequest.ts', {
  '@/engine/generation/gptTextureModels': gptOptions,
});
const capture = { id: 'capture', width: 2048, height: 2048, camera: {}, normalUrl: 'private-normal', maskUrl: 'private-mask', depthUrl: 'private-depth' };
const base = { generationId: 'job', projectId: 'project', model: 'gpt-image-2.5-sunburst',
  capture, guideUrl: 'data:image/png;base64,BAUG', normalUrl: 'data:image/png;base64,BwgJ', resolution: '2K' };
assert.throws(() => buildGptLocalRepaintRequest({ ...base, normalUrl: '' }), /缺少同视角法线/);

// Exercise the actual preprocessing and HTTP serialization, never a real endpoint.
const preprocessor = load('../src/services/referenceImagePreprocessor.ts', {
  './workspaceApiClient': { isWorkspaceAssetUrl: () => false },
});
const originalFetch = globalThis.fetch;
const originalWindow = globalThis.window;
const sent = [];
globalThis.window = { setTimeout, clearTimeout, location: { href: 'https://fixture.invalid/' } };
globalThis.fetch = async (url, init) => {
  if (String(url).startsWith('data:')) return originalFetch(url, init);
  assert.equal(url, 'https://fixture.invalid/api/liclick/generate-image');
  sent.push(JSON.parse(init.body));
  return new Response(JSON.stringify({ id: 'server-job', status: 'running' }), { status: 200 });
};
let abortDuringPrepare;
const { createLiclickApiClient } = load('../src/services/liclickApiClient.ts', {
  // Crop pixels and recovery mapping have their own real-image regression.
  '@/engine/generation/contentFramingImages': { prepareContentFraming: async (input) => ({ references: input.referenceImages, exactIds: input.pixelExactReferenceIds }) },
  './liclickTransport': { resolveLiclickTransport: async () => ({ baseUrl: 'https://fixture.invalid', credentials: 'include' }) },
  './generationErrorMessage': { getUserFacingGenerationError: (message) => message },
  './referenceImagePreprocessor': { ...preprocessor, prepareReferenceForAtlas: async (...args) => {
    const result = await preprocessor.prepareReferenceForAtlas(...args);
    abortDuringPrepare?.abort();
    return result;
  } },
  '@/utils/mapWithConcurrency': load('../src/utils/mapWithConcurrency.ts'),
});
try {
  for (const enabled of [false, true, false]) {
    const input = buildGptLocalRepaintRequest({ ...base, reference: enabled ? selected : undefined,
      prompt: buildGptRepaintPrompt('保持原色', enabled) });
    await createLiclickApiClient().generateTextureSingleView(input);
    const payload = sent.at(-1);
    assert.deepEqual(payload.references.map((item) => item.url), [base.guideUrl, base.normalUrl, ...(enabled ? [material.url] : [])]);
    assert.equal(payload.references.length, enabled ? 3 : 2);
    assert.equal(payload.prompt.includes('图三'), enabled);
    assert.equal(payload.workflow, 'local-repaint');
    assert.equal(payload.mask, undefined);
    assert.equal(payload.normalUrl, undefined, 'Normal is an ordered visual input, not a made-up provider control parameter');
    assert.ok(!JSON.stringify(payload).includes('private-mask'));
    assert.deepEqual(input.referenceImages.slice(0, 2).map(({width, height}) => [width, height]), [[2048, 2048], [2048, 2048]]);
  }
  const tooLarge = { ...material, id: 'oversized-normal', url: `data:image/png;base64,${'A'.repeat(preprocessor.ATLAS_REFERENCE_SAFE_DATA_URL_LENGTH + 4)}` };
  await assert.rejects(() => preprocessor.prepareReferenceForAtlas(tooLarge, { preservePixels: true }), /不会自动压缩或缩小/);
  const controller = new globalThis.AbortController();
  controller.abort();
  await assert.rejects(() => createLiclickApiClient().generateTextureSingleView({ ...buildGptLocalRepaintRequest(base), signal: controller.signal }), /abort/i);
  abortDuringPrepare = new globalThis.AbortController();
  await assert.rejects(() => createLiclickApiClient().generateTextureSingleView({ ...buildGptLocalRepaintRequest(base), signal: abortDuringPrepare.signal }), /abort/i);
  assert.equal(sent.length, 3, 'Cancelled jobs must not submit even after asynchronous image preparation');
} finally {
  globalThis.fetch = originalFetch;
  globalThis.window = originalWindow;
}

// Actual capture wrappers: the full-size guide keeps the exact frozen camera;
// the existing 1K world-normal UI preview keeps its old behavior.
const captureFns = functions('../src/engine/capture/captureCurrentView.ts', [
  'captureCurrentNormalPreview', 'captureCurrentNormalGuide', 'captureNormalView',
]);
const calls = [];
const captureApi = evaluate(`const { resolveCaptureCamera, captureNormal, serializeCamera, createId } = require('fixture');\n${captureFns}`, {
  fixture: { resolveCaptureCamera: async (request, aspect) => ({ viewport: { gl: {}, scene: {} },
    captureCamera: request.cameraSnapshot.camera, captureTarget: aspect }),
  captureNormal: async (request, options) => { calls.push({ request, options }); return { url: 'normal-png', warnings: [] }; },
  serializeCamera: (camera) => camera, createId: () => 'normal-capture' },
});
const camera = { frozen: true };
for (const resolution of [1024, 2048, 4096]) {
  const request = { objectId: 'object', resolution, aspect: 1, cameraSnapshot: { camera } };
  const guide = await captureApi.captureCurrentNormalGuide(request);
  assert.deepEqual([guide.width, guide.height], [resolution, resolution]);
  assert.equal(calls.at(-1).request.camera, camera);
  assert.equal(calls.at(-1).options.space, 'view');
  assert.equal(calls.at(-1).options.geometryGuide, true);
  assert.equal(calls.at(-1).request.clearAlpha, 0);
  const preview = await captureApi.captureCurrentNormalPreview(request);
  assert.equal(preview.width, 1024);
  assert.equal(calls.at(-1).options.space, 'world');
}

// Real Three materials / target visibility, mocked draw/readback only.
const targetOnly = functions('../src/engine/capture/renderTargetUtils.ts', ['applyTargetOnlyMaterial']);
const { applyTargetOnlyMaterial } = evaluate(`const THREE = require('three');
const isCaptureTargetMesh = (object, id) => object.isMesh && object.userData.objectId === id;
${targetOnly}`, { three: THREE });
const scene = new THREE.Scene();
const oldMaterial = new THREE.MeshStandardMaterial({ normalMap: new THREE.Texture(), bumpMap: new THREE.Texture() });
const mesh = new THREE.Mesh(new THREE.BoxGeometry(), oldMaterial);
mesh.userData.objectId = 'object';
const other = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
const grid = new THREE.GridHelper();
scene.add(mesh, other, grid);
let failDraw = false;
let disposed = 0;
const normalApi = load('../src/engine/capture/captureNormal.ts', {
  three: THREE,
  './renderTargetUtils': { applyTargetOnlyMaterial, renderSceneToPngUrl: async (request, options) => {
    assert.equal(request.scene, scene);
    assert.equal(other.visible, false); assert.equal(grid.visible, false);
    assert.ok(mesh.material.isMeshNormalMaterial);
    assert.equal(mesh.material.normalMap, null); assert.equal(mesh.material.bumpMap, null);
    mesh.material.addEventListener('dispose', () => { disposed++; });
    assert.equal(options.dataTexture, true); assert.equal(options.ignoreSceneBackground, true);
    if (failDraw) throw new Error('draw failed');
    options.onRenderSubmitted();
    await Promise.resolve();
    assert.equal(mesh.material, oldMaterial); assert.equal(grid.visible, true);
    return 'normal-png';
  } },
});
await normalApi.captureNormal({ scene, objectId: 'object' }, { geometryGuide: true });
failDraw = true;
await assert.rejects(() => normalApi.captureNormal({ scene, objectId: 'object' }, { geometryGuide: true }), /draw failed/);
assert.equal(mesh.material, oldMaterial); assert.equal(other.visible, true); assert.equal(grid.visible, true);
assert.equal(disposed, 2);

// Execute the production switch JSX, including click and disabled states.
const panel = read('../src/components/panels/GeneratePanel.tsx');
const start = panel.indexOf('<div className="mb-2 flex items-center justify-between gap-2 text-xs text-white/75">');
assert.ok(start > 0);
const markup = panel.slice(start, panel.indexOf('</div>', start) + 6);
const { Toggle } = evaluate(`export function Toggle({ gptRepaintUseMaterialReference, workflowConfigurationLocked, workflowSubmissionLocked, updateGenerationSettings }) { return (${markup}); }`, { 'react/jsx-runtime': jsx });
for (const enabled of [false, true]) for (const locked of [false, true]) {
  let change;
  const view = Toggle({ gptRepaintUseMaterialReference: enabled, workflowConfigurationLocked: locked, workflowSubmissionLocked: false,
    updateGenerationSettings: (patch) => { change = patch; } });
  const button = view.props.children[1];
  assert.equal(button.props['aria-checked'], enabled);
  assert.equal(button.props.disabled, locked);
  assert.match(renderToStaticMarkup(view), /role="switch"/);
  if (!locked) { button.props.onClick(); assert.deepEqual(change, { gptRepaintUseMaterialReference: !enabled }); }
}
assert.match(panel, /gptRepaintUseMaterialReference: false/);
assert.match(panel, /isLocalRepaintTab && \(!isGptLocalRepaint \|\| gptRepaintUseMaterialReference\)/);
assert.match(panel, /captureCurrentNormalGuide\(\{[\s\S]*?resolution: LOCAL_REPAINT_INPUT_RESOLUTION,[\s\S]*?cameraSnapshot: captureCameraSnapshot/);
assert.match(panel, /capture = \{ \.\.\.capture, normalUrl: normal.normalUrl \};[\s\S]*?saveCriticalProjectState\(\{ captures: recoveryCaptures \}\)/);
console.log('GPT normal repaint: optional switch, two/three actual serialized inputs, prompt roles, exact pixels, cancellation, camera and geometry material cleanup passed (no paid generation).');
