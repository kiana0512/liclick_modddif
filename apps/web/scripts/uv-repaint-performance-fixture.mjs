import * as THREE from 'three';
import { UvRepaint } from '../src/engine/localRepaint/uvRepaint.ts';

export async function run() {
  const renderer = new THREE.WebGLRenderer();
  renderer.setSize(1024, 768);
  const camera = new THREE.PerspectiveCamera(45, 4 / 3, 0.1, 100);
  camera.position.z = 5;
  camera.updateMatrixWorld();
  const geometry = new THREE.PlaneGeometry(2, 2, 400, 400);
  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
  mesh.updateMatrixWorld();
  const material = new THREE.ShaderMaterial({
    vertexShader: 'void main(){gl_Position=vec4(uv*2.0-1.0,0.0,1.0);}',
    fragmentShader: 'void main(){gl_FragColor=vec4(0.2,0.4,0.1,1.0);}',
    side: THREE.DoubleSide,
  });
  const start = performance.now();
  const engine = new UvRepaint(renderer, [mesh], 4096);
  const constructMs = performance.now() - start;
  await engine.prepare(material, camera);
  const preparationMs = performance.now() - start;
  const samples = [];
  let patches = 0;
  for (let i = 0; i < 12; i++) {
    await new Promise((resolve) => window.requestAnimationFrame(resolve));
    engine.begin();
    const t = performance.now();
    engine.stamp({
      camera,
      to: new THREE.Vector2(0.43 + i * 0.012, 0.5),
      viewport: new THREE.Vector2(1024, 768),
      radius: 15,
      feather: 0.3,
      erase: false,
    });
    samples.push(performance.now() - t);
    const changes = await engine.end();
    patches += changes.length;
    engine.publish(changes, 'after');
  }
  samples.sort((a, b) => a - b);
  const result = {
    triangles: 320000,
    resolution: 4096,
    constructMs,
    preparationMs,
    stampCpuMedianMs: samples[6],
    stampCpuMaxMs: samples.at(-1),
    dirtyTiles: patches,
    scope: 'synthetic plane; command submission timing, not end-to-end FPS',
  };
  engine.dispose();
  geometry.dispose();
  mesh.material.dispose();
  material.dispose();
  renderer.dispose();
  return result;
}
