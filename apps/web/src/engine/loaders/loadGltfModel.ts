import { GLTFLoader } from 'three-stdlib';
import type { LoadedModel, ModelImportOptions } from './modelImportTypes';

export async function loadGltfModel(options: ModelImportOptions): Promise<LoadedModel> {
  const loader = new GLTFLoader();
  const gltf = await loader.loadAsync(options.sourceUrl);

  return {
    root: gltf.scene,
    sourceUrl: options.sourceUrl,
    object: {
      id: crypto.randomUUID(),
      name: options.fileName,
      type: 'mesh',
      sourcePath: options.sourceUrl,
      format: options.fileName.endsWith('.gltf') ? 'gltf' : 'glb',
      materialSlots: [],
      uvSets: ['UV0'],
      transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      visible: true,
      selected: true,
    },
  };
}
