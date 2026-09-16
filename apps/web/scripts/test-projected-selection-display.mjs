import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import * as THREE from 'three';

const source = fs.readFileSync(new URL('../src/engine/localRepaint/projectedSelectionDisplay.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source.replace(/^import[^;]+;\s*/m, ''), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const exported = {};
new Function('THREE', 'exports', js)(THREE, exported);
let target = null, face = 0, fail = false, renders = 0;
const renderer = {
  capabilities: { maxFragmentUniforms: 1024 }, xr: { enabled: true }, autoClear: true,
  getRenderTarget: () => target, getActiveCubeFace: () => face, getActiveMipmapLevel: () => 0,
  getViewport: v => v.set(3, 4, 320, 200), getScissor: v => v.set(5, 6, 100, 100), getScissorTest: () => true,
  setRenderTarget: (v, layer = 0) => { target = v; face = layer; },
  setViewport() {}, setScissor() {}, setScissorTest() {},
  render(scene) {
    renders++;
    if (fail) throw new Error('GPU failure');
    const uniforms = scene.children[0].material.uniforms;
    assert.notEqual(uniforms.oldAtlas.value, target.texture, 'No framebuffer feedback loop');
  },
};
const warnings = [];
const display = new exported.ProjectedSelectionDisplay(renderer, reason => warnings.push(reason));
const depthTarget = new THREE.WebGLRenderTarget(512, 320);
depthTarget.depthTexture = new THREE.DepthTexture(512, 320);
const input = { texture: new THREE.CanvasTexture({ width: 512, height: 320 }), depthTarget,
  projectorMatrix: new THREE.Matrix4(), projectorObjectMatrix: new THREE.Matrix4(), projectorPositionLocal: new THREE.Vector3(1, 2, 3) };
const history = [];
for (let i = 0; i < 12; i++) {
  input.projectorMatrix.makeTranslation(i, 0, 0);
  display.archive(input, i % 2 ? 'subtract' : 'add');
  history.push(display.snapshot()); display.collect(history);
}
assert.equal(display.snapshot().records.length, 12, 'More than four distinct projectors survive');
assert.equal(display.enabled, true); assert.equal(warnings.length, 0);
const before = display.snapshot();
display.archive(input, 'subtract');
const after = display.snapshot();
assert.equal(after.records.length, 12, 'Adjacent same-view same-operation strokes coalesce');
assert.notEqual(after.records.at(-1).slot, before.records.at(-1).slot, 'History is immutable');
display.collect([...history, after]); display.restore(before);
assert.deepEqual(display.snapshot().records, before.records);
display.update(new THREE.Matrix4().makeTranslation(10, 0, 0), input, 'subtract', true);
assert.equal(display.material.uniforms.inverted.value, 1);
assert.equal(display.material.uniforms.count.value, 12);
assert.equal(display.material.uniforms.positions.value[0].x, 11);
assert.equal(display.material.uniforms.projectors.value[0].elements[12], -10);
display.clear(); display.collect([before]); display.restore(before);
assert.equal(display.enabled, true, 'Undo clear retains referenced GPU layers');
display.useUvFallback(); assert.equal(display.enabled, false);
display.restore(before); assert.equal(display.enabled, true);
assert.ok(!/\buv\b/.test(display.material.vertexShader));
assert.ok(!/maskMap|vUv/.test(display.material.fragmentShader));
fail = true; display.archive(input, 'add'); assert.equal(display.enabled, false); assert.equal(warnings.length, 1);
assert.equal(target, null); assert.equal(face, 0); assert.equal(renderer.xr.enabled, true); assert.equal(renderer.autoClear, true);
assert.equal(depthTarget.depthTexture.isDepthTexture, true, 'Author depth is borrowed, never destroyed');
display.dispose(); display.dispose(); assert.equal(display.enabled, false);
assert.ok(renders > 12);
const viewport = fs.readFileSync(new URL('../src/engine/viewport/ViewportCanvas.tsx', import.meta.url), 'utf8');
assert.match(viewport, /projectedSelectionDisplay\?\.archive\(getSelectionProjectionSource\(layer\), operation\)/);
assert.match(viewport, /projectedSelectionDisplay\?\.restore\(state.projectedSelection\)/);
assert.match(viewport, /projectedSelectionDisplay\?\.clear\(\)/);
assert.match(viewport, /projectedSelectionDisplay\?\.dispose\(\)/);
assert.match(viewport, /retainedStates: \[before.projectedSelection, after.projectedSelection\]/);
console.log('Projected selection editor lifecycle: 12 views, coalescing, immutable history, undo/clear, transforms, fallback, GPU state and disposal passed.');
