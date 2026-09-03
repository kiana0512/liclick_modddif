import assert from 'node:assert/strict';
import fs from 'node:fs';
import { setImmediate } from 'node:timers';
import ts from 'typescript';
import * as THREE from 'three';

const read = (name) => fs.readFileSync(new URL(`../src/engine/viewport/${name}`, import.meta.url), 'utf8');
const compile = (source, scope) => {
  const js = ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React,
  }}).outputText;
  return new Function(...Object.keys(scope), `${js}\nreturn run;`)(...Object.values(scope));
};
const effect = (text, marker) => {
  const file = ts.createSourceFile('test.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const matches = [];
  const visit = (node) => {
    if (ts.isCallExpression(node) && node.expression.getText(file) === 'useEffect' &&
        node.arguments[0]?.getText(file).includes(marker)) matches.push(node.arguments[0].getText(file));
    ts.forEachChild(node, visit);
  };
  visit(file);
  assert.equal(matches.length, 1, `Find the production ${marker} effect`);
  return `const run = ${matches[0]};`;
};

// Execute the production indicator with real Three resources and a small hook
// lifecycle harness. Selection must change visibility, not GPU resource identity.
const scene = read('SceneRoot.tsx');
const indicatorSource = scene.slice(scene.indexOf('const selectionBoundsCache'), scene.indexOf('function TopologyWireframeOverlay'));
let selectedObjectId;
let workspaceMode = 'scene';
function indicatorHarness(object, objectId) {
  const slots = [];
  let cursor = 0;
  let pendingEffects = [];
  let frame;
  const changed = (previous, next) => !previous || next.some((value, i) => value !== previous[i]);
  const useEffect = (callback, deps) => {
    const index = cursor++;
    if (changed(slots[index]?.deps, deps)) pendingEffects.push(() => {
      slots[index]?.cleanup?.();
      slots[index] = { deps, cleanup: callback() };
    });
  };
  const run = compile(`${indicatorSource}\nconst run = SelectionBoundsCorners;`, {
    THREE, React: { createElement: (_type, props) => props.object },
    useSceneStore: { getState: () => ({ selectedObjectId }) },
    useWorkspaceLayoutStore: { getState: () => ({ mode: workspaceMode }) },
    useRef: (initial) => slots[cursor++] ??= { current: initial },
    useMemo: (factory, deps) => {
      const index = cursor++;
      if (changed(slots[index]?.deps, deps)) slots[index] = { deps, value: factory() };
      return slots[index].value;
    },
    useEffect, useLayoutEffect: useEffect,
    useFrame: (callback) => { frame = callback; },
  });
  return {
    render(visible) {
      cursor = 0;
      pendingEffects = [];
      const lines = run({ object, objectId, visible });
      pendingEffects.forEach((callback) => callback());
      frame();
      return lines;
    },
    frame() { frame(); },
    dispose() { slots.forEach((slot) => slot?.cleanup?.()); },
  };
}
const models = Array.from({ length: 9 }, (_, i) => {
  const group = new THREE.Group();
  group.add(new THREE.Mesh(new THREE.BoxGeometry(1, 2, 3), new THREE.MeshBasicMaterial()));
  group.position.x = i * 3;
  return { objectId: `model-${i}`, group };
});
const indicators = models.map(({ group, objectId }) => indicatorHarness(group, objectId));
const lines = indicators.map((owner) => owner.render(false));
let geometryDisposals = 0;
let materialDisposals = 0;
lines.forEach((line) => {
  line.geometry.addEventListener('dispose', () => geometryDisposals++);
  line.material.addEventListener('dispose', () => materialDisposals++);
});
for (let selection = 0; selection < 71; selection++) {
  selectedObjectId = models[selection % 9].objectId;
  indicators.forEach((owner, i) => {
    assert.equal(owner.render(i === selection % 9), lines[i]);
    assert.equal(lines[i].visible, i === selection % 9);
  });
}
assert.equal(geometryDisposals + materialDisposals, 0);
const positions = lines[0].geometry.attributes.position.array.slice();
models[0].group.position.x += 10;
selectedObjectId = models[0].objectId;
indicators[0].render(true);
assert.notDeepEqual(lines[0].geometry.attributes.position.array, positions, 'Transforms still update selection bounds');

// Real capture restore: submission restores once; readback/PNG completion can
// happen after a new selection/material commit. Its finally must not roll back.
const captureSource = fs.readFileSync(new URL('../src/engine/capture/renderTargetUtils.ts', import.meta.url), 'utf8');
const captureAst = ts.createSourceFile('capture.ts', captureSource, ts.ScriptTarget.Latest, true);
const targetOnlySource = captureAst.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === 'applyTargetOnlyMaterial').getText(captureAst);
const applyTargetOnlyMaterial = compile(`${targetOnlySource.replace(/^export /, '')}\nconst run = applyTargetOnlyMaterial;`, { THREE });
const captureScene = new THREE.Scene();
models.forEach(({ group, objectId }, i) => {
  group.children[0].userData.liclickObjectId = objectId;
  captureScene.add(group, lines[i]);
});
const captureMesh = models[0].group.children[0];
const originalMaterial = captureMesh.material;
const restoreCapture = applyTargetOnlyMaterial(captureScene, models[0].objectId);
assert(lines.every((line) => !line.visible), 'Capture excludes selection chrome');
restoreCapture(); // onRenderSubmitted
selectedObjectId = models[1].objectId;
indicators.forEach((owner, i) => owner.render(i === 1));
captureMesh.material = new THREE.MeshBasicMaterial({ color: 'red' });
const newerMaterial = captureMesh.material;
restoreCapture(); // delayed finally after async readback/PNG encoding
assert.equal(lines[0].visible, false, 'Late capture restore must not resurrect the old selection');
assert.equal(lines[1].visible, true, 'Late capture restore must not hide the new selection');
assert.equal(captureMesh.material, newerMaterial, 'Late restore must not overwrite a newer material');
newerMaterial.dispose();
captureMesh.material = originalMaterial;

