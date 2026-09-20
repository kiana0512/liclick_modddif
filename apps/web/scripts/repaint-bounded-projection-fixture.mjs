import * as THREE from 'three';
import { UvRepaint, createUvRepaintSourceMaterial } from '../src/engine/localRepaint/uvRepaint.ts';
import { createProjectedLayerMaterial } from '../src/engine/projection/ProjectedLayerMaterial.ts';
import { serializeCamera } from '../src/engine/projection/ProjectionCamera.ts';
import { createBoundedRepaintFalloffPixels, createManualRepaintFalloffPixels } from '../src/engine/localRepaint/inwardCrossfadeMask.ts';
import { createLocalRepaintFalloffInWorker } from '../src/engine/localRepaint/falloffWorker.ts';

/* global createImageBitmap */

function canvas(size, pixel) {
  const c = document.createElement('canvas'); c.width = c.height = size;
  const ctx = c.getContext('2d'), data = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) data.data.set(pixel(x, y), (y * size + x) * 4);
  ctx.putImageData(data, 0, 0); return c;
}
function assert(condition, message) { if (!condition) throw Error(message); }
function legacyMaterial(projected) {
  const material = createUvRepaintSourceMaterial(projected);
  // Frozen old texture2D calls: only the capture sampling differs.
  material.fragmentShader = material.fragmentShader
    .replace('rS(projectedMap, uv)', 'texture2D(projectedMap, uv)')
    .replace('rM(maskMap, maskUv)', 'texture2D(maskMap, maskUv)');
  return material;
}

