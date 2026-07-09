import * as THREE from 'three';
import { fitCameraToObject } from './fitCameraToObject';
import { getBoundingBoxForObject } from './boundingBoxUtils';
import { useProjectStore } from '@/stores/projectStore';
import { useSceneStore } from '@/stores/sceneStore';
import type { Transform } from '@/types/model';

export type ObjectViewPreset =
  | 'front'
  | 'front-left'
  | 'front-right'
  | 'back'
  | 'back-left'
  | 'back-right'
  | 'left'
  | 'right'
  | 'top';

export function transformFromObject(object: THREE.Object3D): Transform {
  return {
    position: [object.position.x, object.position.y, object.position.z],
    rotation: [object.rotation.x, object.rotation.y, object.rotation.z],
    scale: [object.scale.x, object.scale.y, object.scale.z],
  };
}

export function syncImportedModelTransform() {
  const sceneState = useSceneStore.getState();
  const model = sceneState.importedModel;
  if (!model) return;
  const transform = transformFromObject(model.group);
  const boundingBox = getBoundingBoxForObject(model.group);
  useSceneStore.getState().updateObjectTransform(model.objectId, transform, boundingBox);
  useProjectStore.getState().updateObjectTransform(model.objectId, transform, boundingBox);
}

export function resetImportedModelTransform() {
  const model = useSceneStore.getState().importedModel;
  if (!model) return;
  model.group.position.fromArray(model.importNormalizationTransform.position);
  model.group.rotation.set(0, 0, 0);
  model.group.scale.fromArray(model.importNormalizationTransform.scale);
  model.group.updateMatrixWorld(true);
  syncImportedModelTransform();
}

export function centerImportedModel() {
  const model = useSceneStore.getState().importedModel;
  if (!model) return;
  model.group.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(model.group);
  const center = new THREE.Vector3();
  box.getCenter(center);
  model.group.position.x -= center.x;
  model.group.position.z -= center.z;
  model.group.updateMatrixWorld(true);
  syncImportedModelTransform();
}

export function groundImportedModel() {
  const model = useSceneStore.getState().importedModel;
  if (!model) return;
  model.group.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(model.group);
  model.group.position.y -= box.min.y;
  model.group.updateMatrixWorld(true);
  syncImportedModelTransform();
}

export function fitCameraToImportedModel() {
  const sceneState = useSceneStore.getState();
  if (!sceneState.importedModel || !sceneState.viewport) return;
  fitCameraToObject(sceneState.viewport, sceneState.importedModel.group);
}

export function fitCameraToObjectId(objectId?: string) {
  const sceneState = useSceneStore.getState();
  if (!sceneState.viewport) return;
  const model = objectId
    ? sceneState.importedModels.find((item) => item.objectId === objectId)
    : sceneState.importedModel;
  if (!model) return;
  fitCameraToObject(sceneState.viewport, model.group);
}

export function getObjectViewPresetDirection(preset: ObjectViewPreset) {
  if (preset === 'back') return new THREE.Vector3(0, 0, -1);
  if (preset === 'back-left') return new THREE.Vector3(-1, 0, -1).normalize();
  if (preset === 'back-right') return new THREE.Vector3(1, 0, -1).normalize();
  if (preset === 'front-left') return new THREE.Vector3(-1, 0, 1).normalize();
  if (preset === 'front-right') return new THREE.Vector3(1, 0, 1).normalize();
  if (preset === 'left') return new THREE.Vector3(-1, 0, 0);
  if (preset === 'right') return new THREE.Vector3(1, 0, 0);
  if (preset === 'top') return new THREE.Vector3(0, 1, 0);
  return new THREE.Vector3(0, 0, 1);
}

export function setCameraToObjectView(objectId: string | undefined, preset: ObjectViewPreset) {
  const sceneState = useSceneStore.getState();
  const runtime = sceneState.viewport;
  if (!runtime) return;
  const model = objectId
    ? sceneState.importedModels.find((item) => item.objectId === objectId)
    : sceneState.importedModel;
  if (!model) return;

  model.group.updateMatrixWorld(true);
  const boundingBox = getBoundingBoxForObject(model.group);
  const center = new THREE.Vector3().fromArray(boundingBox.center);
  const size = new THREE.Vector3().fromArray(boundingBox.size);
  const radius = Math.max(size.x, size.y, size.z, 1);
  const direction = getObjectViewPresetDirection(preset);
  const distance = radius * 2.4;

  runtime.camera.position.copy(center).add(direction.multiplyScalar(distance));
  runtime.camera.up.set(0, 1, 0);
  if (preset === 'top') runtime.camera.up.set(0, 0, -1);
  runtime.camera.lookAt(center);

  if (runtime.camera instanceof THREE.PerspectiveCamera) {
    runtime.camera.near = 0.01;
    runtime.camera.far = Math.max(distance + radius * 6, 100);
    runtime.camera.updateProjectionMatrix();
  }

  if (runtime.camera instanceof THREE.OrthographicCamera) {
    runtime.camera.near = 0.01;
    runtime.camera.far = Math.max(distance + radius * 6, 100);
    runtime.camera.zoom = 90;
    runtime.camera.updateProjectionMatrix();
  }

  runtime.controls?.target.copy(center);
  runtime.controls?.update();
}
