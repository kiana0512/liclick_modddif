import * as THREE from 'three';
import { fitCameraToObject } from './fitCameraToObject';
import { getBoundingBoxForObject } from './boundingBoxUtils';
import { useProjectStore } from '@/stores/projectStore';
import { useSceneStore } from '@/stores/sceneStore';
import type { Transform } from '@/types/model';

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
