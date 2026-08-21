import { GLTFExporter } from 'three-stdlib';
import * as THREE from 'three';
import { loadModelFromFile } from '@/engine/loaders/loadModelFromFile';
import type { EngineSession } from '@/engine/session/engineSession';
import type { SceneObject } from '@/types/model';
import type {
  LocalUvAtlasInputMesh,
  LocalUvAtlasResult,
} from './localUvAtlasCore';

export type LocalUvUnwrapProgress = {
  phase: 'loading' | 'unwrapping' | 'exporting';
  progress: number;
  message: string;
};

export type LocalUvUnwrapResult = {
  blob: Blob;
  file: File;
  sha256: string;
  sourceFile: File;
  resolution: 1024 | 2048 | 4096 | 8192;
  padding: number;
  meshCount: number;
  triangleCount: number;
  chartCount: number;
  utilization: number;
  atlasWidth: number;
  atlasHeight: number;
  sourceObject: SceneObject;
};

type PreparedMesh = {
  mesh: THREE.Mesh;
  geometry: THREE.BufferGeometry;
  input: LocalUvAtlasInputMesh;
};

const MAX_LOCAL_UV_TRIANGLES = 2_000_000;

function prepareMeshes(root: THREE.Object3D) {
  const prepared: PreparedMesh[] = [];
  let triangleCount = 0;
  root.traverseVisible((object) => {
    if (!(object instanceof THREE.Mesh) || !object.geometry) return;
    if (object instanceof THREE.SkinnedMesh || Object.keys(object.geometry.morphAttributes).length) {
      throw new Error('本地 Auto UV 暂不修改骨骼或 Morph 模型，请先导出静态网格。');
    }
    const geometry = object.geometry;
    const position = geometry.getAttribute('position');
    if (!position || position.itemSize !== 3 || position.count < 3) return;
    const positions = new Float32Array(position.count * 3);
    for (let vertex = 0; vertex < position.count; vertex += 1) {
      positions[vertex * 3] = position.getX(vertex);
      positions[vertex * 3 + 1] = position.getY(vertex);
      positions[vertex * 3 + 2] = position.getZ(vertex);
    }
    const sourceIndex = geometry.index;
    const indexCount = sourceIndex?.count ?? position.count;
    if (indexCount % 3 !== 0) throw new Error(`网格 ${object.name || '未命名'} 不是三角面。`);
    const indices = new Uint32Array(indexCount);
    for (let index = 0; index < indexCount; index += 1) {
      indices[index] = sourceIndex ? sourceIndex.getX(index) : index;
    }
    triangleCount += indexCount / 3;
    if (triangleCount > MAX_LOCAL_UV_TRIANGLES) {
      throw new Error(`本地 Auto UV 当前最多处理 ${MAX_LOCAL_UV_TRIANGLES.toLocaleString()} 个三角面。`);
    }
    prepared.push({ mesh: object, geometry, input: { positions, indices } });
  });
  if (!prepared.length) throw new Error('模型中没有可展开的三角网格。');
  return { prepared, triangleCount };
}

function remapAttribute(attribute: THREE.BufferAttribute, xrefs: Uint32Array) {
  const ArrayType = attribute.array.constructor as new (length: number) => typeof attribute.array;
  const values = new ArrayType(xrefs.length * attribute.itemSize);
  for (let vertex = 0; vertex < xrefs.length; vertex += 1) {
    const source = xrefs[vertex];
    for (let component = 0; component < attribute.itemSize; component += 1) {
      values[vertex * attribute.itemSize + component] = attribute.array[
        source * attribute.itemSize + component
      ];
    }
  }
  return new THREE.BufferAttribute(values, attribute.itemSize, attribute.normalized);
}

function applyAtlasResult(prepared: PreparedMesh[], result: LocalUvAtlasResult) {
  if (prepared.length !== result.meshes.length) {
    throw new Error('本地 UV 内核返回的网格数量不一致。');
  }
  prepared.forEach(({ geometry }, meshIndex) => {
    const output = result.meshes[meshIndex];
    const attributes = Object.entries(geometry.attributes);
    for (const [name, attribute] of attributes) {
      if (name === 'uv') continue;
      if (!(attribute instanceof THREE.BufferAttribute)) {
        throw new Error(`本地 Auto UV 暂不支持交错属性：${name}。`);
      }
      geometry.setAttribute(name, remapAttribute(attribute, output.vertexXrefs));
    }
    geometry.setAttribute('uv', new THREE.BufferAttribute(output.uvs, 2));
    geometry.setIndex(new THREE.BufferAttribute(output.indices, 1));
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
  });
}

