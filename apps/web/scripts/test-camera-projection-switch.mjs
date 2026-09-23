import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { createServer } from 'vite';

const server = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)),
  appType: 'custom', logLevel: 'silent',
  server: { middlewareMode: true, watch: { ignored: () => true } } });
try {
  const { switchCameraProjection } = await server.ssrLoadModule('/src/engine/viewport/switchCameraProjection.ts');
  let cases = 0;
  for (const [width, height] of [[1920, 984], [800, 1200], [2560, 1440]]) {
    for (const distance of [0.3, 3, 40]) for (const zoom of [0.5, 1, 2]) {
      const target = new THREE.Vector3(3, 7, -2);
      const p = new THREE.PerspectiveCamera(45, width / height, 0.01, 1000);
      p.zoom = zoom;
      p.position.copy(target).add(new THREE.Vector3(1, -2, 3).setLength(distance));
      p.up.set(0, -1, 0); // Include a pole-crossed orbit and a panned target.
      p.lookAt(target); p.updateProjectionMatrix(); p.updateMatrixWorld(true);
      const originalPosition = p.position.clone();
      const right = new THREE.Vector3(1, 0, 0).applyQuaternion(p.quaternion);
      const up = new THREE.Vector3(0, 1, 0).applyQuaternion(p.quaternion);
      const probes = [target, target.clone().addScaledVector(right, 0.1), target.clone().addScaledVector(up, 0.2)];
      const screen = camera => probes.map(point => point.clone().project(camera));
      const expected = screen(p);
      const check = (camera, points = expected) => screen(camera).forEach((point, i) => {
        assert(Math.abs(point.x - points[i].x) < 1e-9);
        assert(Math.abs(point.y - points[i].y) < 1e-9);
      });
      const o = new THREE.OrthographicCamera(-width / 2, width / 2, height / 2, -height / 2);
      for (let repeat = 0; repeat < 20; repeat++) {
        switchCameraProjection(p, o, target); check(o);
        assert(o.up.equals(p.up));
        switchCameraProjection(o, p, target); check(p);
        assert(p.position.distanceTo(originalPosition) < 1e-9);
      }
      // A zoom made in orthographic mode must carry into perspective mode.
      o.zoom *= 3; o.updateProjectionMatrix();
      const magnified = screen(o);
      switchCameraProjection(o, p, target); check(p, magnified);
      assert(p.near < p.position.distanceTo(target));
      assert(p.far > p.position.distanceTo(target));
      cases++;
    }
  }
  console.log(`Camera projection switch passed: ${cases} configurations, 20 round trips each, panning/pole orientation/non-unit zoom/orthographic zoom.`);
} finally { await server.close(); }
