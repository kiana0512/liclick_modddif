import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const helperSource = readFileSync(
  path.join(root, 'src/engine/scene/centeredTransformPivot.ts'),
  'utf8',
);
const compiled = ts.transpileModule(helperSource, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
    esModuleInterop: true,
  },
}).outputText;
const helperModule = { exports: {} };
new Function('require', 'module', 'exports', compiled)(
  (specifier) => {
    if (specifier === 'three') return THREE;
    throw new Error(`Unexpected dependency: ${specifier}`);
  },
  helperModule,
  helperModule.exports,
);
const { alignTransformPivotToObjectCenter, captureCenteredTransform, applyCenteredTransform } =
  helperModule.exports;

const parent = new THREE.Group();
parent.position.set(17, -4, 9);
parent.rotation.set(0.1, -0.25, 0.05);
parent.scale.setScalar(1.2);
const object = new THREE.Group();
object.position.set(-5, 3, 8);
object.rotation.set(-0.2, 0.4, 0.15);
object.scale.set(0.75, 1.25, 0.9);
const mesh = new THREE.Mesh(new THREE.BoxGeometry(2, 4, 6));
mesh.position.set(42, 7, -19);
object.add(mesh);
parent.add(object);
parent.updateMatrixWorld(true);

const pivot = new THREE.Object3D();
const originalCenter = new THREE.Box3().setFromObject(object).getCenter(new THREE.Vector3());
alignTransformPivotToObjectCenter(object, pivot);
assert.ok(
  pivot.position.distanceTo(originalCenter) < 1e-6,
  'The gizmo proxy must be placed at the selected model visual center, not its imported root origin.',
);

let snapshot = captureCenteredTransform(object, pivot);
const translation = new THREE.Vector3(6, -2, 3);
pivot.position.add(translation);
applyCenteredTransform(object, pivot, snapshot);
let transformedCenter = new THREE.Box3().setFromObject(object).getCenter(new THREE.Vector3());
assert.ok(
  transformedCenter.distanceTo(originalCenter.clone().add(translation)) < 1e-5,
  'Moving the centered proxy must translate the complete model by the same world-space delta.',
);

alignTransformPivotToObjectCenter(object, pivot);
snapshot = captureCenteredTransform(object, pivot);
const rotationCenter = pivot.position.clone();
pivot.quaternion.premultiply(
  new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 3),
);
applyCenteredTransform(object, pivot, snapshot);
transformedCenter = new THREE.Box3().setFromObject(object).getCenter(new THREE.Vector3());
assert.ok(
  transformedCenter.distanceTo(rotationCenter) < 1e-5,
  'Rotating the proxy must rotate the model around its visible center.',
);

alignTransformPivotToObjectCenter(object, pivot);
snapshot = captureCenteredTransform(object, pivot);
const scaleCenter = pivot.position.clone();
const sizeBefore = new THREE.Box3().setFromObject(object).getSize(new THREE.Vector3());
pivot.scale.multiplyScalar(1.5);
applyCenteredTransform(object, pivot, snapshot);
const scaledBounds = new THREE.Box3().setFromObject(object);
const sizeAfter = scaledBounds.getSize(new THREE.Vector3());
assert.ok(scaledBounds.getCenter(new THREE.Vector3()).distanceTo(scaleCenter) < 1e-5);
assert.ok(sizeAfter.distanceTo(sizeBefore.multiplyScalar(1.5)) < 1e-5);

const controlsSource = readFileSync(
  path.join(root, 'src/engine/viewport/ObjectTransformControls.tsx'),
  'utf8',
);
assert.match(controlsSource, /object=\{pivot\}/);
assert.doesNotMatch(controlsSource, /object=\{importedModel\.group\}/);
assert.match(
  controlsSource,
  /onMouseDown[\s\S]*?captureCenteredTransform[\s\S]*?onObjectChange[\s\S]*?applyCenteredTransform/,
);

mesh.geometry.dispose();
console.log('Centered transform pivot regression test passed.');
