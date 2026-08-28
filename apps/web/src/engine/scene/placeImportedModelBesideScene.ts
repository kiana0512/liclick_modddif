import * as THREE from 'three';
import type { LoadedModel, ModelLoadResult } from '@/engine/loaders/modelImportTypes';
import { getBoundingBoxForObject } from './boundingBoxUtils';

function transformFromLoadedGroup(group: THREE.Group) {
  return {
    position: [group.position.x, group.position.y, group.position.z] as [number, number, number],
    rotation: [group.rotation.x, group.rotation.y, group.rotation.z] as [number, number, number],
    scale: [group.scale.x, group.scale.y, group.scale.z] as [number, number, number],
  };
}

/**
 * Keep the existing scene layout intact and place only the newly imported model
 * to the right of the current scene bounds. Model loaders normalize each import
 * around the origin, so this placement must happen before the model is registered.
 */
export function placeImportedModelBesideScene(
  loaded: LoadedModel,
  existingModels: ModelLoadResult[],
): LoadedModel {
  if (existingModels.length === 0) return loaded;

  const existingBox = new THREE.Box3();
  let hasExistingModel = false;
  existingModels.forEach((model) => {
    model.group.updateMatrixWorld(true);
    const modelBox = new THREE.Box3().setFromObject(model.group);
    if (modelBox.isEmpty()) return;
    existingBox.union(modelBox);
    hasExistingModel = true;
  });
  if (!hasExistingModel) return loaded;

  loaded.result.group.updateMatrixWorld(true);
  const newBox = new THREE.Box3().setFromObject(loaded.result.group);
  if (newBox.isEmpty()) return loaded;

  const existingSize = new THREE.Vector3();
  const newSize = new THREE.Vector3();
  const newCenter = new THREE.Vector3();
  existingBox.getSize(existingSize);
  newBox.getSize(newSize);
  newBox.getCenter(newCenter);

  const gap = Math.max(0.45, Math.min(1.2, Math.max(existingSize.x, newSize.x) * 0.18));
  const targetCenterX = existingBox.max.x + newSize.x / 2 + gap;
  loaded.result.group.position.x += targetCenterX - newCenter.x;
  loaded.result.group.updateMatrixWorld(true);

  const boundingBox = getBoundingBoxForObject(loaded.result.group);
  const transform = transformFromLoadedGroup(loaded.result.group);
  const importNormalizationTransform = {
    ...loaded.result.importNormalizationTransform,
    position: transform.position,
  };

  return {
    ...loaded,
    result: {
      ...loaded.result,
      boundingBox,
      importNormalizationTransform,
    },
    object: {
      ...loaded.object,
      boundingBox,
      transform,
      userTransform: transform,
      importNormalizationTransform,
    },
  };
}
