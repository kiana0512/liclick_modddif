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
// Execute the actual ImportedModel return tree, so a null return on hide cannot
// silently unmount/recompile an already prepared wireframe helper.
const modelTail = scene.slice(scene.lastIndexOf('  if (!importedModel) return null;'), scene.indexOf('\nexport function SceneRoot()'));
const modelPresentation = compile(`const run = (props) => { const {importedModel, objectVisible, workspaceVisible, initialMaterialPresentationReadyForGroup, displayMode} = props;\n${modelTail.slice(0, modelTail.lastIndexOf('});'))}\n};`, {
  React: { Fragment: 'fragment', createElement: (type, props, ...children) => ({type, props, children}) },
  TopologyWireframeOverlay: 'wireframe', ModelRestoreLoadingIndicator: 'loading', SelectionBoundsCorners: 'selection',
  initialMaterialPresentationVisibleForGroup: true, texturedRestoreReady: false, showSelectionGlow: false,
  onSelect() {},
});
const findNodes = (node, type) => !node || typeof node !== 'object' ? [] : [
  ...(node.type === type ? [node] : []), ...(node.children ?? []).flatMap((child) => findNodes(child, type)),
];
for (const objectVisible of [false, true]) for (const workspaceVisible of [false, true]) for (const ready of [false, true]) {
  const tree = modelPresentation({ importedModel: {group: {}, restoreStage:'full'}, objectVisible, workspaceVisible,
    initialMaterialPresentationReadyForGroup: ready, displayMode:'wire' });
  const wires = findNodes(tree, 'wireframe');
  assert.equal(wires.length, Number(ready), 'A prepared helper remains mounted when its model is hidden');
  if (ready) assert.equal(wires[0].props.visible, objectVisible && workspaceVisible);
  assert.equal(findNodes(tree, 'primitive').length, Number(objectVisible && workspaceVisible), 'Hidden models remain detached from the scene');
}

