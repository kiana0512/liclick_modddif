import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as THREE from 'three';
import ts from 'typescript';

const source = await readFile(new URL('../src/engine/viewport/ViewportCanvas.tsx', import.meta.url), 'utf8');
const helper = await readFile(new URL('../src/engine/paint/viewAlignedBrush.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('viewport.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const functions = ['createCircularBrushTransform', 'computeScreenBrushTransform', 'computeUvBrushTransform',
  'computeLocalRepaintBrushTransform', 'projectWorldPointToLocalRepaintUv',
  'computeLocalRepaintScreenBrushTransform', 'projectScreenBrush',
  'readSurfaceBrushEdges', 'prepareSurfaceBrushBasis'];
const declarations = ast.statements.filter(node =>
  (ts.isFunctionDeclaration(node) && functions.includes(node.name?.text)) ||
  (ts.isVariableStatement(node) && node.declarationList.declarations.some(d => d.name.getText(ast) === 'surfaceBrushScratch')),
).map(node => node.getText(ast));
assert.equal(declarations.length, 10);
const compile = text => ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const api = new Function('THREE', compile(helper.replace(/^import .*;$/m, '').replace('export function', 'function')) +
  '\nconst UV_PAINT_RESOLUTION=1024; const localRepaintProjectionScratch={clipPoint:new THREE.Vector4()};\n' +
  compile(declarations.join('\n')) + '\nreturn {' + functions.join(',') + ',computeViewAlignedSurfaceTangents};')(THREE);
const golden = await readFile(new URL('./fixtures/repaint-ba5954d8-brush.txt', import.meta.url), 'utf8');
const original = new Function('THREE',
  '\nconst UV_PAINT_RESOLUTION=1024; const localRepaintProjectionScratch={clipPoint:new THREE.Vector4()};\n' +
  compile(declarations.filter(text => !/^function (?:computeScreenBrushTransform|computeLocalRepaintBrushTransform)\(/.test(text)).join('\n')) +
  compile(golden) + '\nreturn {computeScreenBrushTransform,computeLocalRepaintBrushTransform};')(THREE);
const ordinaryGolden = await readFile(new URL('./fixtures/ordinary-uv-brush-before-combination.txt', import.meta.url), 'utf8');
const ordinaryOriginal = new Function('THREE', compile(helper.replace(/^import .*;$/m, '').replace('export function', 'function')) +
  '\nconst UV_PAINT_RESOLUTION=1024; const localRepaintProjectionScratch={clipPoint:new THREE.Vector4()};\n' +
  compile(declarations.filter(text => !/^function computeUvBrushTransform\(/.test(text)).join('\n')) +
  compile(ordinaryGolden) + '\nreturn computeUvBrushTransform;')(THREE);
const close = (a, b, tolerance = 1e-6) => assert.ok(Math.abs(a-b) < tolerance, `${a} != ${b}`);
let cases = 0;
for (const orthographic of [false, true]) for (const viewport of [[1200, 600], [600, 1000]]) {
  const aspect = viewport[0]/viewport[1];
  const camera = orthographic ? new THREE.OrthographicCamera(-2*aspect, 2*aspect, 2, -2, .01, 100)
    : new THREE.PerspectiveCamera(45, aspect, .01, 100);
  const parent = new THREE.Group(); parent.rotation.set(.1, -.2, .3); parent.position.set(.4, -.2, .1);
  parent.add(camera); camera.position.z=5; parent.updateMatrixWorld(true);
  const geometry = new THREE.PlaneGeometry(2, 2);
  const face = {a:0,b:2,c:1};
  for (const angle of [0, 30, 60, 80]) for (const offset of [0, .25]) {
    const mesh = new THREE.Mesh(geometry);
    mesh.rotation.set(.1, THREE.MathUtils.degToRad(angle), .35); mesh.scale.set(1.3,.8,1.1);
    mesh.updateMatrixWorld(true);
    const point=new THREE.Vector3(offset, 0, 0).applyMatrix4(mesh.matrixWorld), radius=.0001;
    const screen=api.computeScreenBrushTransform(point,camera,radius,2);
    const pixels = axis => new THREE.Vector2(axis.x*viewport[0],axis.y*viewport[1]);
    close(pixels(screen.axisX).length(), pixels(screen.axisY).length());
    close(screen.axisX.y,0); close(screen.axisY.x,0);
    const uv=api.computeUvBrushTransform(mesh,face,point,camera,radius,2);
    const originalUv=ordinaryOriginal(mesh,face,point,camera,radius,2);
    for (const key of ['axisX','axisY']) close(uv[key].distanceTo(originalUv[key]),0,1e-12);
    const ndc=point.clone().project(camera);
    for (const key of ['axisX','axisY']) {
      const worldDelta=new THREE.Vector3(uv[key].x*2,uv[key].y*2,0).applyMatrix3(new THREE.Matrix3().setFromMatrix4(mesh.matrixWorld));
      const p=point.clone().add(worldDelta).project(camera);
      const screenDelta=new THREE.Vector2((p.x-ndc.x)*.5,(ndc.y-p.y)*.5);
      assert.ok(pixels(screenDelta).distanceTo(pixels(screen[key])) < .002, 'UV fallback must project to the same screen circle');
    }
    const sourceClip = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix,camera.matrixWorldInverse);
    const local=api.computeLocalRepaintBrushTransform(mesh,face,point,sourceClip,radius,2);
    const originalLocal=original.computeLocalRepaintBrushTransform(mesh,face,point,sourceClip,radius,2);
    const localScreen=api.computeLocalRepaintScreenBrushTransform(mesh,face,point,camera,radius,2);
    const originalScreen=original.computeScreenBrushTransform(mesh,face,point,camera,radius,2);
    for(const key of ['axisX','axisY']) {
      close(local[key].distanceTo(originalLocal[key]),0,1e-12);
      close(localScreen[key].distanceTo(originalScreen[key]),0,1e-12);
    }
    cases++;
  }
  geometry.dispose();
}
const camera=new THREE.OrthographicCamera(-1,1,1,-1,.1,100); camera.position.z=5; camera.updateMatrixWorld();
for (const geometry of [new THREE.BufferGeometry(), new THREE.PlaneGeometry(2, 2)]) {
  const mesh = new THREE.Mesh(geometry);
  mesh.scale.set(0, 0, 0); mesh.updateMatrixWorld(true);
  const face = { a: 0, b: 2, c: 1 }, point = new THREE.Vector3();
  const clip = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix,camera.matrixWorldInverse);
  const actual = api.computeLocalRepaintScreenBrushTransform(mesh,face,point,camera,.1,2);
  const expected = original.computeScreenBrushTransform(mesh,face,point,camera,.1,2);
  const uv = api.computeUvBrushTransform(mesh,face,point,camera,.1,2);
  const originalUv = ordinaryOriginal(mesh,face,point,camera,.1,2);
  const local = api.computeLocalRepaintBrushTransform(mesh,face,point,clip,.1,2);
  const originalLocal = original.computeLocalRepaintBrushTransform(mesh,face,point,clip,.1,2);
  for (const key of ['axisX','axisY']) {
    close(actual[key].distanceTo(expected[key]),0,1e-12);
    close(uv[key].distanceTo(originalUv[key]),0,1e-12);
    close(local[key].distanceTo(originalLocal[key]),0,1e-12);
  }
  geometry.dispose();
}
assert.equal(api.computeViewAlignedSurfaceTangents(new THREE.Vector3(1,0,0),new THREE.Vector3(),camera,new THREE.Vector3(),new THREE.Vector3()),false,
  'A grazing fallback must not divide by zero');
console.log(`View-aligned brush passed: ${cases} perspective/orthographic, aspect, parent-camera, slope and UV/source cases.`);