// Selection can change while React is still reconciling heavy model children.
// Drive production frame callbacks without re-rendering their old props.
for (let selection = 0; selection < 71; selection++) {
  selectedObjectId = models[selection % 9].objectId;
  indicators.forEach((owner) => owner.frame());
  lines.forEach((line, i) => assert.equal(line.visible, i === selection % 9, 'Presented bounds must follow the latest selection, not stale React props'));
}
selectedObjectId = undefined;
indicators.forEach((owner) => owner.frame());
assert(lines.every((line) => !line.visible), 'Deselection hides every resident indicator');
selectedObjectId = models[0].objectId;
workspaceMode = 'texture';
indicators.forEach((owner) => owner.frame());
assert(lines.every((line) => !line.visible), 'Workspace change hides chrome before React commit');
workspaceMode = 'scene';
indicators.forEach((owner) => owner.frame());
assert.equal(lines[0].visible, true);
const attributeVersion = lines[0].geometry.attributes.position.version;
for (let i = 0; i < 71; i++) indicators.forEach((owner) => owner.frame());
assert.equal(lines[0].geometry.attributes.position.version, attributeVersion, 'Idle frames must not rebuild or upload bounds');
assert.equal(geometryDisposals + materialDisposals, 0);
indicators.forEach((owner) => owner.dispose());
assert.equal(geometryDisposals, 9);
assert.equal(materialDisposals, 9);
assert.match(scene, /texturedRestoreReady && showSelectionGlow && \(\s*<SelectionBoundsCorners object=\{importedModel.group\} objectId=\{importedModel.objectId\}/);

// Run the actual prewarm effect with controllable idle/frame boundaries.
const viewport = read('ViewportCanvas.tsx');
const prewarmEffect = effect(viewport, 'selection-mask-overlay-prewarm');
let currentModel = models[0];
let busy = true;
let tool = 'none';
let allocations = 0;
let uploads = 0;
let compiles = 0;
let depths = 0;
let idleCallback;
const frames = [];
const layerRef = { current: undefined };
const prewarmScope = {
  THREE, canUseSurfacePaint: true, paintTool: 'none', shouldShowColorPaintOverlays: true,
  getTargetModel: () => currentModel,
  getUvPaintLayer: (model) => {
    allocations++;
    return layerRef.current = { layerId: model.objectId, projectionTexture: { uuid: model.objectId }, accumulatedMaskOverlays: [] };
  },
  layerRef, inpaintMaskPrewarmResourceKeyRef: { current: undefined },
  isPaintingRef: { current: false }, isViewportInteractionBusy: () => busy,
  useSceneStore: { getState: () => ({ paintTool: tool }) },
  waitForBrowserPaint: () => new Promise((resolve) => frames.push(resolve)),
  window: {
    requestIdleCallback: (callback) => { idleCallback = callback; return 1; },
    cancelIdleCallback: () => { idleCallback = undefined; },
  },
  syncInpaintMaskProjection() {}, hideInpaintMaskPresentation() {},
  getPaintableSurfaceCache: () => ({ positionedMeshes: [] }), ensureOverlayForMesh() {},
  gl: { initTexture: () => uploads++, compileAsync: async () => { compiles++; } },
  camera: new THREE.Camera(), inpaintDepthMaterial: new THREE.MeshBasicMaterial(),
  captureInpaintProjectionDepth: () => { depths++; }, markPerformanceEvent() {},
};
const setup = compile(prewarmEffect, prewarmScope);
const frame = async () => { frames.splice(0).forEach((resolve) => resolve()); await new Promise(setImmediate); };
for (let i = 0; i < 71; i++) {
  currentModel = models[i % 9];
  const cleanup = setup();
  idleCallback(); // Even an idle deadline firing during input must not allocate.
  await frame();
  cleanup();
}
assert.equal(allocations, 0, 'Rapid switching must allocate zero prewarm resources');
currentModel = models[0];
const cleanup = setup();
idleCallback();
await frame();
assert.equal(allocations, 0);
busy = false;
for (let i = 0; i < 6; i++) await frame();
assert.deepEqual([allocations, uploads, compiles, depths], [1, 1, 2, 1], 'Final selection retains complete shader/depth prewarm');
cleanup();
currentModel = models[1];
const cancelDuringPrepare = setup();
idleCallback();
await frame(); // Allocation happened, but the next GPU stage has not.
tool = 'inpaint-add';
await frame();
assert.equal(uploads, 1, 'Tool ownership change cancels queued GPU stages');
cancelDuringPrepare();

// Framing must reject scene-only selection before traversing any model bounds.
const cameraEffect = effect(read('CameraController.tsx'), 'const currentModelIds');
let boundReads = 0;
let fits = 0;
const cameraScope = {
  THREE, controlsRef: { current: { target: new THREE.Vector3(), update() {} } },
  importedModels: models, importedModel: models[0], selectedObjectId: models[0].objectId,
  importedModelIdsRef: { current: new Set(models.map((model) => model.objectId)) },
  workspaceModeRef: { current: 'scene' }, workspaceMode: 'scene',
  getWorkspaceCameraTransition: () => 'none', isStrictModelAppend: () => false,
  importSettings: { autoFitCamera: true }, camera: { uuid: 'camera' },
  orbitTargetKeyRef: { current: `camera:scene:${models.map((model) => model.objectId).join('|')}` },
  getCombinedBoundingBox: () => { boundReads++; return {}; },
  fitCameraToBoundingBox: () => { fits++; }, gl: {}, scene: {},
};
const updateCamera = compile(cameraEffect, cameraScope);
for (let i = 0; i < 71; i++) updateCamera();
assert.equal(boundReads + fits, 0);
cameraScope.orbitTargetKeyRef.current = undefined;
updateCamera();
assert.deepEqual([boundReads, fits], [1, 1], 'A real camera fit still measures current bounds');
models.forEach(({ group }) => group.traverse((child) => {
  if (child instanceof THREE.Mesh) { child.geometry.dispose(); child.material.dispose(); }
}));
prewarmScope.inpaintDepthMaterial.dispose();
console.log('Model selection residency passed: 71 switches, no indicator churn, no busy prewarm allocation, no redundant scene bounds; final prewarm and cleanup preserved.');