// Exercise the production helper with real Three geometry and controlled hooks.
const wireSource = scene.slice(scene.indexOf('function TopologyWireframeOverlay'), scene.indexOf('function ModelRestoreLoadingIndicator'));
const wireObject = new THREE.Group();
const wireGeometry = new THREE.BoxGeometry();
wireObject.add(new THREE.Mesh(wireGeometry, new THREE.MeshBasicMaterial()));
let memo, effectDeps, cleanupWire, wireFrame, wireCompiles = 0, wireDraws = 0;
let wireCameraRef;
const wireCompileResolvers = [];
const wireGl = {
  compileAsync: () => { wireCompiles++; return new Promise(resolve => wireCompileResolvers.push(resolve)); }, getRenderTarget: () => null,
  setRenderTarget() {}, autoClear: false,
  render: (scene) => { wireDraws++; assert.equal(scene.children[0].children[0].geometry, wireGeometry); },
};
let wireCamera = new THREE.Camera();
const renderWire = compile(`${wireSource}\nconst run = TopologyWireframeOverlay;`, {
  THREE, React: { createElement: (_type, props) => props.object },
  useThree: () => ({gl:wireGl, camera:wireCamera}),
  useMemo: (factory) => memo ??= factory(),
  useRef: (initial) => wireCameraRef ??= { current: initial },
  useFrame: (callback) => { wireFrame = callback; },
  useEffect: (callback, deps) => {
    if (!effectDeps || deps.some((v,i) => v !== effectDeps[i])) { cleanupWire?.(); cleanupWire = callback(); effectDeps = deps; }
  },
  document: {body:{dataset:{}}}, waitForProjectionVisibilityIdle: async () => {},
  isSharedViewportInteractionBusy: () => false,
});
const wireGroup = renderWire({object:wireObject, visible:true});
let wireDisposals = 0;
memo.material.addEventListener('dispose', () => wireDisposals++);
for (let i = 0; i < 16; i++) {
  wireCamera = i % 2 ? new THREE.PerspectiveCamera() : new THREE.OrthographicCamera();
  assert.equal(renderWire({object:wireObject, visible:true}), wireGroup);
}
assert.equal(wireCompiles, 1, 'Camera replacement must not restart an outstanding wireframe compile');
wireCompileResolvers.forEach(resolve => resolve());
await new Promise(setImmediate);
assert.deepEqual([wireDraws, wireDisposals], [1, 0], 'The completed poll must not dispose the active helper after a camera switch');
for (let i = 0; i < 71; i++) {
  wireObject.position.x = i;
  assert.equal(renderWire({object:wireObject, visible:false}), wireGroup);
  const hiddenMatrix = wireGroup.matrix.clone(); wireFrame();
  assert(wireGroup.matrix.equals(hiddenMatrix), 'Hidden helpers perform no transform work');
  assert.equal(renderWire({object:wireObject, visible:true}), wireGroup); wireFrame();
  assert.equal(wireGroup.matrix.elements[12], i, 'Reopened wireframe follows current transforms');
}
assert.deepEqual([wireCompiles, wireDraws, wireDisposals], [1,1,0], '71 hide/show cycles reuse the exact warmed geometry/material');
cleanupWire(); await new Promise(setImmediate);
assert.equal(wireDisposals, 1, 'Real unmount still releases the helper material');
wireObject.children[0].material.dispose(); wireGeometry.dispose();
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
const targetOnlySource = captureAst.statements.filter(node => ts.isFunctionDeclaration(node) && ['isCaptureTargetMesh', 'applyTargetOnlyMaterial'].includes(node.name?.text)).map(node => node.getText(captureAst).replace(/^export /, '')).join('\n');
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
const queueSelectionPrewarm = compile(`${read('queueSelectionPrewarm.ts').replace('export function', 'function')}\nconst run = queueSelectionPrewarm;`, { exports: {} });
const cloneShaderWarmupMesh = compile(`${read('cloneShaderWarmupMesh.ts').replace('export function', 'function')}\nconst run = cloneShaderWarmupMesh;`, { exports: {} });
const warmupGeometry = new THREE.BoxGeometry();
warmupGeometry.morphAttributes.position = [warmupGeometry.attributes.position.clone()];
const warmupMaterial = new THREE.MeshBasicMaterial();
const warmupSources = [
  new THREE.Mesh(warmupGeometry, warmupMaterial),
  new THREE.SkinnedMesh(warmupGeometry, warmupMaterial),
  new THREE.InstancedMesh(warmupGeometry, warmupMaterial, 2),
];
warmupSources[1].bind(new THREE.Skeleton([new THREE.Bone()]));
warmupSources[2].setColorAt(0, new THREE.Color('red'));
for (const source of warmupSources) {
  source.position.set(1, 2, 3);
  source.updateMatrixWorld();
  source.add(new THREE.Object3D());
  const parent = new THREE.Group();
  parent.add(source);
  const metadata = { originalMaterial: { toJSON() { throw new Error('Must not serialize original texture assets'); } } };
  source.userData = metadata;
  const shell = cloneShaderWarmupMesh(source);
  assert.equal(shell.constructor, source.constructor);
  assert.equal(shell.geometry, source.geometry);
  assert.equal(shell.material, source.material);
  assert.deepEqual(shell.matrixWorld.elements, source.matrixWorld.elements);
  assert.deepEqual(shell.morphTargetInfluences, source.morphTargetInfluences);
  assert.deepEqual(shell.morphTargetDictionary, source.morphTargetDictionary);
  assert.equal(shell.skeleton, source.skeleton);
  assert.deepEqual(shell.instanceMatrix?.array, source.instanceMatrix?.array);
  assert.deepEqual(shell.instanceColor?.array, source.instanceColor?.array);
  assert.deepEqual(shell.userData, {});
  assert.notEqual(shell.uuid, source.uuid);
  assert.equal(shell.children.length, 0);
  assert.equal(source.userData, metadata, 'Live metadata retains identity');
  assert.equal(source.parent, parent, 'Live hierarchy remains attached');
  assert.equal(source.children.length, 1);
}
warmupGeometry.dispose();
warmupMaterial.dispose();
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
  THREE, cloneShaderWarmupMesh, queueSelectionPrewarm, canUseSurfacePaint: true, paintTool: 'none', shouldShowColorPaintOverlays: true,
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
  getPaintableSurfaceCache: () => ({ positionedMeshes: [currentModel.group.children[0]] }), ensureOverlayForMesh() {},
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

