/// <reference lib="webworker" />

import {
  generateLocalUvAtlas,
  type LocalUvAtlasInputMesh,
} from '@/engine/uv/localUvAtlasCore';

type LocalUvWorkerRequest = {
  id: string;
  meshes: LocalUvAtlasInputMesh[];
  resolution: number;
  padding: number;
};

const workerScope = self as unknown as DedicatedWorkerGlobalScope;

workerScope.onmessage = async (event: MessageEvent<LocalUvWorkerRequest>) => {
  const { id, meshes, resolution, padding } = event.data;
  try {
    workerScope.postMessage({ id, type: 'progress', phase: 'initializing', progress: 0.08 });
    const result = await generateLocalUvAtlas(meshes, { resolution, padding });
    workerScope.postMessage(
      { id, type: 'result', result },
      result.meshes.flatMap((mesh) => [mesh.indices.buffer, mesh.vertexXrefs.buffer, mesh.uvs.buffer]),
    );
  } catch (error) {
    workerScope.postMessage({
      id,
      type: 'error',
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