export async function run() {
  const mask = canvas(128, (x, y) => [255, 255, 255,
    x > 24 && x < 105 && y > 20 && y < 108 && !(x > 54 && x < 74 && y > 48 && y < 80) ? 255 : 0]);
  const ctx = mask.getContext('2d'), original = ctx.getImageData(0, 0, 128, 128);
  const cpu = createBoundedRepaintFalloffPixels(original);
  let partial = 0, core = 0;
  for (let i = 0; i < cpu.length; i += 4) {
    if (!original.data[i + 3]) assert(cpu[i + 3] === 0, 'Outside author selection or hole has alpha');
    if (cpu[i + 3] === 255) core++;
    if (cpu[i + 3] > 0 && cpu[i + 3] < 255) partial++;
  }
  assert(core > 0 && partial > 0, 'Need opaque core and inward feather');

  const manualMask = canvas(128, x => [255, 255, 255, x >= 60 && x < 68 ? 255 : 0]);
  const manualContext = manualMask.getContext('2d');
  const manualInput = manualContext.getImageData(0, 0, 128, 128);
  const manualCpu = createManualRepaintFalloffPixels(manualInput);
  const manualWorker = await createLocalRepaintFalloffInWorker({ mask: manualMask, width: 128, height: 128 });
  manualContext.clearRect(0, 0, 128, 128);
  manualContext.drawImage(manualWorker.bitmap, 0, 0); manualWorker.bitmap.close();
  const manualPixels = manualContext.getImageData(0, 0, 128, 128).data;
  assert(manualCpu.every((v, i) => i % 4 !== 3 || v === manualPixels[i]), 'Manual Worker/CPU alpha differs');
  assert(manualPixels[(64 * 128 + 40) * 4 + 3] > 0, 'Manual paint outside selection blocked');

  const renderer = new THREE.WebGLRenderer({ antialias: false }); renderer.setSize(256, 256);
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
  camera.position.z = 3; camera.updateMatrixWorld(true);
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2, 8, 8)); mesh.updateMatrixWorld(true);
  // Deliberately unaligned with the 8px minification footprint: the old mip
  // spills alpha into texels whose capture-space center is outside coverage.
  const inside = x => x >= 518 && x < 1530;
  const cases = [
    { name: 'source-alpha', image: canvas(2048, x => [128, 128, 128, inside(x) ? 255 : 0]), mask: canvas(2048, () => [255, 255, 255, 255]) },
    { name: 'author-mask', image: canvas(2048, () => [128, 128, 128, 255]), mask: canvas(2048, x => [255, 255, 255, inside(x) ? 255 : 0]) },
    { name: 'manual-outside-selection', image: canvas(2048, x => [128, 128, 128, inside(x) ? 255 : 0]), mask: manualMask },
  ];
  const rows = [];
  for (const item of cases) {
    const projected = await createProjectedLayerMaterial({
      layerId: 'bounded-probe', imageUrl: item.image.toDataURL(), maskUrl: item.mask.toDataURL(),
      camera: serializeCamera(camera, 1, new THREE.Vector3()), opacity: 1, visible: true,
      ignoreSourceAlpha: false, useMask: true, transparentProjectionOnly: true,
      projectionVisibilityPolicy: 'surface-locked-v1', minimumProjectionFacing: 0.08,
      previewLighting: { enabled: false, exposure: 1, ambientIntensity: 1, keyLightIntensity: 0, keyLightDirection: [0, 0, 1] },
    });
    for (const curved of [false, true]) for (const legacy of [true, false]) for (const degrees of [0, 45]) {
      mesh.geometry.dispose();
      mesh.geometry = curved ? new THREE.CylinderGeometry(.9, .9, 1.6, 64, 4, true) : new THREE.PlaneGeometry(2, 2, 8, 8);
      const view = new THREE.PerspectiveCamera(45, 1, 0.1, 10);
      const radians = degrees * Math.PI / 180;
      view.position.set(3 * Math.sin(radians), 0, 3 * Math.cos(radians)); view.lookAt(0, 0, 0); view.updateMatrixWorld(true);
      const material = (legacy ? legacyMaterial : createUvRepaintSourceMaterial)(projected);
      const engine = new UvRepaint(renderer, [mesh], 256); await engine.prepare(material, view);
      engine.begin(); engine.stamp({ camera: view, to: new THREE.Vector2(.5, .5), viewport: new THREE.Vector2(256, 256), radius: 1000, feather: 0, erase: false });
      const patches = await engine.end(); engine.publish(patches, 'after');
      const data = engine.canvas.getContext('2d').getImageData(0, 0, 256, 256).data;
      let outside = 0, dark = 0, opaque = 0, manualOutsideSelection = 0;
      for (let y = 8; y < 248; y++) for (let x = 8; x < 248; x++) {
        const i = (y * 256 + x) * 4;
        const u = (x + .5) / 256, segment = u * 64, left = Math.floor(segment), f = segment - left;
        const worldX = .9 * ((1 - f) * Math.sin(left / 64 * Math.PI * 2) + f * Math.sin((left + 1) / 64 * Math.PI * 2));
        const captureX = curved ? (worldX * .5 + .5) * 2048 : (x + .5) * 8;
        if (!inside(captureX) && data[i + 3] > 0) outside++;
        if (data[i + 3] > 20 && data[i] < 126) dark++;
        if (data[i + 3] > 250) opaque++;
        if (captureX > 650 && captureX < 750 && data[i + 3] > 0) manualOutsideSelection++;
      }
      rows.push({ name: item.name, curved, legacy, degrees, outside, dark, opaque, manualOutsideSelection });
      if (!legacy) {
        assert(outside === 0, `${item.name}: alpha leaked beyond native coverage`);
        assert(dark === 0 && opaque > 1000, `${item.name}: edge darkening or empty paint`);
        if (item.name === 'manual-outside-selection') assert(manualOutsideSelection > 0, 'Manual stroke outside author selection absent');
        // Readback/history and the PNG asset used by save/export retain the same pixels.
        engine.publish(patches, 'before');
        assert(engine.canvas.getContext('2d').getImageData(0, 0, 256, 256).data.every(v => v === 0), 'Undo changed blank layer');
        engine.publish(patches, 'after');
        const blob = await new Promise(resolve => engine.canvas.toBlob(resolve));
        const reopened = await createImageBitmap(blob), copy = canvas(256, () => [0, 0, 0, 0]);
        copy.getContext('2d').drawImage(reopened, 0, 0); reopened.close();
        const saved = copy.getContext('2d').getImageData(0, 0, 256, 256).data;
        assert(data.every((v, i) => v === saved[i]), 'PNG/redo changed pixels');
      }
      engine.dispose(); material.dispose();
    }
    projected.dispose();
  }
  // A small real brush stroke wholly outside the author strip must feather at
  // its own outline, not at the unrelated generation-mask boundary.
  mesh.geometry.dispose(); mesh.geometry = new THREE.PlaneGeometry(2, 2, 8, 8);
  const projected = await createProjectedLayerMaterial({
    layerId: 'manual-stroke-boundary', imageUrl: canvas(128, () => [128, 128, 128, 255]).toDataURL(),
    maskUrl: manualMask.toDataURL(), camera: serializeCamera(camera, 1, new THREE.Vector3()),
    opacity: 1, visible: true, ignoreSourceAlpha: false, useMask: true, transparentProjectionOnly: true,
    previewLighting: { enabled: false, exposure: 1, ambientIntensity: 1, keyLightIntensity: 0, keyLightDirection: [0, 0, 1] },
  });
  const material = createUvRepaintSourceMaterial(projected);
  const engine = new UvRepaint(renderer, [mesh], 256); await engine.prepare(material, camera);
  engine.begin(); engine.stamp({ camera, to: new THREE.Vector2(.25, .5), viewport: new THREE.Vector2(256, 256), radius: 24, feather: .45, erase: false });
  engine.publish(await engine.end(), 'after');
  const pixels = engine.canvas.getContext('2d').getImageData(0, 0, 256, 256).data;
  let strokeCore = 0, strokeFeather = 0;
  for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) {
    const alpha = pixels[(y * 256 + x) * 4 + 3];
    const distance = Math.hypot(x + .5 - 64, y + .5 - 128);
    if (distance >= 24) assert(alpha === 0, 'Paint escaped actual brush boundary');
    if (alpha === 255) strokeCore++;
    if (alpha > 0 && alpha < 255) strokeFeather++;
  }
  assert(strokeCore > 100 && strokeFeather > 100, 'Actual stroke needs opaque core and inward feather outside author mask');
  engine.dispose(); material.dispose(); projected.dispose();
  renderer.dispose(); mesh.geometry.dispose();
  assert(rows.some(row => row.legacy && row.outside > 0), 'Negative control did not reproduce spill');
  assert(rows.some(row => row.legacy && row.dark > 0), 'Negative control did not reproduce darkening');
  return { ok: true, core, partial, strokeCore, strokeFeather, rows };
}
