import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import * as THREE from 'three';

const source = fs.readFileSync(new URL('../src/engine/viewport/ViewportCanvas.tsx', import.meta.url), 'utf8');
const policy = fs.readFileSync(new URL('../src/engine/localRepaint/selectionDisplay.ts', import.meta.url), 'utf8');
const shader = policy.match(/export const inpaintSelectionDisplayShader = `([\s\S]*?)`;/)[1];
const ast = ts.createSourceFile('viewport.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const definitions = new Map(ast.statements.filter(ts.isFunctionDeclaration).map(n => [n.name?.text, n.getText(ast)]));
const depth = source.match(/const inpaintDepthShader = `([\s\S]*?)`;/)[1];
function build(name) {
  const compiled = ts.transpileModule(definitions.get(name), {
    compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS},
  }).outputText;
  return new Function('THREE', 'inpaintDepthShader', 'inpaintSelectionDisplayShader', 'INPAINT_DEPTH_EPSILON', 'INPAINT_MASK_OVERLAY_RENDER_ORDER',
    `${compiled}; return ${name};`)(THREE, depth, shader, 0.00002, 10000);
}
const texture = new THREE.Texture();
const materials = [build('createInpaintMaskMaterial')(texture), build('createAccumulatedInpaintMaskMaterial')(texture)];
const live = build('createLiveInpaintScreenPreview')();
materials.push(live.material);
for (const material of materials) {
  assert.ok(material.fragmentShader.includes(shader));
  assert.match(material.fragmentShader, /mix\(selectionFillOpacity, stripeOpacity, stripe\) \* inpaintSelectionDisplayAlpha\(maskAlpha\)/);
  assert.match(material.fragmentShader, /if \(maskAlpha <= 0\.01\) discard/);
  assert.equal(material.depthWrite, false);
}
assert.equal(materials[0].depthTest, true);
assert.equal(materials[1].depthTest, true);
assert.equal(materials[1].forceSinglePass, true);
assert.equal(live.material.depthTest, false); // Existing screen-depth clipping is retained.
assert.match(live.material.fragmentShader, /if \(surfaceDepth >= 0\.999999\) discard/);
assert.match(materials[1].fragmentShader, /maskAlpha = liveOperation > 0\.0[\s\S]*maskAlpha \* \(1\.0 - liveAlpha\)/);
assert.match(materials[1].fragmentShader, /if \(maskInverted > 0\.5\) maskAlpha = 1\.0 - maskAlpha/);

// Evaluate the production GLSL's scalar expression, not a separate policy.
const expression = shader.match(/return ([^;]+);/)[1];
const smoothstep = (lo, hi, x) => {const t = Math.min(1, Math.max(0, (x-lo)/(hi-lo))); return t*t*(3-2*t);};
const alpha = new Function('coverage', 'smoothstep', `return ${expression};`);
let previous = 0;
for (let i=0; i<=10000; i++) {
  const coverage=i/10000, value=alpha(coverage,smoothstep);
  assert.ok(value >= previous && value >= 0 && value <= 1);
  if (coverage <= 0.01) assert.equal(value,0);
  if (coverage >= 0.08) assert.equal(value,1);
  previous=value;
}
assert.ok(alpha(0.04,smoothstep)>0 && alpha(0.04,smoothstep)<1);
assert.equal(alpha(0.08,smoothstep),alpha(1,smoothstep));
for (const name of ['createInpaintMaskCaptureMaterial', 'createInpaintUvAccumulationMaterial', 'accumulateInpaintSnapshotToUv']) {
  assert.ok(definitions.has(name));
  assert.ok(!definitions.get(name).includes('inpaintSelectionDisplay'));
}
assert.equal((source.match(/\$\{inpaintSelectionDisplayShader\}/g) ?? []).length,3);
materials.forEach(m=>m.dispose());live.mesh.geometry.dispose();texture.dispose();
console.log('Selection display: three production materials, 10001 coverage samples, erase/invert/depth/capture isolation passed.');
