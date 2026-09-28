/* global AbortController */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import * as THREE from 'three';
import { clone as cloneSkeleton } from 'three/examples/jsm/utils/SkeletonUtils.js';
import ts from 'typescript';

// Execute the production capture loops and state helpers. The renderer models
// framebuffer ownership and scissored pixels, not browser/GPU performance.
const source = process.argv.includes('--baseline')
  ? execFileSync('git', ['show', 'HEAD:apps/web/src/engine/capture/renderTargetUtils.ts'], { encoding: 'utf8' })
  : await readFile(new URL('../src/engine/capture/renderTargetUtils.ts', import.meta.url), 'utf8');
const readbackSource = await readFile(new URL('../src/engine/bake/gpuReadbackStripes.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('capture.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const names = ['captureSharedRendererState', 'restoreSharedRendererState', ...(source.includes('function preserveCaptureState(') ? ['preserveCaptureState'] : []), 'renderSceneToPngUrl', 'renderScenePassesToPngUrl'];
const functions = names.map((name) => {
  const declaration = ast.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert(declaration, name);
  return declaration.getText(ast).replace(/^export /, '');
}).join('\n');
const compiled = ts.transpileModule('const yieldToBrowserTask = waitForBrowserPaint;\n' +
  readbackSource.replace(/import[^;]+;/g, '').replace('export async', 'async') + '\n' + functions.replaceAll('import.meta.env.VITE_LICLICK_PIPELINE_TRACE_ENABLED', '"false"'),
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;

async function check({ width = 5, height = 3, tileSize = 2, passes = 0, fail, display = false, resize = false } = {}) {
  const originalTarget = new THREE.WebGLRenderTarget(7, 9);
  const scene = new THREE.Scene();
  const background = new THREE.Color('#13579b');
  scene.background = background;
  let target = originalTarget;
  let clearColor = new THREE.Color('#2468ac');
  let clearAlpha = 0.4;
  let viewport = new THREE.Vector4(1, 2, 7, 9);
  let scissor = new THREE.Vector4(2, 3, 4, 5);
  let scissorTest = false;
  let expectedViewport = viewport.clone();
  let expectedScissor = scissor.clone();
  const resizeViewport = () => {
    if (!resize) return;
    expectedViewport = new THREE.Vector4(0, 0, expectedViewport.z + 13, expectedViewport.w + 51);
    expectedScissor = expectedViewport.clone();
    viewport.copy(expectedViewport);
    scissor.copy(expectedScissor);
  };
  let prepared = false;
  let draws = 0;
  let waits = 0;
  let encodes = 0;
  let submitted = 0;
  let disposed = 0;
  const tiles = [];
  const buffers = new Map();
  const gl = {
    domElement: { isConnected: true },
    autoClear: true, xr: { enabled: false },
    getRenderTarget: () => target,
    getClearColor: (out) => out.copy(clearColor), getClearAlpha: () => clearAlpha,
    getViewport: (out) => out.copy(viewport), getScissor: (out) => out.copy(scissor),
    getScissorTest: () => scissorTest,
    setRenderTarget(next) {
      target = next;
      if (next !== originalTarget && !buffers.has(next)) {
        buffers.set(next, new Uint8Array(width * height * 4));
        next.addEventListener('dispose', () => { disposed += 1; });
      }
    },
    setClearColor: (color, alpha) => { clearColor = new THREE.Color(color); clearAlpha = alpha; },
    setViewport: (value) => { viewport = value.clone(); },
    setScissor: (...args) => { scissor = args[0] instanceof THREE.Vector4 ? args[0].clone() : new THREE.Vector4(...args); },
    setScissorTest: (value) => { scissorTest = value; },
    clear() { assert.notEqual(target, originalTarget); buffers.get(target).fill(0); },
    clearDepth() { assert.notEqual(target, originalTarget); },
    render() {
      assert.notEqual(target, originalTarget);
      assert.equal(scene.background, null);
      assert.equal(clearColor.getHexString(), '000000', 'Every tile must restore capture clear colour too');
      assert.equal(clearAlpha, 1);
      assert(prepared, 'Capture materials must be installed only for submission');
      if (fail === 'render') throw new Error('render');
      draws += 1;
      const [x, y, w, h] = scissorTest ? scissor.toArray() : [0, 0, width, height];
      tiles.push([x, y, w, h]);
      const pixels = buffers.get(target);
      for (let row = y; row < y + h; row++) for (let col = x; col < x + w; col++) {
        pixels[(row * width + col) * 4] = (row * width + col + 1) * (passes ? draws : 1);
      }
    },
    async readRenderTargetPixelsAsync(readTarget, x, y, w, h, pixels) {
      assert.equal(w, width); assert.equal(h, height);
      pixels.set(buffers.get(readTarget));
      await Promise.resolve();
      assertRestored('readback await');
      resizeViewport();
      if (fail === 'readback') throw new Error('readback');
    },
  };
  function assertRestored(at) {
    assert.equal(target, originalTarget, `${at}: viewport must not inherit the capture framebuffer`);
    assert.equal(scene.background, background, `${at}: background must not leak`);
    assert.equal(prepared, false, `${at}: material must not leak`);
    assert.deepEqual(viewport.toArray(), expectedViewport.toArray(), `${at}: latest viewport size must survive capture completion`);
    assert.deepEqual(scissor.toArray(), expectedScissor.toArray());
    assert.equal(scissorTest, false);
    assert.equal(clearColor.getHexString(), '2468ac');
    assert.equal(clearAlpha, 0.4);
    assert.equal(gl.autoClear, true);
    assert.equal(gl.xr.enabled, false);
  }
  const wait = async () => {
    waits += 1;
    assertRestored(`idle/paint wait ${waits}`);
    resizeViewport();
    if (fail === 'idle') throw new Error('idle');
  };
  const api = new Function('THREE', 'markCapturePerformancePhase', 'waitForSubmittedGpuWork',
    'waitForBrowserPaint', 'encodeFlippedGpuReadbackPngInWorker', 'createRegisteredObjectUrl',
    'getDisplayOutputPass', 'INTERACTIVE_CAPTURE_GPU_BUDGET_MS', `${compiled}\nreturn {renderSceneToPngUrl,renderScenePassesToPngUrl};`)(
    THREE, () => {}, async () => {
      await Promise.resolve();
      assertRestored('GPU fence await');
      resizeViewport();
      if (fail === 'fence') throw new Error('fence');
    }, wait, async (pixels, w, h) => {
      encodes += 1;
      assertRestored('encode await');
      for (let i = 0; i < w * h; i++) assert.equal(pixels[i * 4], (i + 1) * (passes || 1), 'Exact complete output must survive intervening viewport frames');
      return pixels;
    }, () => 'blob:test-capture', () => ({ render(renderer, output, input) {
      renderer.setRenderTarget(output);
      buffers.get(output).set(buffers.get(input));
    } }), 0,
  );
  const prepare = () => { prepared = true; return () => { prepared = false; }; };
  const request = { gl, scene, camera: new THREE.PerspectiveCamera(), objectId: 'test', width, height };
  const options = { ignoreSceneBackground: true, waitForViewportIdle: wait, onRenderSubmitted: () => { submitted += 1; } };
  const action = () => passes
    ? api.renderScenePassesToPngUrl(request, Array.from({ length: passes }, () => ({ prepare })), options)
    : api.renderSceneToPngUrl(request, { ...options, tileSize, prepareScene: prepare, applyDisplayTransform: display });
  if (fail) await assert.rejects(action, new RegExp(fail));
  else {
    assert.equal(await action(), 'blob:test-capture');
    assert.equal(draws, passes || Math.ceil(width / tileSize) * Math.ceil(height / tileSize));
    assert.equal(encodes, 1);
    assert.equal(submitted, 1);
    if (!passes && tileSize === 2) assert.deepEqual(tiles, [[0,0,2,2],[2,0,2,2],[4,0,1,2],[0,2,2,1],[2,2,2,1],[4,2,1,1]]);
  }
  assertRestored('completion/failure');
  assert.equal(disposed, buffers.size, 'All temporary targets must be disposed on success and failure');
  originalTarget.dispose();
}

await check();
await check({ display: true });
await check({ tileSize: 8 });
await check({ passes: 3 });
for (const options of [{}, { display: true }, { tileSize: 8 }, { passes: 3 }]) {
  await check({ ...options, resize: true });
}
for (const fail of ['idle', 'render', 'fence', 'readback']) {
  await check({ fail });
  await check({ passes: 3, fail });
  await check({ fail, resize: true });
  await check({ passes: 3, fail, resize: true });
}
// Actual scene/skeleton cloning and production queue; only the WebGL driver is
// substituted so this ownership regression can run without touching a UI.
const isolatedSource = await readFile(new URL('../src/engine/capture/isolatedNormalCapture.ts', import.meta.url), 'utf8');
const isolatedCode = ts.transpileModule(isolatedSource.replace(/import[\s\S]*?;/g, '').replace('export function', 'function').replaceAll('import.meta.env.VITE_LICLICK_PIPELINE_TRACE_ENABLED', '"false"'),
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
let creates = 0, disposes = 0, lost = 0, nextTimer = 0;
const timers = new Map();
class Driver {
  constructor() { creates++; }
  getContext() { return { isContextLost: () => false }; }
  dispose() { disposes++; }
  forceContextLoss() { lost++; }
}
const isolated = new Function('THREE', 'cloneSkeleton', 'waitForViewportInteractionIdle', 'document', 'setTimeout', 'clearTimeout',
  isolatedCode + ';return withIsolatedNormalCapture;')({ ...THREE, WebGLRenderer: Driver }, cloneSkeleton, async () => {},
  { body: { dataset: {} } }, callback => { timers.set(++nextTimer, callback); return nextTimer; }, id => timers.delete(id));
const live = new THREE.Scene();
const authoredMaterial = new THREE.MeshBasicMaterial({ color: 'blue' });
const authoredGeometry = new THREE.BoxGeometry();
const authored = new THREE.Mesh(authoredGeometry, authoredMaterial); authored.userData.liclickObjectId = 'model'; live.add(authored);
const metadataTexture = { toJSON() { throw new Error('Capture must never serialize runtime images'); } };
authored.userData.runtimeTexture = metadataTexture;
const bone = new THREE.Bone();
const skinned = new THREE.SkinnedMesh(authoredGeometry, authoredMaterial); skinned.add(bone); skinned.bind(new THREE.Skeleton([bone])); live.add(skinned);
let active = 0;
const viewport = { scene: live, gl: { outputColorSpace: THREE.SRGBColorSpace, toneMappingExposure: 1 }, camera: new THREE.PerspectiveCamera() };
const inspect = async candidate => {
  assert.equal(++active, 1, 'Independent captures serialize their private GPU owner');
  assert.notEqual(candidate.scene, live); assert.notEqual(candidate.gl, viewport.gl); assert.notEqual(candidate.camera, viewport.camera);
  const copy = candidate.scene.children[0];
  assert.notEqual(copy.userData, authored.userData);
  assert.equal(copy.userData.runtimeTexture, metadataTexture);
  assert.equal(copy.userData.liclickObjectId, 'model');
  assert.equal(copy.geometry, authoredGeometry, 'Immutable geometry is shared without copying vertex buffers');
  assert.notEqual(candidate.scene.children[1].skeleton, skinned.skeleton);
  copy.visible = false; copy.material = new THREE.MeshNormalMaterial();
  await Promise.resolve();
  assert.equal(authored.visible, true); assert.equal(authored.material, authoredMaterial);
  copy.material.dispose(); active--; return 'captured';
};
assert.deepEqual(await Promise.all([isolated(viewport, inspect), isolated(viewport, inspect)]), ['captured', 'captured']);
await assert.rejects(isolated(viewport, async () => { throw new Error('capture failure'); }), /capture failure/);
assert.equal(await isolated(viewport, inspect), 'captured', 'A failed capture cannot poison the queue');
// Superseded button requests must leave the queue before scene cloning/draw.
let staleCaptures = 0, readyChecks = 0;
const stale = Array.from({ length: 1000 }, () => {
  const controller = new AbortController();
  const job = isolated(viewport, async () => { staleCaptures++; }, {
    signal: controller.signal, beforeClone: async () => { readyChecks++; },
  });
  controller.abort();
  return job;
});
const results = await Promise.allSettled(stale);
assert.equal(results.filter(result => result.status === 'rejected' && result.reason.name === 'AbortError').length, 1000);
assert.equal(staleCaptures, 0); assert.equal(readyChecks, 0);
const lateMesh = new THREE.Mesh(authoredGeometry, authoredMaterial);
await isolated(viewport, async candidate => {
  assert.ok(candidate.scene.getObjectByName('late-model'), 'Wait for live attachment before taking an immutable clone');
}, { beforeClone: async () => { await Promise.resolve(); lateMesh.name = 'late-model'; live.add(lateMesh); } });
live.remove(lateMesh);
assert.equal(creates, 1);
for (const callback of timers.values()) callback();
assert.equal(disposes, 1); assert.equal(lost, 1);
authoredGeometry.dispose(); authoredMaterial.dispose(); skinned.skeleton.dispose();
console.log('Capture renderer isolation passed: first/per-tile/per-pass idle, GPU/readback/encode waits; exact edge tiles, full output, display path and failure cleanup.');
