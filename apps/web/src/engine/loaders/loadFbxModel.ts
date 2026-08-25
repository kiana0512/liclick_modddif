import { LoadingManager } from 'three';
import { FBXLoader, TGALoader } from 'three-stdlib';
import { materialSlotsToSceneSlots, type LoadedModel, type ModelImportOptions } from './modelImportTypes';
import { yieldForModelImportProgressPaint } from './modelImportProgress';
import { summarizeLoadedGroup } from './modelLoadUtils';
import { applyFbxModelVisibility, readFbxMetadata } from './fbxVisibility';
import { startPerformanceSpan } from '@/engine/performance/performanceTimeline';

const LEGACY_EMBEDDED_PNG_NAME = new TextEncoder().encode('liclick_image_0_png');

export function repairLegacyEmbeddedTextureFileNames(source: ArrayBuffer) {
  const bytes = new Uint8Array(source);
  const matchingOffsets: number[] = [];
  let searchOffset = 0;
  while (searchOffset <= bytes.length - LEGACY_EMBEDDED_PNG_NAME.length) {
    const offset = bytes.indexOf(LEGACY_EMBEDDED_PNG_NAME[0]!, searchOffset);
    if (offset < 0 || offset > bytes.length - LEGACY_EMBEDDED_PNG_NAME.length) break;
    let matches = true;
    for (let index = 0; index < LEGACY_EMBEDDED_PNG_NAME.length; index += 1) {
      if (bytes[offset + index] !== LEGACY_EMBEDDED_PNG_NAME[index]) {
        matches = false;
        break;
      }
    }
    if (matches) matchingOffsets.push(offset);
    searchOffset = offset + (matches ? LEGACY_EMBEDDED_PNG_NAME.length : 1);
  }
  if (matchingOffsets.length === 0) return source;
  const repaired = source.slice(0);
  const repairedBytes = new Uint8Array(repaired);
  matchingOffsets.forEach((offset) => {
    repairedBytes[offset + 'liclick_image_0'.length] = '.'.charCodeAt(0);
  });
  return repaired;
}

function normalizeResourcePath(value: string) {
  const withoutQuery = decodeURIComponent(value.split(/[?#]/, 1)[0] ?? value);
  return withoutQuery.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
}

function createFbxLoadingManager(resourceFiles: File[]) {
  const manager = new LoadingManager();
  manager.addHandler(/\.tga$/i, new TGALoader(manager));
  if (resourceFiles.length === 0) return manager;

  const resources = new Map<string, string>();
  resourceFiles.forEach((file) => {
    const url = URL.createObjectURL(file);
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
  return manager;
}

export async function loadFbxModel(options: ModelImportOptions): Promise<LoadedModel> {
  const loader = new FBXLoader(createFbxLoadingManager(options.resourceFiles ?? []));
  const sourceMetadata = options.sourceBuffer ? readFbxMetadata(options.sourceBuffer) : undefined;
  const sourceUnitScaleFactor = sourceMetadata?.unitScaleFactor ?? 1;
  let fbx;
  if (options.sourceBuffer) {
    options.onProgress?.({ phase: 'parsing' });
    await yieldForModelImportProgressPaint();
    const parseStartedAt = performance.now();
    const finishParseSpan = startPerformanceSpan('model-load', 'fbx-main-thread-parse', {
      sourceBytes: options.sourceBuffer.byteLength,
    });
    try {
      const repairStartedAt = performance.now();
      const repairedSource = repairLegacyEmbeddedTextureFileNames(options.sourceBuffer);
      const repairDurationMs = performance.now() - repairStartedAt;
      const loaderParseStartedAt = performance.now();
      fbx = loader.parse(repairedSource, '');
      document.body.dataset.fbxLegacyRepairMs = repairDurationMs.toFixed(1);
      document.body.dataset.fbxLoaderParseMs = (performance.now() - loaderParseStartedAt).toFixed(1);
      document.body.dataset.fbxMainThreadParseMs = (performance.now() - parseStartedAt).toFixed(1);
      finishParseSpan('end', {
        durationMs: performance.now() - parseStartedAt,
        repairDurationMs,
        copiedSource: repairedSource !== options.sourceBuffer,
      });
    } catch (error) {
      finishParseSpan('error', {
        durationMs: performance.now() - parseStartedAt,
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
    applyFbxModelVisibility(fbx, options.sourceBuffer, sourceMetadata?.visibilityByModelId);
  } else {
    options.onProgress?.({ phase: 'reading', phaseProgress: 0 });
    fbx = await loader.loadAsync(options.sourceUrl, (event) => {
      options.onProgress?.({
        phase: 'reading',
        loadedBytes: event.loaded,
        totalBytes:
          event.lengthComputable && event.total > 0
            ? event.total
            : options.sourceByteLength,
      });
    });
  }
  options.onProgress?.({ phase: 'parsing', phaseProgress: 1 });
  options.onProgress?.({ phase: 'materials' });
  await yieldForModelImportProgressPaint();
  const result = summarizeLoadedGroup({
    group: fbx,
    format: 'fbx',
    fileName: options.fileName,
    objectUrl: options.sourceUrl,
    normalizeOptions: options.normalizeOptions,
  });
  result.sourceUnitScaleFactor = sourceUnitScaleFactor;
  options.onProgress?.({ phase: 'materials', phaseProgress: 1 });

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
      sourceUnitScaleFactor,
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
