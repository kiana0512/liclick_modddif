import { LoadingManager } from 'three';
import { getPipelineTrace, type TraceScope } from '@/engine/performance/tracing/pipelineTrace';
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

function normalizeResourcePath(value: string) {
  const withoutQuery = decodeURIComponent(value.split(/[?#]/, 1)[0] ?? value);
  return withoutQuery.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
}

function createGltfLoadingManager(resourceFiles: File[]) {
  const manager = new LoadingManager();
  const objectUrls: string[] = [];
  const resources = new Map<string, string>();
  resourceFiles.forEach((file) => {
    const url = URL.createObjectURL(file);
    objectUrls.push(url);
    const relativePath = normalizeResourcePath(file.webkitRelativePath || file.name);
    const basename = relativePath.split('/').pop() ?? relativePath;
    resources.set(relativePath, url);
    if (!resources.has(basename)) resources.set(basename, url);
  });
  manager.setURLModifier((requestedUrl) => {
    const normalized = normalizeResourcePath(requestedUrl);
    const basename = normalized.split('/').pop() ?? normalized;
    return resources.get(normalized) ?? resources.get(basename) ?? requestedUrl;
  });
  return {
    manager,
    dispose: () => objectUrls.forEach((url) => URL.revokeObjectURL(url)),
  };
}

export async function loadGltfModel(options: ModelImportOptions): Promise<LoadedModel> {
  const resourceManager = createGltfLoadingManager(options.resourceFiles ?? []);
  const loader = new GLTFLoader(resourceManager.manager);
  let readScope: TraceScope | undefined;
  if (import.meta.env.VITE_LICLICK_PIPELINE_TRACE_ENABLED === 'true') {
    const trace = getPipelineTrace();
    if (trace) {
      if (!options.sourceBuffer) readScope = trace.begin('model.read', options.traceContext);
      const parse = loader.parse;
      loader.parse = (data, path, onLoad, onError) => {
        readScope?.end();
        const parsed = trace.begin('model.parse', options.traceContext);
        try {
          parse.call(loader, data, path, result => { parsed?.end(); onLoad(result); }, error => { parsed?.end('error'); onError?.(error); });
        } catch (error) { parsed?.end('error'); throw error; }
      };
    }
  }
  const format = options.fileName.toLowerCase().endsWith('.gltf') ? 'gltf' : 'glb';
  let gltf;
  try {
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
  } catch (error) { readScope?.end('error'); throw error; }
  finally {
    resourceManager.dispose();
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
