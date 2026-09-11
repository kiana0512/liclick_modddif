import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import * as THREE from 'three';

const read = (path) => fs.readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8');
const scene = read('engine/viewport/SceneRoot.tsx');
const identityPath = new URL('../src/engine/projection/projectedMaterialIdentity.ts', import.meta.url);
const exports = {};
if (fs.existsSync(identityPath)) {
  const js = ts.transpileModule(fs.readFileSync(identityPath, 'utf8'), { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
  }}).outputText;
  new Function('exports', js)(exports);
}
const compile = (source, scope) => new Function(...Object.keys(scope), ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText)(...Object.values(scope));
const finalGate = scene.slice(scene.indexOf('      const presentsProjectedMaterial = meshes.some'),
  scene.indexOf('      if (lastProjectedTransformRef.current)', scene.indexOf('      const presentsProjectedMaterial = meshes.some')));
const residentGate = scene.slice(scene.indexOf('    let hasResidentProjectedMaterial = false;'),
  scene.indexOf('    let cancelled = false;', scene.indexOf('    let hasResidentProjectedMaterial = false;')));
const runFinal = compile(`return (meshes, visible, showWhiteMembrane = false, progressiveBaseOnly = false) => {
  let revealed = false;
  const authoritativeDisplayLayers = [{visible}];
  const committedProjectedMaterialStructureRef = {current:''};
  const projectedMaterialStructureKey = 'same-structure';
  const revealInitialMaterialPresentation = () => { revealed = true; };
  ${finalGate}
  return {revealed, committed:committedProjectedMaterialStructureRef.current};
};`, exports);
const runResident = compile(`return (group, committed) => {
  let revealed = false;
  const importedModel = {group};
  const showWhiteMembrane = false;
  const canUseProgressivePreviewBase = false;
  const committedProjectedMaterialStructureRef = {current:committed};
  const projectedMaterialStructureKey = 'same-structure';
  const revealInitialMaterialPresentation = () => { revealed = true; };
  const pass = () => { ${residentGate} };
  pass(); return revealed;
};`, { ...exports, THREE });
const names = ['LiclickProjectedLayer:repaint', 'LiclickProjectedLayerStack:a,b'];
for (const name of names) {
  const group = new THREE.Group();
  const material = new THREE.ShaderMaterial({name});
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(), material);
  group.add(mesh);
  const result = runFinal([mesh], true);
  assert.equal(result.revealed, true, `${name}: a completed exact material must release the refresh spinner`);
  assert.equal(result.committed, 'same-structure', `${name}: selection must not rebuild it`);
  assert.equal(runResident(group, result.committed), true, 'Reused/replaced full Group can be revealed');
  assert.equal(runResident(group, 'stale-structure'), false, 'Stale resident structure is not accepted');
  mesh.material = [material, material];
  assert.equal(runFinal([mesh], false).revealed, true, 'Material arrays and eye-off reconciliation remain supported');
  mesh.geometry.dispose(); material.dispose();
}
for (const name of ['LiclickProjectedLayerStackWarmup:1', 'LiclickProjectedLayer',
  'LiclickWhiteMembranePreview', 'LiclickFlatPreview', 'LiclickUvOverlayPreview']) {
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(), new THREE.ShaderMaterial({name}));
  assert.equal(runFinal([mesh], true).revealed, false, `${name}: cannot masquerade as the expected projection`);
  assert.equal(runFinal([mesh], true).committed, '');
  assert.equal(runFinal([mesh], false).revealed, name === 'LiclickUvOverlayPreview');
  mesh.geometry.dispose(); mesh.material.dispose();
}
const bootstrap = {material:{name:'bootstrap', userData:{liclickExactProjectedBootstrap:true}}};
assert.equal(runFinal([bootstrap], true).revealed, true, 'Exact bootstrap remains eligible');
const retainedMaterials = read('engine/projection/retainedProjectedMaterials.ts');
assert.equal(((scene + retainedMaterials).match(/isResidentProjectedMaterial\(material\)/g) ?? []).length, 5,
  'Reveal, fast reuse, UV bootstrap and retained-material paths share one identity contract');
console.log('Projected material reveal passed: single/stack, resident reuse, material arrays, stale structure, bootstrap and placeholder rejection.');
