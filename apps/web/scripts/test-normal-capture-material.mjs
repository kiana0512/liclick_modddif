import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as THREE from 'three';
import ts from 'typescript';

const source = await readFile(new URL('../src/engine/capture/captureNormal.ts', import.meta.url), 'utf8');
const targetSource = await readFile(new URL('../src/engine/capture/renderTargetUtils.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('target.ts', targetSource, ts.ScriptTarget.Latest, true);
const helpers = ['isCaptureTargetMesh', 'applyTargetOnlyMaterial'].map(name => {
  const node = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert(node, name);
  return node.getText(ast).replace(/^export /, '');
}).join('\n');
const code = ts.transpileModule(helpers + '\n' + source.replace(/^import[^;]+;\s*/gm, '').replace('export async', 'async'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;
const seen = [], pending = [];
let fail = false, delayed = false;
const captureNormal = new Function('THREE', 'renderSceneToPngUrl', code + '\nreturn captureNormal;')(THREE,
  async (request, options) => {
    const target = request.scene.children[0];
    seen.push({ material: target.material, camera: request.camera, options, request });
    assert.equal(request.scene.children[1].visible, false);
    if (fail) throw new Error('render failure');
    options.onRenderSubmitted();
    if (delayed) await new Promise(resolve => pending.push(resolve));
    return 'normal-png';
  });

const scene = new THREE.Scene(), original = new THREE.MeshBasicMaterial();
const mesh = new THREE.Mesh(new THREE.BoxGeometry(), original);
mesh.userData.liclickObjectId = 'normal-target';
const other = new THREE.Mesh();
scene.add(mesh, other);
const gl = {}, request = { gl, scene, camera: new THREE.PerspectiveCamera(), objectId: 'normal-target', width: 4096, height: 4096 };
for (const space of ['view', 'world', 'object']) {
  const materials = new Set();
  for (let angle = 0; angle < 10; angle++) {
    request.camera = new THREE.PerspectiveCamera();
    request.camera.position.set(angle, angle + 1, angle + 2);
    const camera = request.camera;
    assert.deepEqual(await captureNormal(request, { space, geometryGuide: true }), { url: 'normal-png', warnings: [] });
    const entry = seen.at(-1);
    assert.equal(entry.camera, camera);
    assert.equal(entry.options.dataTexture, true);
    assert.equal(entry.options.ignoreSceneBackground, true);
    assert.equal(entry.options.samples, 0);
    assert.equal(mesh.material, original);
    assert.equal(other.visible, true);
    materials.add(entry.material);
  }
  assert.equal(materials.size, 1, 'One immutable material per renderer and normal space');
}
const [view, world, object] = [seen[0].material, seen[10].material, seen[20].material];
assert.equal(new Set([view, world, object]).size, 3);
assert(view instanceof THREE.MeshNormalMaterial);
assert(world instanceof THREE.ShaderMaterial);
assert(world.vertexShader.includes('mat3(modelMatrix) * normal'));
assert(object.vertexShader.includes('normalize(normal)'));
for (const material of [world, object]) {
  assert(material.fragmentShader.includes('n * 0.5 + 0.5'));
  assert(material.vertexShader.includes('projectionMatrix * modelViewMatrix'));
  assert.equal(material.toneMapped, false);
}
let disposed = 0;
view.addEventListener('dispose', () => disposed++);
fail = true;
await assert.rejects(captureNormal(request), /render failure/);
assert.equal(mesh.material, original);
assert.equal(other.visible, true);
fail = false;
await captureNormal(request);
assert.equal(seen.at(-1).material, view, 'A failed draw does not poison the next capture');
assert.equal(seen.at(-1).options.dataTexture, undefined, 'Default capture options remain unchanged');
for (const geometryGuide of [false, true]) for (const background of ['black', 'blue']) {
  await captureNormal(request, { geometryGuide, background });
  const entry = seen.at(-1);
  assert.equal(entry.material, view, 'Background does not change the normal shader');
  assert.equal(entry.options.ignoreSceneBackground, true);
  assert.equal(entry.request.clearAlpha, 1);
  const color = entry.request.clearColor.clone();
  if (!geometryGuide) color.convertLinearToSRGB();
  assert.deepEqual(color.toArray().map(c => Math.round(c * 255)), background === 'black' ? [0, 0, 0] : [128, 128, 255]);
  assert.equal(request.clearColor, undefined, 'Only the normal-pass copy is modified');
}
await captureNormal({ ...request, gl: {} });
assert.notEqual(seen.at(-1).material, view, 'A replacement renderer has an independent material owner');

delayed = true;
const first = captureNormal(request), second = captureNormal(request);
assert.equal(mesh.material, original, 'Async PNG waits must not retain scene mutations');
const newer = new THREE.MeshBasicMaterial();
mesh.material = newer;
pending.shift()();
await first;
assert.equal(mesh.material, newer, 'Late finally must not overwrite a newer material commit');
pending.shift()();
await second;
assert.equal(mesh.material, newer);
assert.equal(disposed, 0, 'Finishing an angle must not dispose the renderer-owned program');
mesh.geometry.dispose();
original.dispose();
newer.dispose();
other.geometry.dispose();
other.material.dispose();
console.log('Normal capture material regression passed: three spaces, ten angles, independent renderers, failure restoration and overlapping PNG waits.');

// [shaoyangZhou]: verify runtime visibility orchestration: whole passes keep their idle
// gates, depth-only early return, frozen source ownership and failure cleanup.
const runtimeSource = await readFile(new URL('../src/engine/projection/createRuntimeProjectionDepth.ts', import.meta.url), 'utf8');
const runtimeCode = ts.transpileModule(runtimeSource.replace(/^import[^;]+;\s*/gm, '').replaceAll('export ', ''), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;
for (const includeNormal of [false, true]) for (const failing of [false, true]) {
  const events = [], scenes = [];
  const group = new THREE.Group(), originalMaterial = new THREE.MeshBasicMaterial();
  const child = new THREE.Mesh(new THREE.BoxGeometry(), originalMaterial); group.add(child);
  const renderer = {};
  const runtime = new Function('THREE', 'renderSceneToPngUrl', 'waitForBrowserPaint', runtimeCode + '\nreturn renderRuntimeProjectionDepth;')(
    THREE, async (request, options) => {
      const pass = events.includes('depth') ? 'normal' : 'depth'; events.push(pass); scenes.push(request.scene);
      assert.equal(options.tileSize, undefined);
      assert.equal(options.samples, 0); assert.equal(options.dataTexture, true);
      assert.equal(request.width, 1024); assert.equal(request.height, 768);
      assert.equal(child.material, originalMaterial);
      if (failing) throw new Error('runtime draw failed');
      return pass;
    }, async () => { events.push('paint'); },
  );
  const camera = new THREE.PerspectiveCamera(45, 4/3, .1, 10);camera.position.z=3;camera.updateMatrixWorld(true);
  const task = runtime({ renderer, group, camera: { type:'perspective',near:.1,far:10,aspect:4/3,fov:45,
    position:camera.position.toArray(),quaternion:camera.quaternion.toArray(),projectionMatrix:camera.projectionMatrix.toArray() },
    width:1024,height:768,includeNormal,waitForViewportIdle:async()=>{events.push('idle');} });
  if (failing) await assert.rejects(task,/runtime draw failed/);
  else assert.deepEqual(await task,{depthUrl:'depth',normalUrl:includeNormal?'normal':''});
  assert.deepEqual(events,includeNormal&&!failing?['idle','depth','paint','idle','normal']:['idle','depth']);
  assert(scenes.every(scene=>scene.children.length===0));
  assert.equal(child.material,originalMaterial);child.geometry.dispose();originalMaterial.dispose();
}
console.log('Runtime visibility passed: whole-pass submission, idle gates, depth-only and failure cleanup.');
