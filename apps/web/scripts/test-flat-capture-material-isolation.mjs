import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import * as THREE from 'three';
import ts from 'typescript';

const read = (file) => readFile(new URL(`../src/engine/capture/${file}`, import.meta.url), 'utf8');
const capture = process.argv.includes('--baseline')
  ? execFileSync('git', ['show', 'HEAD:apps/web/src/engine/capture/captureCurrentView.ts'], { encoding: 'utf8' })
  : await read('captureCurrentView.ts');
const declarations = (source, names) => {
  const ast = ts.createSourceFile('capture.ts', source, ts.ScriptTarget.Latest, true);
  return ast.statements.filter((node) => ts.isFunctionDeclaration(node) && names.includes(node.name?.text))
    .map((node) => node.getText(ast).replace(/^export /, '')).join('\n');
};
const source = declarations(await read('renderTargetUtils.ts'), ['applyTargetOnlyMaterial']) + '\n' +
  declarations(capture, ['createFlatTargetCaptureMaterial', 'prepareFlatTargetCapture', 'captureFlatTarget']);
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

async function check(mode = 'success', coverage = true) {
  const scene = new THREE.Scene();
  const shader = new THREE.ShaderMaterial({ uniforms: {
    previewLightingEnabled: { value: 1 }, previewExposure: { value: 2 },
    normalPreviewEnabled: { value: 1 }, wirePreviewEnabled: { value: 1 },
    showEmptyProjectionHatch: { value: 1 },
  } });
  const map = new THREE.Texture();
  const authored = new THREE.MeshStandardMaterial({ color: '#b38346', map });
  const meshes = [shader, shader, authored].map((material) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(), material);
    mesh.userData.liclickObjectId = 'target'; scene.add(mesh); return mesh;
  });
  const helper = new THREE.Mesh(new THREE.BoxGeometry(), authored);
  scene.add(helper);
  let draws = 0, disposed = 0, originalDisposed = 0, replacement;
  shader.addEventListener('dispose', () => { originalDisposed++; });
  authored.addEventListener('dispose', () => { originalDisposed++; });
  const assertRestored = () => {
    assert.equal(meshes[0].material, replacement ?? shader);
    assert.equal(meshes[1].material, shader);
    assert.equal(meshes[2].material, authored);
    assert.equal(shader.uniforms.previewLightingEnabled.value, 1);
    assert.equal(shader.uniforms.previewExposure.value, 2);
    assert.equal(shader.uniforms.normalPreviewEnabled.value, 1);
    assert.equal(shader.uniforms.wirePreviewEnabled.value, 1);
    assert.equal(shader.uniforms.showEmptyProjectionHatch.value, 1);
    assert.equal(helper.visible, true);
    assert.equal(originalDisposed, 0);
  };
  const render = async (request, options) => {
    assert.equal(request.resolution, 2048);
    assert.equal(options.tileSize, 512);
    assert.equal(options.applyDisplayTransform, false);
    assert.equal(options.encodedWidth, 2048);
    assert.equal(typeof options.prepareScene, 'function', 'flat capture must prepare each tile, not hold mutations over async frames');
    assertRestored();
    for (let tile = 0; tile < 16; tile++) {
      const restore = options.prepareScene();
      try {
        assert.equal(meshes[0].material, shader, 'resident GPU program must be reused');
        assert.equal(shader.uniforms.previewLightingEnabled.value, 0);
        assert.equal(shader.uniforms.previewExposure.value, 1);
        assert.equal(shader.uniforms.showEmptyProjectionHatch.value, coverage ? 2 : 0);
        assert.equal(helper.visible, false);
        assert(meshes[2].material instanceof THREE.MeshBasicMaterial);
        assert.equal(meshes[2].material.map, map, 'authored texture is not replaced by a silhouette mask');
        assert(meshes[2].material.color.equals(authored.color));
        meshes[2].material.addEventListener('dispose', () => { disposed++; });
        draws++;
        if (mode === 'render-error') throw new Error('controlled render failure');
      } finally { restore(); restore(); }
      assertRestored();
      await Promise.resolve();
      assertRestored();
      if (mode === 'replacement' && tile === 0) {
        replacement = new THREE.MeshStandardMaterial({ name: 'new authoritative material' });
        meshes[0].material = replacement;
      }
    }
    return 'encoded-authored-2048';
  };
  const run = new Function('THREE', 'renderSceneToPngUrl', 'waitForResidentUvPresentation', `${compiled}\nreturn captureFlatTarget;`)(THREE, render, async () => {});
  const task = run({ scene, objectId: 'target', resolution: 2048 }, { width: 2048, height: 2048 }, { forceEmptyProjectionHatch: coverage });
  if (mode === 'replacement') await assert.rejects(task, /模型材质在截图期间发生变化/);
  else if (mode === 'render-error') await assert.rejects(task, /controlled render failure/);
  else assert.equal((await task).url, 'encoded-authored-2048');
  assertRestored();
  assert.equal(disposed, draws, 'temporary materials are released once per draw, including errors');
  assert.equal(draws, mode === 'success' ? 16 : 1);
}
await check();
await check('success', false);
await check('render-error');
await check('replacement');
console.log('Production flat capture: per-tile material/uniform isolation, unchanged texture/2048, interrupted snapshot rejection and error cleanup passed.');
