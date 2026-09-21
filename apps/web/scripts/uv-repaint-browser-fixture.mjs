import * as THREE from 'three';
import { UvRepaint, createUvRepaintSourceMaterial } from '../src/engine/localRepaint/uvRepaint.ts';
import { createProjectedLayerMaterial } from '../src/engine/projection/ProjectedLayerMaterial.ts';
import { serializeCamera } from '../src/engine/projection/ProjectionCamera.ts';
import { createUvRepaintSelectionCanvas } from '../src/engine/localRepaint/uvRepaintState.ts';
import { consumeSelectionMask } from '../src/engine/localRepaint/consumeSelectionMask.ts';

function check(value, message) {
  if (!value) throw Error(message);
}
function plane(x, z, u0, u1) {
  const geometry = new THREE.PlaneGeometry(0.8, 1.6);
  const uv = geometry.getAttribute('uv');
  for (let i = 0; i < uv.count; i++) uv.setX(i, u0 + uv.getX(i) * (u1 - u0));
  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
  mesh.position.set(x, 0, z);
  mesh.updateMatrixWorld(true);
  return mesh;
}
function pixel(canvas, u, v) {
  return [
    ...canvas
      .getContext('2d')
      .getImageData(Math.floor(u * canvas.width), Math.floor((1 - v) * canvas.height), 1, 1).data,
  ];
}
export async function run() {
  const renderer = new THREE.WebGLRenderer({ antialias: false });
  renderer.setSize(256, 256);
  const camera = new THREE.OrthographicCamera(-2, 2, 2, -2, 0.1, 20);
  camera.position.z = 5;
  camera.updateMatrixWorld();
  const left = plane(-0.5, 0, 0, 0.3),
    right = plane(0.5, 0, 0.35, 0.65),
    back = plane(-0.5, -0.2, 0.7, 1);
  const source = new THREE.ShaderMaterial({
    uniforms: { transparentProjectionOnly: { value: 1 } },
    vertexShader:
      'varying vec2 testUv; void main() { testUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader:
      'varying vec2 testUv; void main() { gl_FragColor = vec4(0.2, 0.1, 0.4, 0.75); }',
  });
  const bake = createUvRepaintSourceMaterial(source);
  const engine = new UvRepaint(renderer, [left, right, back], 1024);
  await engine.prepare(bake, camera);
  const stamp = async (from, to, radius = 20, erase = false, feather = 0) => {
    engine.begin();
    engine.stamp({
      camera,
      from,
      to,
      viewport: new THREE.Vector2(256, 256),
      radius,
      feather,
      erase,
    });
    const patches = await engine.end();
    engine.publish(patches, 'after');
    return patches;
  };
  const first = await stamp(undefined, new THREE.Vector2(0.375, 0.5));
  check(
    pixel(engine.canvas, 0.15, 0.5)[3] > 180,
    `visible left written: ${pixel(engine.canvas, 0.15, 0.5)} patches=${first.length}`,
  );
  check(pixel(engine.canvas, 0.5, 0.5)[3] === 0, 'disjoint surface unchanged');
  check(pixel(engine.canvas, 0.85, 0.5)[3] === 0, 'occluded back never written');
  check(pixel(engine.canvas, 0.15, 0.5)[0] > 120, 'linear source encoded to sRGB');
  engine.publish(first, 'before', true);
  check(pixel(engine.canvas, 0.15, 0.5)[3] === 0, 'undo restores blank coverage');
  engine.publish(first, 'after', true);
  await stamp(new THREE.Vector2(0.375, 0.5), new THREE.Vector2(0.625, 0.5), 25);
  check(
    pixel(engine.canvas, 0.5, 0.5)[3] > 180,
    'large/continuous brush touches both visible surfaces',
  );
  check(pixel(engine.canvas, 0.85, 0.5)[3] === 0, 'large brush still rejects occluded surface');
  const beforeColor = pixel(engine.canvas, 0.15, 0.5);
  await stamp(undefined, new THREE.Vector2(0.375, 0.5), 20, true);
  check(pixel(engine.canvas, 0.15, 0.5)[3] === 0, 'eraser changes alpha');
  await stamp(undefined, new THREE.Vector2(0.375, 0.5));
  check(
    pixel(engine.canvas, 0.15, 0.5).every((v, i) => Math.abs(v - beforeColor[i]) <= 1),
    'reapply restores exact color/alpha',
  );
  camera.position.set(0, 0, -5);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  await stamp(undefined, new THREE.Vector2(0.625, 0.5));
  check(
    pixel(engine.canvas, 0.85, 0.5)[3] > 180,
    'rotated camera paints newly visible UV, not old capture coordinates',
  );
  await (await import('./uv-repaint-overlap-fixture.mjs')).run(renderer);
  const visibility = await (await import('./uv-repaint-visibility-fixture.mjs')).run(renderer);
  for (const problem of ['missing', 'outside', 'degenerate']) {
    const invalid = plane(0, 0, 0, 1);
    if (problem === 'missing') invalid.geometry.deleteAttribute('uv');
    else {
      const uv = invalid.geometry.getAttribute('uv');
      if (problem === 'outside') uv.setX(0, 2);
      else for (let i = 0; i < uv.count; i++) uv.setXY(i, 0, 0);
    }
    let refused = false;
    try { new UvRepaint(renderer, [invalid], 1024).dispose(); }
    catch (error) { refused = /UV/.test(error.message); }
    check(refused, `invalid UV rejected: ${problem}`);
    invalid.geometry.dispose();
    invalid.material.dispose();
  }
  camera.position.set(0, 0, 5);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  const rail = plane(0, 0, 0, 0.3);
  rail.scale.x = 0.2;
  const panel = plane(0, -0.2, 0.5, 1);
  const holes = new UvRepaint(renderer, [rail, panel], 1024);
  await holes.prepare(bake, camera);
  holes.begin();
  holes.stamp({
    camera,
    to: new THREE.Vector2(0.5, 0.5),
    viewport: new THREE.Vector2(256, 256),
    radius: 35,
    feather: 0,
    erase: false,
  });
  const holePatches = await holes.end();
  holes.publish(holePatches, 'after');
  check(pixel(holes.canvas, 0.15, 0.5)[3] > 180, 'rail painted');
  check(pixel(holes.canvas, 0.75, 0.5)[3] === 0, 'panel directly behind rail remains untouched');
  check(
    pixel(holes.canvas, 0.875, 0.5)[3] > 180,
    'panel visible through hole is painted by the same large brush',
  );
  const reloaded = new UvRepaint(renderer, [rail, panel], 1024);
  await reloaded.prepare(bake, camera, holes.canvas);
  reloaded.begin();
  reloaded.stamp({
    camera,
    to: new THREE.Vector2(0.5, 0.5),
    viewport: new THREE.Vector2(256, 256),
    radius: 35,
    feather: 0,
    erase: false,
  });
  const reloadPatches = await reloaded.end();
  let reloadDelta = 0;
  let example;
  for (const patch of reloadPatches)
    for (let i = 0; i < patch.after.length; i++) {
      const alpha = i - (i % 4) + 3;
      if (i % 4 !== 3 && patch.before[alpha] === 0 && patch.after[alpha] === 0) continue; // Canvas canonicalizes invisible RGB.
      const delta =
        Math.abs(patch.after[i] - patch.before[i]) *
        (i % 4 === 3 ? 1 : Math.max(patch.before[alpha], patch.after[alpha]) / 255);
      if (delta > reloadDelta) {
        reloadDelta = delta;
        const p = i - (i % 4);
        example = [
          patch.bounds,
          i % 4,
          [...patch.before.slice(p, p + 4)],
          [...patch.after.slice(p, p + 4)],
        ];
      }
    }
  check(
    reloadDelta <= 1,
    `reloaded UV GPU pixels remain equivalent after Canvas alpha quantization: ${reloadDelta} ${example}`,
  );
  reloaded.dispose();
  holes.dispose();
  for (const mesh of [rail, panel]) {
    mesh.geometry.dispose();
    mesh.material.dispose();
  }
  // The actual production shader must compile through the UV wrapper too.
  camera.position.set(0, 0, 5);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 32;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#c88431';
  ctx.fillRect(0, 0, 32, 32);
  const projected = await createProjectedLayerMaterial({
    layerId: 'fixture',
    imageUrl: canvas.toDataURL(),
    camera: serializeCamera(camera, 1, new THREE.Vector3()),
    transparentProjectionOnly: true,
    visible: true,
    opacity: 1,
    strength: 1,
    useDepthCheck: false,
    useNormalCheck: false,
    useMask: false,
    ignoreSourceAlpha: false,
  });
  const actualBake = createUvRepaintSourceMaterial(projected);
  const actual = new UvRepaint(renderer, [right], 1024);
  await actual.prepare(actualBake, camera);
  actual.begin();
  actual.stamp({
    camera,
    to: new THREE.Vector2(0.625, 0.5),
    viewport: new THREE.Vector2(256, 256),
    radius: 30,
    feather: 0,
    erase: false,
  });
  const actualPatches = await actual.end();
  actual.publish(actualPatches, 'after');
  check(actualPatches.length > 0, 'production material emits UV source pixels');
  const actualColor = pixel(actual.canvas, 0.5, 0.5);
  check(
    actualColor.every((value, i) => Math.abs(value - [200, 132, 49, 255][i]) <= 1),
    `production color round trip: ${actualColor}`,
  );
  const selection = new THREE.WebGLRenderTarget(1024, 1024);
  renderer.setRenderTarget(selection);
  renderer.setClearColor(0xffffff, 1);
  renderer.clear();
  renderer.setRenderTarget(null);
  const selectionStroke = createUvRepaintSelectionCanvas(actualPatches, 1024);
  // Feathered color coverage must fully consume selection, not leave 90% red.
  const selectionContext = selectionStroke.getContext('2d');
  selectionContext.globalCompositeOperation = 'destination-in';
  selectionContext.fillStyle = 'rgba(255,255,255,0.1)';
  selectionContext.fillRect(0, 0, 1024, 1024);
  consumeSelectionMask({
    renderer,
    camera,
    meshes: [left, right, back],
    material: projected,
    stroke: selectionStroke,
    strokeSpace: 'uv',
    target: selection,
    inverted: false,
  });
  const sample = new Uint8Array(4);
  renderer.readRenderTargetPixels(selection, 512, 512, 1, 1, sample);
  check(
    sample[0] < 2 && sample[1] === 255,
    `native selection clears only painted sided coverage: ${sample}`,
  );
  renderer.readRenderTargetPixels(selection, 154, 512, 1, 1, sample);
  check(sample[0] === 255, 'unpainted selection untouched');
  selection.dispose();
  // Frozen source alpha and author mask still constrain the full UV bake.
  const empty = document.createElement('canvas');
  empty.width = empty.height = 32;
  const emptyMap = new THREE.CanvasTexture(empty);
  emptyMap.flipY = false;
  const originalMap = actualBake.uniforms.projectedMap.value;
  for (const mode of ['source-alpha', 'author-mask']) {
    actualBake.uniforms.projectedMap.value = mode === 'source-alpha' ? emptyMap : originalMap;
    actualBake.uniforms.maskMap.value = emptyMap;
    actualBake.uniforms.useMask.value = mode === 'author-mask' ? 1 : 0;
    const clipped = new UvRepaint(renderer, [right], 1024);
    await clipped.prepare(actualBake, camera);
    clipped.begin();
    clipped.stamp({ camera, to: new THREE.Vector2(0.625, 0.5), viewport: new THREE.Vector2(256, 256), radius: 80, feather: 0, erase: false });
    check((await clipped.end()).length === 0, `${mode} excludes invalid source pixels`);
    clipped.dispose();
  }
  emptyMap.dispose();
  actual.dispose();
  actualBake.dispose();
  projected.dispose();
  engine.dispose();
  bake.dispose();
  source.dispose();
  for (const mesh of [left, right, back]) {
    mesh.geometry.dispose();
    mesh.material.dispose();
  }
  renderer.dispose();
  return {
    passed: true,
    ...visibility,
    checks:
      'visible/occluded/disjoint/large brush/camera rotation/undo/redo/erase/invalid UV/source alpha/author mask/sRGB/production shader',
    patches: first.length,
  };
}
