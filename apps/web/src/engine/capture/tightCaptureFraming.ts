import * as THREE from 'three';
import type { ViewportRuntime } from '@/stores/sceneStore';
import { captureMask } from './captureMask';
import { isCaptureTargetMesh } from './renderTargetUtils';
import { urlToImageData } from '@/engine/localRepaint/imageUtils';
import { revokeRegisteredObjectUrl } from '@/utils/blobUrlRegistry';
import { waitForBrowserPaint } from '@/utils/browserScheduling';

type Fitted = { camera: THREE.PerspectiveCamera | THREE.OrthographicCamera; target: THREE.Vector3 };

/** ALG-CAP-007/1.2.0: fit submitted vertices once; GPT uses 98% square coverage. */
export async function fitGeometryCapture(
  scene: THREE.Scene, objectId: string, fallback: Fitted, aspect: number,
  signal?: AbortSignal, fillRatio = 0.92,
): Promise<Fitted> {
  signal?.throwIfAborted();
  const camera = fallback.camera.clone();
  camera.updateMatrixWorld(true);
  const [right, up, back] = [0, 1, 2].map(axis =>
    new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, axis)) as [THREE.Vector3, THREE.Vector3, THREE.Vector3];
  const perspective = camera instanceof THREE.PerspectiveCamera;
  const fill = Math.min(0.98, Math.max(0.1, Number.isFinite(fillRatio) ? fillRatio : 0.92));
  const ty = perspective ? Math.tan(THREE.MathUtils.degToRad(camera.getEffectiveFOV()) / 2) * fill : 0;
  const tx = ty * aspect;
  const meshes: THREE.Mesh[] = [];
  scene.updateMatrixWorld(true);
  scene.traverse(object => {
    if (!isCaptureTargetMesh(object, objectId)) return;
    meshes.push(object);
  });
  let loX = Infinity, hiX = -Infinity, loY = Infinity, hiY = -Infinity;
  let loZ = Infinity, hiZ = -Infinity, count = 0, sliceStart = performance.now();
  const point = new THREE.Vector3();
  let origin: THREE.Vector3 | undefined;
  for (const mesh of meshes) {
    // Custom vertex deformation / per-instance morphs need their own exact bounds.
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    if (mesh instanceof THREE.InstancedMesh || mesh instanceof THREE.SkinnedMesh ||
      materials.some(m => 'displacementMap' in m && m.displacementMap)) return fallback;
    const geometry = mesh.geometry;
    const positions = geometry.getAttribute('position');
    if (!positions) return fallback;
    const index = geometry.index;
    const visited = index && positions.count <= 2_000_000 ? new Uint8Array(positions.count) : undefined;
    const start = geometry.drawRange.start;
    const end = Math.min(index?.count ?? positions.count, start + geometry.drawRange.count);
    const matrix = mesh.matrixWorld.clone();
    for (let i = start; i < end; i++) {
      if (++count > 2_000_000) return fallback;
      if (count % 4096 === 0 && performance.now() - sliceStart > 4) {
        await waitForBrowserPaint();
        signal?.throwIfAborted();
        sliceStart = performance.now();
        if (!matrix.equals(mesh.matrixWorld)) return fallback;
      }
      const vertex = index ? index.getX(i) : i;
      if (visited?.[vertex]) continue;
      if (visited) visited[vertex] = 1;
      mesh.getVertexPosition(vertex, point);
      point.applyMatrix4(matrix);
      origin ??= point.clone();
      point.sub(origin);
      const x = point.dot(right), y = point.dot(up), z = point.dot(back);
      if (!Number.isFinite(x + y + z)) return fallback;
      // cx must lie between max(x + z*tx)-d*tx and min(x-z*tx)+d*tx.
      hiX = Math.max(hiX, x + z * tx); loX = Math.min(loX, x - z * tx);
      hiY = Math.max(hiY, y + z * ty); loY = Math.min(loY, y - z * ty);
      loZ = Math.min(loZ, z); hiZ = Math.max(hiZ, z);
    }
  }
  signal?.throwIfAborted();
  if (!origin || !count || Math.max(hiX - loX, hiY - loY) < 1e-8) return fallback;
  const target = origin.clone().addScaledVector(right, (hiX + loX) / 2)
    .addScaledVector(up, (hiY + loY) / 2);
  const extent = Math.max(hiX - loX, hiY - loY, hiZ - loZ, 0.001);
  let distance = Math.max(hiZ + extent * 0.01, extent);
  if (camera instanceof THREE.PerspectiveCamera) {
    distance = Math.max(hiZ + extent * 0.01, (hiX - loX) / (2 * tx), (hiY - loY) / (2 * ty));
  } else {
    const halfHeight = Math.max((hiY - loY) / 2, (hiX - loX) / (2 * aspect)) / fill;
    camera.top = halfHeight; camera.bottom = -halfHeight;
    camera.left = -halfHeight * aspect; camera.right = halfHeight * aspect;
    camera.zoom = 1;
  }
  camera.position.copy(target).addScaledVector(back, distance);
  camera.near = Math.max(1e-6, (distance - hiZ) * 0.5);
  camera.far = Math.max(camera.near + 1, distance - loZ + extent);
  camera.updateProjectionMatrix(); camera.updateMatrixWorld(true);
  return { camera, target };
}

/** Additional raster check; never use this low-resolution image as a generation input. */
export async function verifyTightCapture(
  viewport: ViewportRuntime, objectId: string, fitted: Fitted, fallback: Fitted,
  aspect: number, signal?: AbortSignal, edgeMargin = 0.025,
): Promise<Fitted> {
  if (fitted === fallback) return fallback;
  let url: string | undefined;
  try {
    signal?.throwIfAborted();
    const width = Math.round(256 * Math.min(1, aspect));
    const height = Math.round(256 / Math.max(1, aspect));
    const mask = await captureMask({ gl: viewport.gl, scene: viewport.scene, camera: fitted.camera,
      objectId, width: Math.max(1, width), height: Math.max(1, height), clearColor: '#000000', clearAlpha: 1 });
    url = mask.url;
    const pixels = await urlToImageData(url);
    signal?.throwIfAborted();
    let found = false;
    for (let y = 0; y < pixels.height; y++) for (let x = 0; x < pixels.width; x++) {
      const i = (y * pixels.width + x) * 4;
      if (pixels.data[i]! < 32 || pixels.data[i + 3]! < 32) continue;
      found = true;
      if (x < pixels.width * edgeMargin || x >= pixels.width * (1 - edgeMargin) ||
        y < pixels.height * edgeMargin || y >= pixels.height * (1 - edgeMargin)) return fallback;
    }
    return found ? fitted : fallback;
  } catch {
    signal?.throwIfAborted();
    return fallback;
  } finally { revokeRegisteredObjectUrl(url); }
}