// A native compile cannot be aborted by effect cleanup. Hold it across real
// selection effects: intermediate owners must never allocate or submit work.
await frame();
tool = 'none';
const before = [allocations, uploads, compiles, depths];
let finishCompile;
prewarmScope.gl.compileAsync = () => {
  compiles++;
  return new Promise((resolve) => { finishCompile = resolve; });
};
currentModel = models[2];
let stopSelection = setup();
idleCallback();
for (let i = 0; i < 5; i++) await frame();
assert.equal(compiles, before[2] + 1);
for (let i = 0; i < 71; i++) {
  stopSelection();
  currentModel = models[(i + 3) % 9];
  stopSelection = setup();
  idleCallback();
  await frame();
}
assert.deepEqual([allocations, uploads, compiles, depths], before.map((n, i) => n + (i < 3 ? 1 : 0)), 'Pending native compile excludes all later allocations/uploads/compiles');
prewarmScope.gl.compileAsync = async () => { compiles++; };
finishCompile();
for (let i = 0; i < 10; i++) await frame();
assert.deepEqual([allocations, uploads, compiles, depths], before.map((n, i) => n + [2, 2, 3, 1][i]), 'Only the final live selection completes both shaders and depth');
stopSelection();

// Rejection must release the queue without hiding the original failure, and
// unrelated renderers must remain independent.
const rendererA = {}, rendererB = {};
let rejectFirst;
const failure = new Error('native compile failed');
const first = queueSelectionPrewarm(rendererA, () => true, () => new Promise((_, reject) => { rejectFirst = reject; }));
const rejected = assert.rejects(first, (error) => error === failure);
await new Promise(setImmediate);
const admitted = [];
const second = queueSelectionPrewarm(rendererA, () => true, async () => { admitted.push('A'); });
await queueSelectionPrewarm(rendererB, () => true, async () => { admitted.push('B'); });
assert.deepEqual(admitted, ['B']);
rejectFirst(failure);
await Promise.all([rejected, second]);
assert.deepEqual(admitted, ['B', 'A']);

// Framing must reject scene-only selection before traversing any model bounds.
const controllerSource = read('CameraController.tsx');
const boundsSource = controllerSource.slice(controllerSource.indexOf('function getCombinedBoundingBox'), controllerSource.indexOf('export function CameraController'));
const combinedBounds = compile(`${boundsSource}\nconst run = getCombinedBoundingBox;`, {
  THREE, tupleFromVector: vector => vector.toArray(),
});
const empty = new THREE.Group();
assert.equal(combinedBounds([empty]), undefined);
const boxMesh = new THREE.Mesh(new THREE.BoxGeometry(2, 3, 5));
const boundsParent = new THREE.Group();
boundsParent.position.set(2, -4, 7); boundsParent.rotation.set(.5, .3, -.2);
boundsParent.scale.set(2, .7, 3); boundsParent.add(boxMesh);
boxMesh.position.set(-4, 1, 3); boxMesh.rotation.set(.8, .1, .6);
const boundsObjects = [empty, boundsParent, ...models.map(model => model.group)];
const expectedBounds = new THREE.Box3();
for (const object of boundsObjects) {
  object.updateMatrixWorld(true);
  expectedBounds.union(new THREE.Box3().setFromObject(object));
}
assert.deepEqual(combinedBounds(boundsObjects), {
  min: expectedBounds.min.toArray(), max: expectedBounds.max.toArray(),
  center: expectedBounds.getCenter(new THREE.Vector3()).toArray(),
  size: expectedBounds.getSize(new THREE.Vector3()).toArray(),
});
boxMesh.geometry.dispose(); boxMesh.material.dispose();
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
  orbitTargetKeyRef: { current: `scene:${models.map((model) => model.objectId).join('|')}` },
  getCombinedBoundingBox: () => { boundReads++; return {}; },
  fitCameraToBoundingBox: () => { fits++; }, gl: {}, scene: {},
  useSceneStore: { getState: () => ({ viewport: {} }) },
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
