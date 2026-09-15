import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { events } from '@react-three/fiber';
import * as THREE from 'three';
import { createServer } from 'vite';
import ts from 'typescript';

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
const originalRaf = globalThis.requestAnimationFrame;
globalThis.HTMLElement = InputTarget;
const frames = [];
globalThis.requestAnimationFrame = (callback) => frames.push(callback);
const server = await createServer({
  root: fileURLToPath(new URL('..', import.meta.url)),
  appType: 'custom', logLevel: 'silent', server: { middlewareMode: true, watch: { ignored: () => true } },
});
try {
  const { createViewportEvents, setViewportPaintPointer, isViewportNavigationPointer } = await server.ssrLoadModule('/src/engine/viewport/viewportEvents.ts');
  const { BlenderOrbitControls } = await server.ssrLoadModule('/src/engine/viewport/BlenderOrbitControls.ts');
  {
    const target = new InputTarget();
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
    camera.position.set(0, 0, 5);
    camera.updateMatrixWorld();
    const controls = new BlenderOrbitControls(camera, target);
    const initialPosition = camera.position.clone();
    const initialTarget = controls.target.clone();

    target.emit('pointerdown', { pointerId: 10, button: 0, clientX: 20, clientY: 20 });
    target.emit('pointermove', { pointerId: 10, button: 0, buttons: 1, clientX: 70, clientY: 50 });
    target.emit('pointerup', { pointerId: 10, button: 0, clientX: 70, clientY: 50 });
    assert(camera.position.equals(initialPosition), 'LMB drag must not navigate the camera');
    assert(controls.target.equals(initialTarget), 'LMB remains available exclusively to paint/select');

    target.emit('pointerdown', { pointerId: 11, button: 1, altKey: true, ctrlKey: true, clientX: 20, clientY: 20 });
    target.emit('pointermove', { pointerId: 11, button: 1, buttons: 4, altKey: true, ctrlKey: true, clientX: 45, clientY: 35 });
    target.emit('pointerup', { pointerId: 11, button: 1, clientX: 45, clientY: 35 });
    const pannedPosition = camera.position.clone();
    const pannedTarget = controls.target.clone();
    assert(!pannedTarget.equals(initialTarget), 'Alt+MMB drag must pan even when Ctrl/Cmd is pressed');
    assert(pannedPosition.clone().sub(pannedTarget).equals(initialPosition.clone().sub(initialTarget)), 'Pan must preserve camera distance and direction');

    target.emit('pointerdown', { pointerId: 12, button: 0, altKey: true, clientX: 20, clientY: 20 });
    target.emit('pointermove', { pointerId: 12, button: 0, altKey: true, buttons: 1, clientX: 65, clientY: 40 });
    target.emit('pointerup', { pointerId: 12, button: 0, altKey: true, clientX: 65, clientY: 40 });
    assert(!camera.position.equals(pannedPosition), 'Alt+LMB drag must orbit the camera');
    assert(controls.target.equals(pannedTarget), 'Orbit must preserve the navigation target');
    const contextMenu = target.emit('contextmenu', { button: 2 });
    assert(contextMenu.defaultPrevented, 'Navigation must suppress the browser context menu');
    controls.dispose();
  }
  for (const orthographic of [false, true]) {
    const input = new InputTarget();
    const camera = orthographic ? new THREE.OrthographicCamera(-1,1,1,-1,.1,100)
      : new THREE.PerspectiveCamera(45,1,.1,100);
    camera.position.z=5; camera.updateMatrixWorld();
    const controls = new BlenderOrbitControls(camera,input);
    for (const button of [0,1,2]) {
      const initial=camera.position.clone();
      input.emit('pointerdown',{button,clientX:0,clientY:0});
      input.emit('pointermove',{clientX:30,clientY:20});
      input.emit('pointerup',{button});
      assert(camera.position.equals(initial));
      assert.equal(camera.zoom,1, 'Unmodified drags do not navigate');
    }
    const target=controls.target.clone(), rotation=camera.quaternion.clone();
    input.emit('pointerdown',{button:2,altKey:true,clientX:0,clientY:0});
    input.emit('pointermove',{clientX:50,clientY:0,altKey:false});
    assert(orthographic ? camera.zoom<1 : camera.position.distanceTo(target)>5, 'Alt+RMB must dolly even after Alt is released');
    assert(camera.quaternion.angleTo(rotation)<1e-7); assert(controls.target.equals(target));
    input.emit('pointercancel');
    const position=camera.position.clone(), zoom=camera.zoom;
    input.emit('pointermove',{clientX:80,clientY:50});
    assert(camera.position.equals(position)); assert.equal(camera.zoom,zoom);
    input.emit('pointerdown',{button:2,altKey:true});
    input.emit('pointermove',{clientX:-100000,clientY:-100000});
    input.emit('pointermove',{clientX:-200000,clientY:-200000});
    input.emit('pointermove',{clientX:-300000,clientY:-300000});
    if(orthographic) assert(camera.zoom<=10000 && camera.zoom>=.01);
    else assert(camera.position.distanceTo(target)>=controls.minDistance-1e-8);
    input.emit('lostpointercapture');
    input.emit('pointerdown',{button:0,altKey:true});
    assert(input.hasPointerCapture(1));
    controls.dispose(); assert(!input.hasPointerCapture(1));
  }
  for(const button of [0,1,2]) {
    const navigation=makeScene(createViewportEvents);
    navigation.mesh.__r3f.handlers.onPointerMove = () => {};
    // The modifier is pressed before the mouse contact. R3F must not perform
    // a cold model pick on that first hover, or on the next held-Alt hover.
    for (let i=0;i<120;i++) navigation.target.emit('pointermove',{altKey:true,buttons:0});
    assert.equal(navigation.counts().raycasts,0,'Held Alt before contact must not raycast');
    for(const type of ['pointerdown','pointermove','pointerup','click','dblclick','contextmenu'])
      navigation.target.emit(type,{button,buttons:type==='pointermove' ? [1,4,2][button] : 0,altKey:type==='pointerdown'});
    assert.equal(navigation.counts().raycasts,0,'Alt navigation and released-modifier tails do not pick/select');
    navigation.mesh.__r3f.handlers.onPointerMove = () => {};
    navigation.target.emit('pointermove',{buttons:0});
    assert.equal(navigation.counts().raycasts,1,'Hover resumes when navigation buttons lift');
    setViewportPaintPointer(navigation.target,42);
    navigation.target.emit('pointerup',{pointerId:42});
    navigation.target.emit('click',{pointerId:42});
    assert.equal(navigation.counts().raycasts,1,'A new pen paint contact supersedes the old mouse navigation tail');
    setViewportPaintPointer(navigation.target);
    navigation.target.emit('pointerdown'); navigation.target.emit('pointerup'); navigation.target.emit('click');
    assert.equal(navigation.counts().clicks,1,'Next ordinary selection recovers immediately');
    navigation.dispose();
  }
  // Reproduce a restored capture with tight clipping, then inspect actual NDC
  // depth while navigating. No geometry picking is needed to repair the planes.
  for (const orthographic of [false, true]) for (const gesture of ['wheel', 'orbit', 'pan', 'dolly']) {
    const input = new InputTarget();
    const camera = orthographic
      ? new THREE.OrthographicCamera(-1, 1, 1, -1, 2, 8)
      : new THREE.PerspectiveCamera(45, 1, 2, 8);
    camera.position.z = 5;
    camera.updateMatrixWorld();
    const controls = new BlenderOrbitControls(camera, input);
    const frozenCapture = camera.clone();
    const frozenProjection = frozenCapture.projectionMatrix.clone();
    controls.update();
    assert.equal(camera.near, 2, 'restoring a snapshot stays exact until user navigation');
    const frontPoint = () => new THREE.Vector3(0, 0, -0.02).applyMatrix4(camera.matrixWorld).project(camera);
    assert(frontPoint().z < -1, 'old capture planes reproduce missing nearby surfaces');
    if (gesture === 'wheel') {
      input.emit('wheel', { deltaY: -2000 });
      for (let i = 0; i < 300; i++) {
        controls.updateWheelTransition(1 / 60);
        assert(frontPoint().z >= -1 && frontPoint().z <= 1, 'nearby surfaces remain inside the clip range during zoom');
      }
      input.emit('wheel', { deltaY: 10000 });
      for (let i = 0; i < 300; i++) controls.updateWheelTransition(1 / 60);
    } else {
      const button = gesture === 'orbit' ? 0 : gesture === 'pan' ? 1 : 2;
      input.emit('pointerdown', { button, altKey: true });
      input.emit('pointermove', { button, clientX: 55, clientY: 55 });
      input.emit('pointerup', { button });
    }
    assert(frontPoint().z >= -1 && frontPoint().z <= 1);
    const focusDepth = controls.target.clone().project(camera).z;
    assert(focusDepth >= -1 && focusDepth <= 1, 'zooming out must not lose the focus to a capture far plane');
    assert(frozenCapture.projectionMatrix.equals(frozenProjection));
    assert.equal(frozenCapture.near, 2);
    assert.equal(frozenCapture.far, 8);
    controls.dispose();
  }
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
  const paintBaseline = makeScene(events);
  // The native brush consumes down/move before R3F sees them, but its up and
  // resulting click previously traversed every model even with no initial hit.
  for (let i = 0; i < 60; i++) {
    paintBaseline.target.emit('pointerup');
    paintBaseline.target.emit('click');
  }
  assert.equal(paintBaseline.counts().raycasts, 120);
  paintBaseline.dispose();
  const paint = makeScene(createViewportEvents);
  let nativeUps = 0;
  let nativeClicks = 0;
  const onNativeUp = () => { nativeUps += 1; };
  const onNativeClick = () => { nativeClicks += 1; };
  paint.target.addEventListener('pointerup', onNativeUp);
  paint.target.addEventListener('click', onNativeClick);
  for (let i = 0; i < 60; i++) {
    setViewportPaintPointer(paint.target, 1);
    paint.target.setPointerCapture(1);
    paint.target.releasePointerCapture(1);
    const up = paint.target.emit('pointerup');
    const click = paint.target.emit('click');
    assert(!up.defaultPrevented && !up.propagationStopped && !click.propagationStopped);
  }
  assert.equal(paint.counts().raycasts, 0, 'Owned strokes must not duplicate picking at up/click');
  assert.equal(nativeUps, 60, 'Native stroke finalization must still receive every up');
  assert.equal(nativeClicks, 60, 'Do not stop DOM observers');
  paint.target.emit('dblclick');
  paint.target.emit('contextmenu');
  const legacyClick = { type: 'click', target: paint.target, button: 0 };
  paint.manager.handlers.onClick(legacyClick);
  paint.manager.handlers.onContextMenu({ ...legacyClick, type: 'contextmenu', button: 2 });
  assert.equal(paint.counts().raycasts, 0, 'Both PointerEvent and legacy MouseEvent tails stay owned');
  paint.target.emit('pointerup', { pointerId: 9 });
  assert.equal(paint.counts().raycasts, 1, 'A different pointer is not suppressed');
  // Lost/cancel still run R3F cleanup, including captures owned by R3F itself.
  paint.state.internal.capturedMap.set(1, new Map());
  paint.target.emit('pointerup');
  assert.equal(paint.counts().raycasts, 2, 'Existing R3F capture must retain dispatch');
  paint.target.emit('lostpointercapture');
  while (frames.length) frames.shift()(0);
  assert.equal(paint.state.internal.capturedMap.has(1), false);
  paint.target.emit('pointercancel');
  // A tool switch alone cannot unclaim the already painted gesture's click.
  paint.target.emit('click');
  assert.equal(paint.counts().raycasts, 2);
  // The next native down clears ownership before touch/disabled/background
  // early exits. Exercise that exact production prefix, not a test policy copy.
  const downPrefix = viewport.match(/const handlePointerDown = \(event: globalThis.PointerEvent\) => \{\s*([\s\S]*?)if \(event.pointerType === 'touch'\) return;/)?.[1];
  assert(downPrefix);
  const resetAtDown = new Function('isPaintingRef', 'setViewportPaintPointer', 'canvas', downPrefix);
  resetAtDown({ current: true }, setViewportPaintPointer, paint.target);
  paint.target.emit('click');
  assert.equal(paint.counts().raycasts, 2, 'A secondary contact must not erase active ownership');
  resetAtDown({ current: false }, setViewportPaintPointer, paint.target);
  paint.target.emit('pointerdown');
  paint.target.emit('pointerup');
  paint.target.emit('click');
  assert.equal(paint.counts().clicks, 1, 'The next selection gesture must work immediately');
  assert.equal(paint.counts().raycasts, 5);
  const otherCanvas = makeScene(createViewportEvents);
  setViewportPaintPointer(paint.target, 1);
  otherCanvas.target.emit('pointerdown');
  otherCanvas.target.emit('pointerup');
  otherCanvas.target.emit('click');
  assert.equal(otherCanvas.counts().clicks, 1, 'Ownership is canvas-local');
  otherCanvas.dispose();
  paint.target.removeEventListener('pointerup', onNativeUp);
  paint.target.removeEventListener('click', onNativeClick);
  paint.dispose();
  assert([...paint.target.listeners.values()].every((listeners) => listeners.size === 0));
  assert.match(viewport, /if \(!result\) return;\s*setViewportPaintPointer\(canvas, event.pointerId\);/, 'Only a real consumed brush hit claims the gesture');
  assert.match(viewport, /activePointerIdRef.current = event.pointerId;\s*setViewportPaintPointer\(canvas, event.pointerId\);\s*try/, 'Recovered pen contact must rebind its pointer identity');
  assert.match(viewport, /pointerListenerGenerationRef.current !== listenerGeneration\) return;\s*setViewportPaintPointer\(canvas\);/, 'Final unmount clears ownership, effect replacement preserves it');
  assert.match(viewport, /<Canvas\s[\s\S]*?events=\{createViewportEvents\}/, 'The live viewport must use the tested event manager');
  const altGuard=viewport.match(/if \(event.altKey\) \{([\s\S]*?)\n {6}\}/)?.[0];
  const hoverStart = viewport.indexOf('    let hoverCursorFrame = 0;');
  const hoverEnd = viewport.indexOf('    // Both selection and generated', hoverStart);
  assert(hoverStart > 0 && hoverEnd > hoverStart);
  const hoverCode = ts.transpile(viewport.slice(hoverStart, hoverEnd));
  for (const button of [0, 1, 2]) {
    const nav = makeScene(createViewportEvents);
    nav.target.style = { cursor: 'none' };
    let picks = 0, frame;
    const paintRef = { current: false };
    const hover = new Function('window', 'canvas', 'isViewportNavigationPointer', 'cursorCircleRef', 'isPaintingRef', 'updateCursor',
      hoverCode + '; return scheduleHoverCursor;')({ requestAnimationFrame(callback) { frame = callback; return 1; }, cancelAnimationFrame() { frame = undefined; } },
      nav.target, isViewportNavigationPointer, { current: { setAttribute() {} } }, paintRef, () => { picks++; });
    const flush = () => { const callback = frame; frame = undefined; callback?.(); };
    hover({ pointerId: 1, buttons: 0, clientX: 10, clientY: 10 });
    nav.target.emit('pointerdown', { button, altKey: true });
    for (let i = 0; i < 200; i++) {
      hover({ pointerId: 1, buttons: [1,4,2][button], altKey: i < 100, clientX: i, clientY: i });
      flush();
    }
    assert.equal(picks, 0, 'Native brush hover must not pick during any Alt drag, including modifier release');
    nav.target.emit('pointerup', { button });
    hover({ pointerId: 1, buttons: 0, altKey: false, clientX: 50, clientY: 50 }); flush();
    assert.equal(picks, 1, 'Hover must resume on release');
    paintRef.current = true;
    hover({ pointerId: 1, buttons: 0, clientX: 50, clientY: 50 }); flush();
    assert.equal(picks, 1, 'Active painting remains owned by the stroke handler');
    nav.dispose();
  }
  assert(altGuard);
  const checkAltGuard=new Function('event','cursorCircleRef','canvas',altGuard+" return 'paint';");
  for(const button of [0,1,2]) {
    let hidden=false; const canvas={style:{cursor:'none'}};
    assert.equal(checkAltGuard({altKey:true,button},{current:{setAttribute:()=>{hidden=true;}}},canvas),undefined);
    assert(hidden); assert.equal(canvas.style.cursor,'');
    assert.equal(checkAltGuard({altKey:false,button},{},canvas),'paint');
  }
  assert(viewport.indexOf(altGuard)<viewport.indexOf('const rightModelEraseContact'), 'Alt exits before paint/erase dispatch');
  const transformSource = await readFile(new URL('../src/engine/viewport/ObjectTransformControls.tsx', import.meta.url), 'utf8');
  const transformGuard = transformSource.match(/useEffect\(\(\) => \{([\s\S]*?)\}, \[gl\]\);/)?.[1];
  assert(transformGuard);
  const attachGuard = new Function('controlsRef','draggingRef','gl','window',ts.transpile(transformGuard));
  for (const releaseType of ['pointerup','pointercancel','lostpointercapture']) {
    const canvas = new InputTarget(), win = new InputTarget();
    const control = {enabled:true}, dragging = {current:false};
    const cleanup = attachGuard({current:control},dragging,{domElement:canvas},win);
    canvas.emit('pointerdown',{altKey:false}); assert(control.enabled);
    dragging.current=true;
    canvas.emit('pointerdown',{altKey:true}); assert(control.enabled,'An existing object drag retains ownership');
    dragging.current=false;
    canvas.emit('pointerdown',{altKey:true}); assert.equal(control.enabled,false,'Alt contact disables native gizmo input');
    win.emit('pointerup',{pointerId:99}); assert.equal(control.enabled,false);
    (releaseType==='lostpointercapture' ? canvas : win).emit(releaseType,{altKey:false});
    assert(control.enabled,'Gizmo input recovers after released-modifier tails and cancellation');
    canvas.emit('pointerdown',{altKey:true}); cleanup(); assert(control.enabled);
    assert([...canvas.listeners.values(),...win.listeners.values()].every(listeners=>listeners.size===0));
  }
  assert.match(viewport, /const rightModelEraseContact =\s*event\.pointerType === 'mouse' && event\.button === 2 && Boolean\(result\);/, 'RMB erasing must require a model hit');
  assert.match(viewport, /const isPaintButton = event\.button === 0 \|\| penEraserContact \|\| rightModelEraseContact;/, 'Only a model-hit RMB may join the primary paint path');
  // Wheel is exclusively camera navigation in this canvas. A future 3D wheel
  // feature must explicitly revise this contract, not silently lose its input.
  const sceneSource = await readFile(new URL('../src/engine/viewport/SceneRoot.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(sceneSource, /onWheel\s*=/);
  console.log('Viewport wheel regression passed: 1021 -> 0 picks; perspective/orthographic zoom, click, miss and cleanup preserved.');
  console.log('Viewport buttons passed: Alt+LMB orbit, Alt+MMB pan, Alt+RMB dolly, plain paint/erase and wheel zoom.');
  console.log('Native paint tail regression passed: 60 strokes / 120 -> 0 redundant picks; DOM delivery, selection reset, canvas/pointer isolation and capture cleanup preserved.');
} finally {
  await server.close();
  if (originalHTMLElement === undefined) delete globalThis.HTMLElement;
  else globalThis.HTMLElement = originalHTMLElement;
  if (originalRaf === undefined) delete globalThis.requestAnimationFrame;
  else globalThis.requestAnimationFrame = originalRaf;
}
