import { FBXLoader } from 'three-stdlib';
import type { LoadedModel, ModelImportOptions } from './modelImportTypes';

export async function loadFbxModel(options: ModelImportOptions): Promise<LoadedModel> {
  const loader = new FBXLoader();
  const fbx = await loader.loadAsync(options.sourceUrl);

  return {
    root: fbx,
    sourceUrl: options.sourceUrl,
    object: {
      id: crypto.randomUUID(),
      name: options.fileName,
      type: 'mesh',
      sourcePath: options.sourceUrl,
      format: 'fbx',
      materialSlots: [],
      uvSets: ['UV0'],
      transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      visible: true,
      selected: true,
    },
  };
}
