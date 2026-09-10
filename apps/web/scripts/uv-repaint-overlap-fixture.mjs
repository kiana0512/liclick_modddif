import * as THREE from 'three';
import { UvRepaint, createUvRepaintSourceMaterial } from '../src/engine/localRepaint/uvRepaint.ts';

function check(value, message) {
  if (!value) throw Error(`Shared UV: ${message}`);
}
function sample(engine) {
  return [...engine.canvas.getContext('2d').getImageData(512, 512, 1, 1).data];
}
function plane(x, z = 0) {
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(0.8, 1.6), new THREE.MeshBasicMaterial());
  mesh.position.set(x, 0, z);
  mesh.updateMatrixWorld();
  return mesh;
}
export async function run(renderer) {
  const camera = new THREE.OrthographicCamera(-2, 2, 2, -2, 0.1, 20);
  camera.position.z = 5;
  camera.updateMatrixWorld();
  const left = plane(-0.5),
    right = plane(0.5),
    hidden = plane(-0.5, -0.2);
  const source = new THREE.ShaderMaterial({
    uniforms: { transparentProjectionOnly: { value: 1 } },
    vertexShader: `varying vec3 capturedPosition;
      void main() { capturedPosition = (modelMatrix * vec4(position, 1.0)).xyz;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `varying vec3 capturedPosition;
      void main() { gl_FragColor = vec4(capturedPosition.z < -0.1 ? vec3(0.,0.,1.) :
        (capturedPosition.x < 0. ? vec3(1.,0.,0.) : vec3(0.,1.,0.)), 1.); }`,
  });
  const material = createUvRepaintSourceMaterial(source);
  const paint = async (engine, x, radius = 20, erase = false, feather = 0) => {
    engine.begin();
    engine.stamp({
      camera,
      to: new THREE.Vector2(x, 0.5),
      viewport: new THREE.Vector2(256, 256),
      radius,
      erase,
      feather,
    });
    const patches = await engine.end();
    engine.publish(patches, 'after');
    return patches;
  };
  const engine = new UvRepaint(renderer, [left, right, hidden], 1024);
  await engine.prepare(material, camera);
  await paint(engine, 0.375);
  check(
    sample(engine).join() === '255,0,0,255',
    'visible left supplies red, hidden/shared right cannot overwrite',
  );
  const green = await paint(engine, 0.625);
  check(
    sample(engine).join() === '0,255,0,255',
    'painting right replaces shared pixel with right source color',
  );
  engine.publish(green, 'before', true);
  check(sample(engine).join() === '255,0,0,255', 'undo restores shared red');
  engine.publish(green, 'after', true);
  check(sample(engine).join() === '0,255,0,255', 'redo restores shared green');
  await paint(engine, 0.375, 100, false, 1);
  check(
    sample(engine)[0] === 255 && sample(engine)[1] === 0,
    'stronger left hit wins over later weaker right',
  );
  await paint(engine, 0.625, 100, false, 1);
  check(
    sample(engine)[1] === 255 && sample(engine)[0] === 0,
    'stronger right hit wins in the opposite direction',
  );
  const png = new window.Image();
  png.src = engine.canvas.toDataURL();
  await png.decode();
  const restored = new UvRepaint(renderer, [left, right, hidden], 1024);
  await restored.prepare(material, camera, png);
  check(sample(restored).join() === sample(engine).join(), 'PNG reload preserves shared RGBA');
  const reference = new UvRepaint(renderer, [left], 1024);
  await reference.prepare(material, camera, png);
  await paint(restored, 0.5, 100, true, 1);
  await paint(reference, 0.5, 100, true, 1);
  check(
    Math.abs(sample(restored)[3] - sample(reference)[3]) <= 1,
    `shared soft erase applies once, not per surface: ${sample(restored)} vs ${sample(reference)}`,
  );
  await paint(restored, 0.625, 20, true);
  check(sample(restored)[3] === 0, 'eraser through either shared surface clears same pixel');
  // Partial/mirrored overlap inside a single mesh, not only duplicated mesh UVs.
  const combined = new THREE.BufferGeometry();
  const pieces = [left, right].map((mesh) =>
    mesh.geometry.toNonIndexed().applyMatrix4(mesh.matrixWorld),
  );
  for (const name of ['position', 'normal', 'uv']) {
    const arrays = pieces.map((geometry) => geometry.getAttribute(name).array);
    const data = new Float32Array(arrays[0].length + arrays[1].length);
    data.set(arrays[0]);
    data.set(arrays[1], arrays[0].length);
    if (name === 'uv')
      for (let i = arrays[0].length; i < data.length; i += 2) data[i] = 1 - data[i] * 0.75;
    combined.setAttribute(name, new THREE.BufferAttribute(data, name === 'uv' ? 2 : 3));
  }
  const joined = new THREE.Mesh(combined, new THREE.MeshBasicMaterial());
  joined.updateMatrixWorld();
  const partial = new UvRepaint(renderer, [joined], 1024);
  await partial.prepare(material, camera);
  await paint(partial, 0.375, 100);
  check(sample(partial)[0] === 255, 'single-mesh mirrored overlap accepts paint');
  const equalFirst = sample(partial).join();
  await paint(partial, 0.375, 100);
  check(sample(partial).join() === equalFirst, 'equal-weight winner is stable');
  for (const item of [engine, restored, reference, partial]) item.dispose();
  for (const mesh of [left, right, hidden, joined]) {
    mesh.geometry.dispose();
    mesh.material.dispose();
  }
  pieces.forEach((geometry) => geometry.dispose());
  material.dispose();
  source.dispose();
}
