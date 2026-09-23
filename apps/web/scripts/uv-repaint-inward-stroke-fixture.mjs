import * as THREE from 'three';
import { UvRepaint, createUvRepaintSourceMaterial } from '../src/engine/localRepaint/uvRepaint.ts';

const check = (condition, message) => { if (!condition) throw Error(message); };
/* global createImageBitmap */
export async function run(resolution = 2048, feather = 0) {
  const renderer = new THREE.WebGLRenderer({ antialias: false });
  renderer.setSize(256, 256);
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
  camera.position.z = 2; camera.updateMatrixWorld();
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.MeshBasicMaterial());
  mesh.updateMatrixWorld();
  const source = new THREE.ShaderMaterial({
    uniforms: { transparentProjectionOnly: { value: 1 } },
    vertexShader: 'void main(){gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}',
    fragmentShader: 'void main(){gl_FragColor=vec4(0.5,0.5,0.5,1.0);}',
  });
  const material = createUvRepaintSourceMaterial(source);
  const engine = new UvRepaint(renderer, [mesh], resolution);
  await engine.prepare(material, camera);
  // CSS viewport stays 2K while UV resolution varies: the on-model footprint
  // must not change with atlas resolution. No generation mask participates.
  const stamp = async (erase = false, radius = 64, to = new THREE.Vector2(.6, .5)) => {
    engine.begin();
    engine.stamp({ camera, from: new THREE.Vector2(.4, .5), to,
      viewport: new THREE.Vector2(2048, 2048), radius, feather, erase });
    const patches = await engine.end(); engine.publish(patches, 'after'); return patches;
  };
  const read = () => engine.canvas.getContext('2d').getImageData(0, 0, resolution, resolution).data;
  const first = await stamp();
  const pixels = read();
  let removed = 0, blended = 0, core = 0, oldWouldFail = 0, maxError = 0;
  const smooth = t => { t = Math.max(0, Math.min(1, t)); return t * t * (3 - 2 * t); };
  for (let y = 0; y < resolution; y++) for (let x = 0; x < resolution; x++) {
    const sx = (x + .5) * 2048 / resolution, sy = (y + .5) * 2048 / resolution;
    const distance = Math.hypot(sx - Math.max(.4 * 2048, Math.min(.6 * 2048, sx)), sy - 1024);
    const a = pixels[(y * resolution + x) * 4 + 3];
    // Independent oracle: solid core, linear outer ring, then 3px retreat.
    const blendWidth = Math.min(61 * .9, Math.max(16, 64 * feather));
    const expected = Math.round(255 * Math.max(0, Math.min(1, (61 - distance) / blendWidth)));
    if (Math.abs(Math.round(255 * smooth((61 - distance) / blendWidth)) - expected) > 1) oldWouldFail++;
    maxError = Math.max(maxError, Math.abs(a - expected));
    if (distance >= 61 && distance < 64) {
      check(a === 0, 'actual painted outline must retreat, even at feather=0'); removed++;
      const old = Math.round(255 * smooth((64 - distance) / Math.max(.0001, 64 * feather)));
      if (old !== a) oldWouldFail++;
    }
    if (a > 0 && a < 255) blended++;
    if (a === 255) core++;
  }
  check(maxError <= 1 && removed > 0 && blended > 0 && core > 0 && oldWouldFail > 0,
    `inward blend oracle: ${JSON.stringify({ resolution, feather, maxError, removed, blended, core, oldWouldFail })}`);
  // Max-alpha accumulation must not fill the retreated ring on repeated passes.
  await stamp(); check(read().every((v, i) => v === pixels[i]), 'repeated stroke accumulated the inset away');
  engine.publish(first, 'before', true); check(read().every(v => v === 0), 'undo must restore blank');
  engine.publish(first, 'after', true); check(read().every((v, i) => v === pixels[i]), 'redo changed alpha');
  const blob = await new Promise(resolve => engine.canvas.toBlob(resolve));
  const bitmap = await createImageBitmap(blob), copy = document.createElement('canvas');
  copy.width = copy.height = resolution;
  copy.getContext('2d').drawImage(bitmap, 0, 0); bitmap.close();
  const reopened = copy.getContext('2d').getImageData(0, 0, resolution, resolution).data;
  check(reopened.every((v, i) => v === pixels[i]), 'PNG/reopen changed persisted blend');
  const erase = await stamp(true, 12);
  const centreIndex = (Math.floor(resolution / 2) * resolution + Math.floor(resolution / 2)) * 4 + 3;
  const eraseWeight = distance => Math.max(0, Math.min(1,
    (12 - distance) / (12 * Math.max(.0001, Math.min(.9, feather)))));
  const eraseExpected = Math.round(pixels[centreIndex] * (1 - eraseWeight(1024 / resolution)));
  check(Math.abs(read()[centreIndex] - eraseExpected) <= 1,
    'eraser retains a solid centre even at 100% feather');
  const erased = read();
  for (let y = 0; y < resolution; y++) {
    const index = (y * resolution + Math.floor(resolution / 2)) * 4 + 3;
    const distance = Math.abs((y + .5) * 2048 / resolution - 1024);
    check(Math.abs(erased[index] - Math.round(pixels[index] * (1 - eraseWeight(distance)))) <= 1,
      'eraser outer feather must be linear');
  }
  engine.publish(erase, 'before', true);
  check(read().every((v, i) => v === pixels[i]), 'erase undo must restore inward blend exactly');
  // Very small brushes retain a usable centre rather than vanishing entirely.
  engine.publish(first, 'before', true);
  await stamp(false, 1.5, new THREE.Vector2(.6, .5));
  check(read().some((v, i) => i % 4 === 3 && v > 0), 'small brush disappeared');
  if (resolution === 2048 && feather === 0) {
    // This engine also draws selection/eraser masks. Neither may inherit the
    // colour-only retreat, otherwise selecting or clearing an edge regresses.
    const mask = new UvRepaint(renderer, [mesh], resolution);
    await mask.prepare(undefined, camera);
    const drawMask = async erase => {
      mask.begin(); mask.stamp({ camera, to: new THREE.Vector2(.5, .5),
        viewport: new THREE.Vector2(2048, 2048), radius: 64, feather: 0, erase });
      mask.publish(await mask.end(), 'after');
    };
    const edge = () => mask.canvas.getContext('2d').getImageData(1024, 1086, 1, 1).data[3];
    await drawMask(false); check(edge() === 255, 'selection mask inherited colour inset');
    mask.resetWhite(); await drawMask(true); check(edge() === 0, 'eraser inherited colour inset');
    mask.dispose();
  }
  engine.dispose(); material.dispose(); source.dispose(); mesh.geometry.dispose(); mesh.material.dispose(); renderer.dispose();
  return { resolution, feather, maxError, removed, blended, core, oldWouldFail, historyAndPngExact: true };
}
