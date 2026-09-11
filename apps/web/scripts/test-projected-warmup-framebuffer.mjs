import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as THREE from 'three';
import ts from 'typescript';

// Run the actual early warmup callback with delayed GPU completion. A steady
// rAF clock is insufficient if its visible draws still target the 1px FBO.
const source = await readFile(new URL('../src/engine/viewport/SceneRoot.tsx', import.meta.url), 'utf8');
const start = source.indexOf('    nextBuild.precompilePromise = nextBuild.promise.then(async (material) => {');
const end = source.indexOf('    void nextBuild.precompilePromise.catch', start);
assert(start >= 0 && end > start);
const compiled = ts.transpileModule(source.slice(start, end), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;
const run = new Function('THREE', 'gl', 'nextBuild', 'projectedTextureArrayBuildRef', 'compileForRenderTarget', 'window', 'document',
  `${compiled}\nreturn nextBuild.precompilePromise;`);

for (const onScreen of [true, false]) for (const mode of ['complete', 'cancel', 'render-error', 'compile-error', 'wait-error', 'no-fence']) {
  const original = onScreen ? null : new THREE.WebGLRenderTarget(8, 8);
  const originalFace = onScreen ? 0 : 2, originalMip = onScreen ? 0 : 1;
  let target = original, face = originalFace, mip = originalMip, frames = 0, deleted = 0, disposed = 0;
  const compiledTargets = [];
  const nextBuild = { promise: Promise.resolve(new THREE.ShaderMaterial()), cancelled: false };
  const context = {
    SYNC_GPU_COMMANDS_COMPLETE: 1, ALREADY_SIGNALED: 2, CONDITION_SATISFIED: 3, WAIT_FAILED: 4,
    fenceSync: () => mode === 'no-fence' ? null : {}, flush() {},
    clientWaitSync: () => { if (mode === 'wait-error') throw Error(mode); return frames >= 3 ? 3 : 5; },
    deleteSync: () => { deleted++; },
  };
  const gl = {
    autoClear: false, compileAsync() {},
    getRenderTarget: () => target, getActiveCubeFace: () => face, getActiveMipmapLevel: () => mip,
    setRenderTarget(t, f = 0, m = 0) { target = t; face = f; mip = m; },
    getContext: () => context,
    render() {
      assert.notEqual(target, original);
      assert.deepEqual(compiledTargets, [original, target], 'Compile both visible and offscreen variants before drawing.');
      target.addEventListener('dispose', () => { disposed++; });
      if (mode === 'render-error') throw Error(mode);
    },
  };
  const restored = () => {
    assert.equal(target, original, 'Every waiting frame must regain the visible framebuffer.');
    assert.equal(gl.autoClear, false);
    assert.equal(face, originalFace);
    assert.equal(mip, originalMip);
  };
  const window = { requestAnimationFrame(callback) {
    frames++;
    restored();
    if (mode === 'cancel') nextBuild.cancelled = true;
    globalThis.queueMicrotask(callback);
  } };
  const compile = async (_gl, _scene, _camera, compileTarget) => {
    compiledTargets.push(compileTarget);
    restored();
    if (mode === 'compile-error') throw Error(mode);
  };
  const result = run(THREE, gl, nextBuild, { current: nextBuild }, compile, window, { body: { dataset: {} } });
  if (mode.endsWith('error')) await assert.rejects(result, new RegExp(mode));
  else await result;
  restored();
  assert.equal(disposed, mode === 'compile-error' ? 0 : 1);
  assert.equal(deleted, ['complete', 'cancel', 'wait-error'].includes(mode) ? 1 : 0);
  if (mode === 'complete') assert.equal(frames, 3);
  original?.dispose();
  (await nextBuild.promise).dispose();
}
console.log('Projected warmup framebuffer: visible frames, cube/mip, cancellation, errors and GPU fence cleanup passed.');
