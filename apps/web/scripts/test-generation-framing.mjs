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
new Function('exports', 'THREE', 'useSceneStore', 'animateCaptureCamera', code)(exports, THREE,
  { getState: () => ({ viewport }) }, animationExports.animateCaptureCamera);
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
        for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) {
          const projected = new THREE.Vector3(x, y, z).project(snapshot.camera);
          assert(Math.abs(projected.x) <= 0.880001 && Math.abs(projected.y) <= 0.880001);
          assert(projected.z >= -1 && projected.z <= 1);
          points.push(projected.x, projected.y);
        }
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
model.geometry.dispose(); helper.geometry.dispose(); model.material.dispose();
console.log(`Generation framing passed: ${checks} perspective/orthographic, pole, aspect, near/far and immutable snapshot cases.`);
