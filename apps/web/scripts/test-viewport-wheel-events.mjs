import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { events } from '@react-three/fiber';
import * as THREE from 'three';
import { createServer } from 'vite';

// Exercise the installed R3F dispatcher, not a reimplementation of its picking.
class InputTarget {
  clientWidth = 100;
  clientHeight = 100;
  listeners = new Map();
  captures = new Set();
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }
  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }
  setPointerCapture(id) { this.captures.add(id); }
  hasPointerCapture(id) { return this.captures.has(id); }
  releasePointerCapture(id) { this.captures.delete(id); }
  emit(type, overrides = {}) {
    const event = {
      type, target: this, pointerId: 1, button: 0,
      offsetX: 50, offsetY: 50, clientX: 50, clientY: 50,
      deltaX: 0, deltaY: 1, deltaMode: 0,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() { this.propagationStopped = true; },
      ...overrides,
    };
    for (const listener of this.listeners.get(type) ?? []) listener(event);
    return event;
  }
}

function makeScene(factory, orthographic = false) {
  const camera = orthographic
    ? new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100)
    : new THREE.PerspectiveCamera(45, 1, 0.1, 100);
  camera.position.z = 5;
  camera.updateMatrixWorld();
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.MeshBasicMaterial());
  let raycasts = 0;
  let clicks = 0;
  let misses = 0;
  const originalRaycast = mesh.raycast;
  mesh.raycast = function (...args) {
    raycasts += 1;
    return originalRaycast.apply(this, args);
  };
  const state = {
    size: { width: 100, height: 100 },
    pointer: new THREE.Vector2(), raycaster: new THREE.Raycaster(), camera,
    internal: {
      interaction: [mesh], lastEvent: { current: null },
      capturedMap: new Map(), hovered: new Map(), initialClick: [0, 0], initialHits: [],
    },
    set(update) { Object.assign(state, typeof update === 'function' ? update(state) : update); },
  };
  const store = { getState: () => state };
  mesh.__r3f = {
    root: store, eventCount: 2,
    handlers: { onClick: () => { clicks += 1; }, onPointerMissed: () => { misses += 1; } },
  };
  const manager = factory(store);
  state.events = manager;
  const target = new InputTarget();
  manager.connect(target);
  return {
    camera, mesh, manager, target, state,
    counts: () => ({ raycasts, clicks, misses }),
    dispose() {
      manager.disconnect();
      mesh.geometry.dispose();
      mesh.material.dispose();
    },
  };
}

const originalHTMLElement = globalThis.HTMLElement;
globalThis.HTMLElement = InputTarget;
const server = await createServer({
  root: fileURLToPath(new URL('..', import.meta.url)),
  appType: 'custom', logLevel: 'silent', server: { middlewareMode: true },
});
try {
  const { createViewportEvents } = await server.ssrLoadModule('/src/engine/viewport/viewportEvents.ts');
  const { BlenderOrbitControls } = await server.ssrLoadModule('/src/engine/viewport/BlenderOrbitControls.ts');
  const baseline = makeScene(events);
  for (let i = 0; i < 1021; i++) baseline.target.emit('wheel');
  assert.equal(baseline.counts().raycasts, 1021, 'Baseline must reproduce one needless pick per packet');
  baseline.dispose();

  for (const orthographic of [false, true]) {
    const scene = makeScene(createViewportEvents, orthographic);
    let activity = 0;
    const controls = new BlenderOrbitControls(scene.camera, scene.target, () => { activity += 1; });
    let totalDelta = 0;
    for (let i = 0; i < 1021; i++) {
      const deltaY = i % 2 === 0 ? 1 : -0.25;
      totalDelta += deltaY;
      const event = scene.target.emit('wheel', { deltaY });
      assert(!event.defaultPrevented && !event.propagationStopped, 'Wheel must remain passive and propagate');
    }
    assert.equal(scene.counts().raycasts, 0, 'High-frequency wheel must never enter scene picking');
    assert.equal(activity, 1021, 'All original wheel packets must reach native camera controls');
    assert.equal(scene.camera.position.z, 5, 'Camera work stays frame-batched');
    assert.equal(scene.camera.zoom, 1);
    for (let i = 0; i < 300; i++) controls.updateWheelTransition(1 / 60);
    const factor = Math.exp(totalDelta * controls.zoomSpeed);
    const actual = orthographic ? scene.camera.zoom : scene.camera.position.z;
    const expected = orthographic ? 1 / factor : 5 * factor;
    assert(Math.abs(actual - expected) < 1e-5, 'Complete wheel delta and zoom response must be preserved');
    controls.dispose();

    // Ordinary selection and background misses still go through real R3F picking.
    scene.target.emit('pointerdown');
    scene.target.emit('pointerup');
    scene.target.emit('click');
    assert.equal(scene.counts().clicks, 1, 'Removing wheel picking must preserve model selection');
    const outside = { offsetX: 1000, clientX: 1000 };
    scene.target.emit('pointerdown', outside);
    scene.target.emit('pointerup', outside);
    scene.target.emit('click', outside);
    assert.equal(scene.counts().misses, 1, 'Background selection misses must still be delivered');
    assert(scene.counts().raycasts >= 6);
    scene.dispose();
    assert([...scene.target.listeners.values()].every((listeners) => listeners.size === 0), 'Unmount must remove listeners');
  }

  const viewport = await readFile(new URL('../src/engine/viewport/ViewportCanvas.tsx', import.meta.url), 'utf8');
  assert.match(viewport, /<Canvas\s[\s\S]*?events=\{createViewportEvents\}/, 'The live viewport must use the tested event manager');
  // Wheel is exclusively camera navigation in this canvas. A future 3D wheel
  // feature must explicitly revise this contract, not silently lose its input.
  const sceneSource = await readFile(new URL('../src/engine/viewport/SceneRoot.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(sceneSource, /onWheel\s*=/);
  console.log('Viewport wheel regression passed: 1021 -> 0 picks; perspective/orthographic zoom, click, miss and cleanup preserved.');
} finally {
  await server.close();
  if (originalHTMLElement === undefined) delete globalThis.HTMLElement;
  else globalThis.HTMLElement = originalHTMLElement;
}
