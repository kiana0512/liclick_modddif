import * as THREE from 'three';
import { loadModelFromFile } from '@/engine/loaders/loadModelFromFile';
import type { TaskHistoryOutput } from '@/services/taskHistoryApiClient';
import { fetchTaskHistoryOutputBlob } from '@/services/taskHistoryApiClient';
import {
  frameVisiblePreviewObject,
  repairConcaveFbxPreview,
} from './repairFbxPreviewGeometry';

const outputFileCache = new Map<string, Promise<File>>();
const thumbnailCache = new Map<string, Promise<string>>();

function outputCacheKey(output: TaskHistoryOutput) {
  return `${output.id}:${output.filename}:${output.sizeBytes}:${output.downloadUrl ?? ''}`;
}

export function getHistoryModelFile(output: TaskHistoryOutput) {
  const key = outputCacheKey(output);
  const cached = outputFileCache.get(key);
  if (cached) return cached;
  const request = fetchTaskHistoryOutputBlob(output).then(
    (blob) => new File([blob], output.filename, { type: blob.type || 'application/octet-stream' }),
  );
  outputFileCache.set(key, request);
  request.catch(() => outputFileCache.delete(key));
  return request;
}

function disposeObject(root: THREE.Object3D) {
  root.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    child.geometry?.dispose();
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    materials.forEach((material) => material?.dispose());
  });
}

function applyPreviewMaterial(root: THREE.Object3D) {
  repairConcaveFbxPreview(root);
  root.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    const sourceMaterials = Array.isArray(child.material) ? child.material : [child.material];
    sourceMaterials.forEach((material) => material?.dispose());
    child.material = new THREE.MeshStandardMaterial({
      color: '#b8bdc7',
      roughness: 0.72,
      metalness: 0.03,
    });
    child.castShadow = true;
    child.receiveShadow = true;
  });
}

export async function renderHistoryModelThumbnail(output: TaskHistoryOutput, size = 256) {
  const key = `${outputCacheKey(output)}:${size}`;
  const cached = thumbnailCache.get(key);
  if (cached) return cached;

  const request = (async () => {
    const file = await getHistoryModelFile(output);
    const loaded = await loadModelFromFile(file, {
      normalize: true,
      ground: true,
      targetMaxDimension: 3,
    });
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setPixelRatio(1);
    renderer.setSize(size, size, false);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.setClearColor('#292b34', 1);

    const scene = new THREE.Scene();
    const root = loaded.root;
    applyPreviewMaterial(root);
    const bounds = frameVisiblePreviewObject(root) ?? new THREE.Box3().setFromObject(root);
    scene.add(root);
    scene.add(new THREE.HemisphereLight('#ffffff', '#303544', 2.2));
    const keyLight = new THREE.DirectionalLight('#ffffff', 2.4);
    keyLight.position.set(4, 6, 5);
    scene.add(keyLight);
    const fillLight = new THREE.DirectionalLight('#a9bfff', 1.1);
    fillLight.position.set(-4, 2, -3);
    scene.add(fillLight);

    const center = bounds.getCenter(new THREE.Vector3());
    const dimensions = bounds.getSize(new THREE.Vector3());
    const radius = Math.max(dimensions.x, dimensions.y, dimensions.z, 0.25) * 0.5;
    const camera = new THREE.PerspectiveCamera(34, 1, 0.01, 100);
    const distance = radius / Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5));
    camera.position.copy(center).add(new THREE.Vector3(distance * 0.72, distance * 0.42, distance));
    camera.lookAt(center);
    camera.near = Math.max(0.01, distance / 100);
    camera.far = distance * 10;
    camera.updateProjectionMatrix();

    renderer.render(scene, camera);
    const image = renderer.domElement.toDataURL('image/png');
    scene.remove(root);
    disposeObject(root);
    renderer.dispose();
    URL.revokeObjectURL(loaded.sourceUrl);
    return image;
  })();

  thumbnailCache.set(key, request);
  request.catch(() => thumbnailCache.delete(key));
  return request;
}

