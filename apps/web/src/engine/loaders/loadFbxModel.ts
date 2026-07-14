import { LoadingManager } from 'three';
import { FBXLoader, TGALoader } from 'three-stdlib';
import { materialSlotsToSceneSlots, type LoadedModel, type ModelImportOptions } from './modelImportTypes';
import { summarizeLoadedGroup } from './modelLoadUtils';

const LEGACY_EMBEDDED_PNG_NAME = new TextEncoder().encode('liclick_image_0_png');

function repairLegacyEmbeddedTextureFileNames(source: ArrayBuffer) {
  const bytes = new Uint8Array(source.slice(0));
  for (let offset = 0; offset <= bytes.length - LEGACY_EMBEDDED_PNG_NAME.length; offset += 1) {
    let matches = true;
    for (let index = 0; index < LEGACY_EMBEDDED_PNG_NAME.length; index += 1) {
      if (bytes[offset + index] !== LEGACY_EMBEDDED_PNG_NAME[index]) {
        matches = false;
        break;
      }
    }
    if (matches) bytes[offset + 'liclick_image_0'.length] = '.'.charCodeAt(0);
  }
  return bytes.buffer;
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
  const fbx = options.sourceBuffer
    ? loader.parse(repairLegacyEmbeddedTextureFileNames(options.sourceBuffer), '')
    : await loader.loadAsync(options.sourceUrl);
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
