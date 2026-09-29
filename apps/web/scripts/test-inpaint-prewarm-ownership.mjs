import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import * as THREE from 'three';

// Execute the production effect, layer accessor and capture callback. WebGL
// allocation/PNG encoding are boundaries, not reimplementations of the policy.
const source = fs.readFileSync(new URL('../src/engine/viewport/ViewportCanvas.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('ViewportCanvas.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const callbacks = new Map();
let effect;
function visit(node) {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) &&
      ['getUvPaintLayer', 'capturePaintMask'].includes(node.name.text)) {
    callbacks.set(node.name.text, node.initializer.arguments[0]);
  }
  if (ts.isCallExpression(node) && node.expression.getText(ast) === 'useLayoutEffect' &&
      node.arguments[0]?.getText(ast).includes('getUvPaintLayer(model, true)')) effect = node;
  ts.forEachChild(node, visit);
}
visit(ast);
assert(effect);
function bind(node, scope) {
  assert(node);
  const output = ts.transpileModule(`const callback = ${node.getText(ast)};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  return new Function(...Object.keys(scope), `${output}\nreturn callback;`)(...Object.values(scope));
}

function harness(overrides = {}) {
  const model = { objectId: 'bike', group: {} };
  const projection = { id: 'projection', type: 'projected', visible: true, objectId: 'bike' };
  const mask = {
    objectId: 'bike', layerId: 'inpaint:bike', target: 'inpaint-mask',
    accumulatedMaskReady: true, accumulatedMaskMeshes: new Set(),
    accumulatedMaskTarget: { texture: { authored: true } }, maskInverted: false,
  };
  const layerRef = { current: mask };
  const scene = new THREE.Scene();
  const foreground = new THREE.Mesh();
  foreground.userData.liclickObjectId = 'bike';
  scene.add(foreground);
  const originalMaterial = foreground.material;
  const calls = { acquired: 0, disposed: 0, presented: 0, invalidated: 0, encoded: 0, paintWaits: 0 };
  let finish;
  // [shaoyangZhou]: guard the capture snapshot before the first presentation yield.
  let frozenCaptureCamera;
  const ready = new Promise(resolve => { finish = resolve; });
  const scope = {
    isInpaintMode: false, isLocalRepaintApplyMode: false, paintMaskHasContent: false,
    localRepaintGenerationPresentationActive: false, canUseSurfacePaint: true,
    paintTool: 'brush',
    activePaintLayer: projection, layerRef,
    getEraserTargetPolicy: () => ({ kind: 'projected-mask' }),
    getTargetModel: () => model,
    prepareProjectedEraserGpuPreview: () => ready,
    beginLiveEraserPreview: () => { calls.presented++; },
    invalidate: () => { calls.invalidated++; },
    ...overrides,
  };
  const accessor = bind(callbacks.get('getUvPaintLayer'), {
    layerRef, paintTool: 'inpaint-add', textureResolutionSetting: '2K',
    UV_TEXTURE_RESOLUTION: { '2K': 2048 }, UV_PAINT_RESOLUTION: 2048,
    useLayerStore: { getState: () => ({ layers: [projection], activeProjectedLayerId: projection.id }) },
    getPaintableMeshes: () => [], deactivateLiveInpaintScreenPreview: () => {},
    disposeUvPaintLayer: () => {
      calls.disposed++;
      throw new Error('Eraser prewarm attempted to dispose the authored mask');
    },
  });
  scope.getUvPaintLayer = (...args) => { calls.acquired++; return accessor(...args); };
  const capture = bind(callbacks.get('capturePaintMask'), {
    getTargetModel: scope.getTargetModel, layerRef,
    isPerformanceInstrumentationEnabled: () => false,
    maskHasContentRef: { current: true }, currentProjectionHasContentRef: { current: false },
    currentProjectionOperationRef: { current: 'add' },
    archiveCurrentInpaintProjection: () => { throw new Error('Already archived mask must stay canonical'); },
    gl: { domElement: { getBoundingClientRect: () => ({ width: 1600, height: 900 }) } },
    THREE, scene, camera: {}, PROJECTION_PAINT_MAX_SIZE: 2048,
    applyTargetOnlyMaterial: () => () => { foreground.material = originalMaterial; },
    createInpaintMaskCaptureMaterial: texture => {
      assert.equal(texture, mask.accumulatedMaskTarget.texture);
      return { uniforms: { maskInverted: { value: 0 } }, dispose() {} };
    },
    cloneCameraForCaptureAspect: camera => { frozenCaptureCamera = { ...camera }; return frozenCaptureCamera; },
    waitForBrowserPaint: async () => {
      assert(frozenCaptureCamera, 'Freeze the capture camera before yielding to viewport navigation');
      calls.paintWaits++;
    },
    renderSceneToPngUrl: async (input, options) => {
      assert.equal(input.width, 2048);
      assert.equal(input.height, 2048);
      assert.equal(input.camera.frozen, true);
      assert.equal(options.grayscaleOutput, true);
      assert.equal(options.tileSize, undefined, 'Capture the frozen mask in one draw');
      assert.equal(options.waitForViewportIdle, undefined, 'Do not wait once per tile');
      assert.equal(calls.paintWaits, 1, 'Yield to presentation once before capture');
      const restore = options.prepareScene();
      assert.equal(foreground.visible, true, 'Unpainted foreground must remain an occluder');
      assert.equal(foreground.material.color.getHex(), 0);
      assert.equal(foreground.material.depthWrite, true);
      assert.equal(foreground.material.transparent, false);
      restore();
      assert.equal(foreground.material, originalMaterial);
      calls.encoded++;
      return 'data:image/png;base64,authored-mask';
    },
    document: { body: { dataset: {} } },
  });
  return { scope, mask, layerRef, calls, finish, capture, run: () => bind(effect.arguments[0], scope)() };
}

for (const phase of [
  {}, // Pointer-created live mask, before React/store flags have caught up.
  { isInpaintMode: true }, // add/subtract share this mode.
  { paintMaskHasContent: true }, // Idle / hidden selection after mouse-up.
  { localRepaintGenerationPresentationActive: true },
  { isLocalRepaintApplyMode: true },
]) {
  const h = harness(phase);
  h.run();
  // Active row and callback identity can change during framing/save preparation.
  h.scope.activePaintLayer = { ...h.scope.activePaintLayer, id: 'another-projection' };
  h.run();
  assert.equal(h.layerRef.current, h.mask);
  assert.equal(h.calls.acquired, 0);
  assert.equal(h.calls.disposed, 0);
  assert.equal(await h.capture({ aspect: 1, resolution: 2048, camera: { frozen: true } }),
    'data:image/png;base64,authored-mask');
  assert.equal(h.calls.encoded, 1);
}

// Each protection must work independently, including before the inpaint owner
// is allocated. Background projected-mask prewarm must still work when safe,
// while the active eraser owns preparation exclusively in the following effect.
for (const flag of ['isInpaintMode', 'isLocalRepaintApplyMode', 'paintMaskHasContent',
  'localRepaintGenerationPresentationActive']) {
  assert(effect.arguments[1].getText(ast).includes(flag), `${flag} must invalidate the effect`);
  const h = harness({ [flag]: true });
  h.layerRef.current = undefined;
  h.run();
  assert.equal(h.calls.acquired, 0, flag);
}
assert(effect.arguments[1].getText(ast).includes('paintTool'), 'paintTool must invalidate the effect');
{
  const h = harness({ paintTool: 'eraser' });
  h.layerRef.current = undefined;
  h.run();
  assert.equal(
    h.calls.acquired,
    0,
    'The active eraser must not race the speculative neutral prewarm owner',
  );
}
for (const outcome of ['ready', 'cleanup', 'new-owner', 'gpu-unavailable']) {
  const h = harness();
  h.layerRef.current = {
    objectId: 'bike', layerId: 'projection', target: 'projected-mask',
    paintDefaultResolution: 2048, accumulatedMaskMeshes: new Set(),
    eraserGpu: outcome === 'gpu-unavailable' ? undefined : {},
  };
  const cleanup = h.run();
  assert.equal(h.calls.acquired, 1);
  if (outcome === 'cleanup') cleanup();
  if (outcome === 'new-owner') h.layerRef.current = h.mask;
  h.finish();
  await Promise.resolve();
  assert.equal(h.calls.presented, outcome === 'ready' ? 1 : 0, outcome);
  assert.equal(h.calls.invalidated, outcome === 'ready' ? 1 : 0, outcome);
  assert.equal(h.calls.disposed, 0);
}
process.stdout.write('inpaint/prewarm ownership and generation capture tests passed\n');
