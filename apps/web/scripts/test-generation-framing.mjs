/* global AbortController */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as THREE from 'three';
import ts from 'typescript';

const source = await readFile(new URL('../src/engine/capture/captureCurrentView.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('capture.ts', source, ts.ScriptTarget.Latest, true);
const names = ['getBoxCorners', 'getViewFrame', 'getTargetBounds', 'getViewDirection',
  'createFitObjectCamera', 'vectorFromTuple', 'frameGenerationCapture'];
const declarations = ast.statements.filter(node => ts.isFunctionDeclaration(node) && names.includes(node.name?.text) && node.name.text !== 'frameGenerationCapture');
const framingSource = await readFile(new URL('../src/engine/capture/generationFraming.ts', import.meta.url), 'utf8');
const framingAst = ts.createSourceFile('framing.ts', framingSource, ts.ScriptTarget.Latest, true);
declarations.push(framingAst.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'frameGenerationCapture'));
assert.equal(declarations.length, names.length);
const renderSource = await readFile(new URL('../src/engine/capture/renderTargetUtils.ts', import.meta.url), 'utf8');
const renderAst = ts.createSourceFile('render.ts', renderSource, ts.ScriptTarget.Latest, true);
const targetFunction = renderAst.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'isCaptureTargetMesh');
declarations.push(targetFunction);
const code = ts.transpileModule(declarations.map(node => node.getText()).join('\n'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
let viewport;
const exports = {};
let clock = 0;
let onPaint;
const animationExports = {};
const animation = await readFile(new URL('../src/engine/capture/animateCaptureCamera.ts', import.meta.url), 'utf8');
const animationAst = ts.createSourceFile('animation.ts', animation, ts.ScriptTarget.Latest, true);
const animationFunction = animationAst.statements.find(node => ts.isFunctionDeclaration(node));
const animationCode = ts.transpileModule(animationFunction.getText(animationAst), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
new Function('exports', 'THREE', 'performance', 'waitForBrowserPaint', animationCode)(
  animationExports, THREE, { now: () => clock }, async () => { clock += 16; onPaint?.(); });
const tightSource = await readFile(new URL('../src/engine/capture/tightCaptureFraming.ts', import.meta.url), 'utf8');
const tightAst = ts.createSourceFile('tight.ts', tightSource, ts.ScriptTarget.Latest, true);
const tightCode = ts.transpileModule(targetFunction.getText() + '\n' + tightAst.statements.filter(ts.isFunctionDeclaration).map(n => n.getText()).join('\n'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const tight = {};
let maskPixels = { width: 100, height: 100, data: new Uint8ClampedArray(40000) };
maskPixels.data.set([255, 255, 255, 255], (50 * 100 + 50) * 4);
let releases = 0;
new Function('exports', 'THREE', 'performance', 'waitForBrowserPaint', 'captureMask', 'urlToImageData', 'revokeRegisteredObjectUrl', tightCode)(
  tight, THREE, { now: () => clock }, async () => { clock += 16; }, async () => ({ url: 'test-mask' }),
  async () => maskPixels, () => { releases++; });
new Function('exports', 'THREE', 'useSceneStore', 'animateCaptureCamera', 'fitGeometryCapture', 'verifyTightCapture', code)(exports, THREE,
  { getState: () => ({ viewport }) }, animationExports.animateCaptureCamera, tight.fitGeometryCapture, tight.verifyTightCapture);
const scene = new THREE.Scene();
const model = new THREE.Mesh(new THREE.BoxGeometry(2, 5, 3), new THREE.MeshBasicMaterial());
model.userData.liclickObjectId = 'model';
model.position.set(4, -2, 3);
model.rotation.set(0.3, 0.8, 0.2);
scene.add(model);
const helper = new THREE.Mesh(new THREE.BoxGeometry(100, 100, 100), model.material);
helper.userData.liclickObjectId = 'model';
helper.userData.liclickPaintOverlay = true;
scene.add(helper);
scene.updateMatrixWorld(true);
const box = new THREE.Box3().setFromObject(model);
const center = box.getCenter(new THREE.Vector3());
let checks = 0;
for (const orthographic of [false, true]) {
  for (const direction of [new THREE.Vector3(0, 0, 1), new THREE.Vector3(1, 2, 3).normalize(),
    new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, -1, 0)]) {
    for (const aspect of [0.5, 1, 2]) {
      let previousProjection;
      for (const distance of [0.1, 5, 1000]) {
        const camera = orthographic
          ? new THREE.OrthographicCamera(-800, 800, 450, -450, 0.01, 10000)
          : new THREE.PerspectiveCamera(35, 16 / 9, 0.01, 10000);
        camera.position.copy(center).addScaledVector(direction, distance);
        camera.up.set(0.2, 1, 0.1).normalize();
        camera.zoom = orthographic ? distance : 1.4;
        camera.lookAt(center);
        camera.updateProjectionMatrix();
        camera.updateMatrixWorld(true);
        let notifications = 0;
        viewport = { camera, scene, controls: { target: center.clone(), update: () => { notifications++; } } };
        const originalQuaternion = camera.quaternion.clone();
        const snapshot = await exports.frameGenerationCapture('model', aspect);
        assert.equal(notifications, 2);
        assert(camera.quaternion.angleTo(originalQuaternion) < 1e-7);
        assert.equal(camera instanceof THREE.PerspectiveCamera ? camera.aspect : camera.right, orthographic ? 800 : 16 / 9);
        const points = [];
        for (let i = 0; i < model.geometry.attributes.position.count; i++) {
          const projected = model.getVertexPosition(i, new THREE.Vector3()).applyMatrix4(model.matrixWorld).project(snapshot.camera);
          assert(Math.abs(projected.x) <= 0.920001 && Math.abs(projected.y) <= 0.920001);
          assert(projected.z >= -1 && projected.z <= 1);
          points.push(projected.x, projected.y);
        }
        assert(Math.max(...points.map(Math.abs)) >= 0.919999, 'limiting silhouette must reach 92%');
        if (previousProjection) points.forEach((value, index) => assert(Math.abs(value - previousProjection[index]) < 1e-7));
        previousProjection = points;
        const frozenPosition = snapshot.camera.position.clone();
        camera.position.addScalar(9);
        assert(snapshot.camera.position.equals(frozenPosition), 'navigation must not mutate capture');
        checks++;
      }
    }
  }
}
const fallback = { camera: viewport.camera.clone(), target: center.clone() };
const candidate = { camera: viewport.camera.clone(), target: center.clone() };
assert.equal(await tight.verifyTightCapture(viewport, 'model', candidate, fallback, 1), candidate);
maskPixels.data.set([255, 255, 255, 255], 0);
assert.equal(await tight.verifyTightCapture(viewport, 'model', candidate, fallback, 1), fallback, 'border pixel falls back');
maskPixels.data.fill(0);
assert.equal(await tight.verifyTightCapture(viewport, 'model', candidate, fallback, 1), fallback, 'empty mask falls back');
maskPixels.data.set([255, 255, 255, 255], (50 * 100 + 50) * 4);
assert(releases >= 75, 'temporary verification masks released');
assert.equal(await tight.fitGeometryCapture(scene, 'missing', fallback, 1), fallback);
// Thin protrusion, off-centre shape, hidden target and unused indexed vertices.
const irregular = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
irregular.geometry.setAttribute('position', new THREE.Float32BufferAttribute([-1,-2,0, 1,-2,0, 0,2,1, 0.03,7,0.1, 999,999,999], 3));
irregular.geometry.setIndex([0,1,2, 1,2,3]);
irregular.userData.liclickObjectId = 'irregular'; irregular.visible = false;
irregular.position.set(-3, 2, 4); irregular.rotation.set(0.2, 0.7, -0.1); scene.add(irregular);
scene.updateMatrixWorld(true);
for (const ortho of [false, true]) for (const direction of [[0,0,1],[1,0,0],[0,1,0],[0,-1,0],[-1,0,0],[0,0,-1]]) {
  viewport.camera = ortho ? new THREE.OrthographicCamera(-5,5,5,-5,0.01,10000) : new THREE.PerspectiveCamera(40,1,0.01,10000);
  viewport.camera.position.set(1,2,10); viewport.camera.lookAt(0,0,0); viewport.camera.updateMatrixWorld(true);
  const before = viewport.camera.matrixWorld.clone();
  const snap = await exports.frameGenerationCapture('irregular', 1, direction, undefined, undefined, false);
  assert(viewport.camera.matrixWorld.equals(before), 'multi-view fitting leaves live camera untouched');
  let limit = 0;
  for (let i=0; i<4; i++) {
    const v=irregular.getVertexPosition(i,new THREE.Vector3()).applyMatrix4(irregular.matrixWorld).project(snap.camera);
    assert(Math.abs(v.x)<=0.920001 && Math.abs(v.y)<=0.920001 && v.z>=-1 && v.z<=1);
    limit=Math.max(limit,Math.abs(v.x),Math.abs(v.y));
  }
  if (ortho) assert(limit>=0.919999);
  irregular.geometry.attributes.position.setXYZ(4, 5000, -2000, 3000);
  irregular.geometry.computeBoundingBox();
  const again = await exports.frameGenerationCapture('irregular', 1, direction, undefined, undefined, false);
  again.camera.matrixWorld.elements.forEach((n,i) => assert(Math.abs(n-snap.camera.matrixWorld.elements[i])<1e-6, 'unused indexed vertex must not shrink the capture'));
  irregular.geometry.attributes.position.setXYZ(4,999,999,999); irregular.geometry.computeBoundingBox();
}
scene.remove(irregular); irregular.geometry.dispose(); irregular.material.dispose();
const beforeMissing = viewport.camera.position.clone();
await assert.rejects(exports.frameGenerationCapture('missing'));
assert(viewport.camera.position.equals(beforeMissing));
let frames = 0;
onPaint = () => { if (++frames === 3) viewport.camera.position.x += 1; };
await assert.rejects(exports.frameGenerationCapture('model'), /相机已移动/);
assert.equal(frames, 3, 'user input must stop the animation immediately');
onPaint = undefined;
const abort = new AbortController(); abort.abort();
await assert.rejects(exports.frameGenerationCapture('model', 1, undefined, undefined, abort.signal), { name: 'AbortError' });
const panel = await readFile(new URL('../src/components/panels/GeneratePanel.tsx', import.meta.url), 'utf8');
assert.match(panel, /!isMultiviewRequest\s*\? await frameGenerationCapture/);
assert.match(panel, /if \(!initialMaskState.paintMaskCapture\)/);
assert.match(panel, /await initialMaskState.paintMaskCapture\(\{\s*aspect: captureAspect,\s*camera: captureCameraSnapshot.camera/);
assert.doesNotMatch(panel, /\?\? useSceneStore.getState\(\).paintMaskDataUrl/);
assert.match(source, /request.framing === 'fit-object' && !request.cameraSnapshot/);
assert.match(panel, /cameraSnapshot: capturedView.cameraSnapshot/);
assert.match(panel, /cameraSnapshot: viewSnapshots.get\(view.id\)/);
model.geometry.dispose(); helper.geometry.dispose(); model.material.dispose();
console.log(`Generation framing passed: ${checks} perspective/orthographic, pole, aspect, near/far and immutable snapshot cases.`);
