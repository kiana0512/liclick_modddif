import { GLTFLoader } from 'three-stdlib';
import {
  materialSlotsToSceneSlots,
  type LoadedModel,
  type ModelImportOptions,
} from './modelImportTypes';
import { yieldForModelImportProgressPaint } from './modelImportProgress';
import { summarizeLoadedGroup } from './modelLoadUtils';

// glTF 2.0 defines all linear distances in meters. Li3D's bake alignment
// space uses centimeters so it can be compared directly with FBX
// UnitScaleFactor values (which are centimeters per source unit).
const GLTF_CENTIMETERS_PER_UNIT = 100;

export async function loadGltfModel(options: ModelImportOptions): Promise<LoadedModel> {
  const loader = new GLTFLoader();
  const format = options.fileName.toLowerCase().endsWith('.gltf') ? 'gltf' : 'glb';
  let gltf;
  if (format === 'glb' && options.sourceBuffer) {
    options.onProgress?.({ phase: 'parsing' });
    await yieldForModelImportProgressPaint();
    gltf = await loader.parseAsync(options.sourceBuffer, '');
  } else {
    options.onProgress?.({ phase: 'reading', phaseProgress: 0 });
    gltf = await loader.loadAsync(options.sourceUrl, (event) => {
      options.onProgress?.({
        phase: 'reading',
        loadedBytes: event.loaded,
        totalBytes:
          event.lengthComputable && event.total > 0 ? event.total : options.sourceByteLength,
      });
    });
  }
  options.onProgress?.({ phase: 'parsing', phaseProgress: 1 });
  options.onProgress?.({ phase: 'materials' });
  await yieldForModelImportProgressPaint();
  const result = summarizeLoadedGroup({
    group: gltf.scene,
    format,
    fileName: options.fileName,
    objectUrl: options.sourceUrl,
    normalizeOptions: options.normalizeOptions,
  });
  result.sourceUnitScaleFactor = GLTF_CENTIMETERS_PER_UNIT;
  options.onProgress?.({ phase: 'materials', phaseProgress: 1 });

  return {
    root: gltf.scene,
    result,
    sourceUrl: options.sourceUrl,
    object: {
      id: result.objectId,
      name: result.name,
      type: 'mesh',
      sourcePath: options.sourceUrl,
      format,
      materialSlots: materialSlotsToSceneSlots(result.materialSlots),
      uvSets: result.uvSets,
      boundingBox: result.boundingBox,
      originalBoundingBox: result.originalBoundingBox,
      importNormalizationTransform: result.importNormalizationTransform,
      sourceUnitScaleFactor: GLTF_CENTIMETERS_PER_UNIT,
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
