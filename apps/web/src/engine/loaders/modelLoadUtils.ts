import * as THREE from 'three';
import type { ModelLoadResult, SupportedImportFormat } from './modelImportTypes';
import { normalizeImportedModel, type NormalizeImportedModelOptions } from '@/engine/scene/normalizeImportedModel';
import { createId } from '@/utils/id';

export function summarizeLoadedGroup(input: {
  group: THREE.Group;
  format: SupportedImportFormat;
  fileName: string;
  objectUrl?: string;
  normalizeOptions?: NormalizeImportedModelOptions;
}): ModelLoadResult {
  const normalization = normalizeImportedModel(input.group, {
    normalize: input.normalizeOptions?.normalize ?? true,
    ground: input.normalizeOptions?.ground ?? true,
    targetMaxDimension: input.normalizeOptions?.targetMaxDimension ?? 3,
  });

  const materialNames = new Set<string>();
  const uvSets = new Set<string>();
  let childMeshCount = 0;

  input.group.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    childMeshCount += 1;
    child.castShadow = true;
    child.receiveShadow = true;
    child.userData.sourceMaterial = child.material;
    child.userData.originalMaterial = child.material;

    const materials = Array.isArray(child.material) ? child.material : [child.material];
    materials.forEach((material, index) => {
      materialNames.add(material.name || `Material ${materialNames.size + index + 1}`);
    });

    if (child.geometry.getAttribute('uv')) {
      uvSets.add('UV0');
    }
    if (child.geometry.getAttribute('uv2')) {
      uvSets.add('UV1');
    }
  });

  const warnings: string[] = [...normalization.warnings];
  if (childMeshCount === 0) {
    warnings.push('No mesh was found in this model.');
  }
  if (uvSets.size === 0) {
    warnings.push('No UV set detected. Projected preview works, but UV bake will need UVs.');
    console.warn('[Liclick 3D Texture] Imported model has no UV set.');
  }

  const objectId = createId('object');
  input.group.name = input.fileName;
  input.group.userData.liclickObjectId = objectId;
  input.group.traverse((child) => {
    child.userData.liclickObjectId = objectId;
  });

  return {
    objectId,
    name: input.fileName,
    format: input.format,
    group: input.group,
    sourceFileName: input.fileName,
    objectUrl: input.objectUrl,
    materialSlots: [...materialNames],
    uvSets: [...uvSets],
    boundingBox: normalization.boundingBox,
    originalBoundingBox: normalization.originalBoundingBox,
    importNormalizationTransform: normalization.importNormalizationTransform,
    childMeshCount,
    warnings,
  };
}
