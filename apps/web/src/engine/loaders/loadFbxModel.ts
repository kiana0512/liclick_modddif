import { FBXLoader } from 'three-stdlib';
import { materialSlotsToSceneSlots, type LoadedModel, type ModelImportOptions } from './modelImportTypes';
import { summarizeLoadedGroup } from './modelLoadUtils';

export async function loadFbxModel(options: ModelImportOptions): Promise<LoadedModel> {
  const loader = new FBXLoader();
  const fbx = await loader.loadAsync(options.sourceUrl);
  const result = summarizeLoadedGroup({
    group: fbx,
    format: 'fbx',
    fileName: options.fileName,
    objectUrl: options.sourceUrl,
    normalizeOptions: options.normalizeOptions,
  });

  return {
    root: fbx,
    result,
    sourceUrl: options.sourceUrl,
    object: {
      id: result.objectId,
      name: result.name,
      type: 'mesh',
      sourcePath: options.sourceUrl,
      format: 'fbx',
      materialSlots: materialSlotsToSceneSlots(result.materialSlots),
      uvSets: result.uvSets,
      boundingBox: result.boundingBox,
      originalBoundingBox: result.originalBoundingBox,
      importNormalizationTransform: result.importNormalizationTransform,
      userTransform: {
        position: result.importNormalizationTransform.position,
        rotation: [0, 0, 0],
        scale: result.importNormalizationTransform.scale,
      },
      childMeshCount: result.childMeshCount,
      warnings: result.warnings,
      transform: {
        position: result.importNormalizationTransform.position,
        rotation: [0, 0, 0],
        scale: result.importNormalizationTransform.scale,
      },
      visible: true,
      selected: true,
    },
  };
}