function runAtlasWorker(
  meshes: LocalUvAtlasInputMesh[],
  resolution: number,
  padding: number,
  signal: AbortSignal,
  session?: EngineSession,
) {
  return new Promise<LocalUvAtlasResult>((resolve, reject) => {
    const worker = new Worker(new URL('../../workers/localUvAtlas.worker.ts', import.meta.url), {
      type: 'module',
      name: 'li3d-local-uv-atlas',
    });
    const resourceId = `uv-worker-${crypto.randomUUID()}`;
    let settled = false;
    const terminate = () => worker.terminate();
    const release = session?.registerResource({
      id: resourceId,
      kind: 'worker',
      label: 'Local Auto UV xatlas Worker',
      dispose: terminate,
    });
    const finish = async () => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      if (release) await release();
      else terminate();
    };
    const onAbort = () => {
      void finish().then(() => reject(new DOMException('本地 Auto UV 已取消。', 'AbortError')));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    worker.onerror = (event) => {
      void finish().then(() => reject(new Error(event.message || '本地 Auto UV Worker 崩溃。')));
    };
    worker.onmessage = (event: MessageEvent) => {
      if (event.data?.type === 'error') {
        void finish().then(() => reject(new Error(event.data.error)));
      } else if (event.data?.type === 'result') {
        void finish().then(() => resolve(event.data.result as LocalUvAtlasResult));
      }
    };
    worker.postMessage(
      { id: resourceId, meshes, resolution, padding },
      meshes.flatMap((mesh) => [mesh.positions.buffer, mesh.indices.buffer]),
    );
  });
}

function disposeLoadedModel(root: THREE.Object3D, sourceUrl: string) {
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    object.geometry?.dispose();
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    materials.forEach((material) => material?.dispose());
  });
  URL.revokeObjectURL(sourceUrl);
}

async function sha256(blob: Blob) {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join('');
}

export async function unwrapModelFileLocally(input: {
  file: File;
  resolution: 1024 | 2048 | 4096 | 8192;
  padding: number;
  session?: EngineSession;
  signal?: AbortSignal;
  onProgress?: (progress: LocalUvUnwrapProgress) => void;
}) {
  const run = async (signal: AbortSignal): Promise<LocalUvUnwrapResult> => {
    input.onProgress?.({ phase: 'loading', progress: 0.04, message: '正在本地解析模型' });
    const loaded = await loadModelFromFile(input.file, {
      normalize: false,
      ground: false,
      targetMaxDimension: 3,
    });
    try {
      if (signal.aborted) throw new DOMException('本地 Auto UV 已取消。', 'AbortError');
      const { prepared, triangleCount } = prepareMeshes(loaded.root);
      input.onProgress?.({ phase: 'unwrapping', progress: 0.16, message: 'xatlas WASM 正在切缝与排布' });
      const atlas = await runAtlasWorker(
        prepared.map((item) => item.input),
        input.resolution,
        input.padding,
        signal,
        input.session,
      );
      applyAtlasResult(prepared, atlas);
      input.onProgress?.({ phase: 'exporting', progress: 0.88, message: '正在本地导出 UV GLB' });
      const exporter = new GLTFExporter();
      const exported = await exporter.parseAsync(loaded.root, {
        binary: true,
        onlyVisible: true,
        embedImages: true,
      });
      if (!(exported instanceof ArrayBuffer)) throw new Error('本地 UV GLB 导出失败。');
      const blob = new Blob([exported], { type: 'model/gltf-binary' });
      const baseName = input.file.name.replace(/\.[^.]+$/, '') || 'model';
      const file = new File([blob], `${baseName}_local_uv.glb`, { type: blob.type });
      input.onProgress?.({ phase: 'exporting', progress: 1, message: '本地 Auto UV 完成' });
      return {
        blob,
        file,
        sha256: await sha256(blob),
        sourceFile: input.file,
        resolution: input.resolution,
        padding: input.padding,
        meshCount: prepared.length,
        triangleCount,
        chartCount: atlas.chartCount,
        utilization: atlas.utilization,
        atlasWidth: atlas.width,
        atlasHeight: atlas.height,
        sourceObject: {
          ...loaded.object,
          materialSlots: loaded.object.materialSlots.map((slot) => ({ ...slot })),
          uvSets: [...loaded.object.uvSets],
          transform: { ...loaded.object.transform },
        },
      };
    } finally {
      disposeLoadedModel(loaded.root, loaded.sourceUrl);
    }
  };

  if (!input.session) return run(input.signal ?? new AbortController().signal);
  return input.session.schedule({
    key: 'local-auto-uv',
    label: 'xatlas-local-auto-uv',
    lane: 'cpu',
    priority: 'user-visible',
    run: async ({ signal }) => {
      if (!input.signal) return run(signal);
      const linked = new AbortController();
      const abort = () => linked.abort();
      if (signal.aborted || input.signal.aborted) linked.abort();
      signal.addEventListener('abort', abort, { once: true });
      input.signal.addEventListener('abort', abort, { once: true });
      try {
        return await run(linked.signal);
      } finally {
        signal.removeEventListener('abort', abort);
        input.signal.removeEventListener('abort', abort);
      }
    },
  });
}
