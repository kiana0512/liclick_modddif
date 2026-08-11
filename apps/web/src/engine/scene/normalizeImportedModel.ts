import * as THREE from 'three';
import type { ImportNormalizationTransform } from '@/types/model';
import { getBoundingBoxForObject, getMaxDimension } from './boundingBoxUtils';

export type NormalizeImportedModelOptions = {
  normalize: boolean;
  ground: boolean;
  targetMaxDimension: number;
  /** Keep source-space position intact; useful when multiple meshes share one coordinate system. */
  recenter?: boolean;
};

export function normalizeImportedModel(group: THREE.Group, options: NormalizeImportedModelOptions) {
  group.updateMatrixWorld(true);
  const originalBoundingBox = getBoundingBoxForObject(group);
  const maxDimension = getMaxDimension(originalBoundingBox);
  const scaleFactor = options.normalize && maxDimension > 0 ? options.targetMaxDimension / maxDimension : 1;

  group.scale.multiplyScalar(scaleFactor);
  group.updateMatrixWorld(true);

  const scaledBox = new THREE.Box3().setFromObject(group);
  const scaledCenter = new THREE.Vector3();
  scaledBox.getCenter(scaledCenter);

  const recenter = options.recenter ?? true;
  const offset = new THREE.Vector3(
    recenter ? -scaledCenter.x : 0,
    0,
    recenter ? -scaledCenter.z : 0,
  );
  if (options.ground) {
    offset.y = -scaledBox.min.y;
  } else if (recenter) {
    offset.y = -scaledCenter.y;
  }

  group.position.add(offset);
  group.updateMatrixWorld(true);

  const importNormalizationTransform: ImportNormalizationTransform = {
    position: [group.position.x, group.position.y, group.position.z],
    scale: [group.scale.x, group.scale.y, group.scale.z],
    targetMaxDimension: options.targetMaxDimension,
    grounded: options.ground,
    normalized: options.normalize,
  };

  return {
    originalBoundingBox,
    boundingBox: getBoundingBoxForObject(group),
    importNormalizationTransform,
    warnings:
      maxDimension <= 0
        ? ['Model bounding box is empty or invalid; normalization was limited.']
        : [],
  };
}
