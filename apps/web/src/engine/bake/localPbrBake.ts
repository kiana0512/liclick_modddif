import * as THREE from 'three';
import { loadModelFromFile } from '@/engine/loaders/loadModelFromFile';
import type { EngineSession } from '@/engine/session/engineSession';
import type {
  NormalBakeJob,
  NormalBakeSettings,
} from '@/services/bakeApiClient';
import { encodeRgbaPngBlob } from '@/utils/encodeRgbaPng';
import type {
  LocalBakeChannel,
  LocalBakeMeshData,
  LocalPbrBakeInput,
  LocalPbrBakeResult,
} from './localPbrBakeCore';

const supportedChannels = new Set<LocalBakeChannel>([
  'normal',
  'ambientOcclusion',
  'worldNormal',
  'position',
  'thickness',
]);

const samplingToAoSamples: Record<NormalBakeSettings['sampling'], number> = {
  '1x1': 2,
  '2x2': 4,
  '4x4': 8,
  '8x8': 16,
};

type LoadedSource = Awaited<ReturnType<typeof loadModelFromFile>>;

export type LocalPbrBakeProgress = {
  phase: 'loading' | 'preparing' | 'baking' | 'encoding';
  progress: number;
  message: string;
};

export type LocalPbrBakeOutput = {
  job: NormalBakeJob;
  blobs: Partial<Record<LocalBakeChannel, Blob>>;
  revoke: () => void;
  stats: Pick<
    LocalPbrBakeResult,
    'coveredPixels' | 'missedPixels' | 'overlapPixels' | 'triangleCount'
  >;
};

function disposeLoaded(source: LoadedSource) {
  source.root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    object.geometry.dispose();
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    materials.forEach((material) => material.dispose());
  });
  if (source.sourceUrl.startsWith('blob:')) URL.revokeObjectURL(source.sourceUrl);
}

function extractMeshes(root: THREE.Object3D, requireUvs: boolean) {
  const meshes: LocalBakeMeshData[] = [];
  root.updateMatrixWorld(true);
  root.traverseVisible((object) => {
    if (!(object instanceof THREE.Mesh) || !object.geometry) return;
    const geometry = object.geometry;
    const position = geometry.getAttribute('position');
    if (!position || position.count < 3) return;
    if (!geometry.getAttribute('normal')) geometry.computeVertexNormals();
    const normal = geometry.getAttribute('normal');
    const uv = geometry.getAttribute('uv');
    if (!normal) throw new Error(`模型网格 ${object.name || '未命名'} 缺少法线。`);
    if (requireUvs && !uv) throw new Error(`低模网格 ${object.name || '未命名'} 缺少 UV0。`);
    const positions = new Float32Array(position.count * 3);
    const normals = new Float32Array(position.count * 3);
    const uvs = uv ? new Float32Array(position.count * 2) : undefined;
    const worldNormalMatrix = new THREE.Matrix3().getNormalMatrix(object.matrixWorld);
    const point = new THREE.Vector3();
    for (let vertex = 0; vertex < position.count; vertex += 1) {
      point.fromBufferAttribute(position, vertex).applyMatrix4(object.matrixWorld);
      positions.set([point.x, point.y, point.z], vertex * 3);
      point.fromBufferAttribute(normal, vertex).applyMatrix3(worldNormalMatrix).normalize();
      normals.set([point.x, point.y, point.z], vertex * 3);
      if (uvs && uv) uvs.set([uv.getX(vertex), uv.getY(vertex)], vertex * 2);
    }
    const sourceIndex = geometry.index;
    const indexCount = sourceIndex?.count ?? position.count;
    if (indexCount % 3 !== 0) throw new Error('本地 Bake 仅支持三角网格。');
    const indices = new Uint32Array(indexCount);
    for (let index = 0; index < indexCount; index += 1) {
      indices[index] = sourceIndex ? sourceIndex.getX(index) : index;
    }
    meshes.push({ positions, normals, indices, uvs });
  });
  if (!meshes.length) throw new Error('模型中没有可烘焙的三角网格。');
  return meshes;
}

function mergeHighMeshes(meshes: LocalBakeMeshData[]): LocalBakeMeshData {
  const vertexCount = meshes.reduce((sum, mesh) => sum + mesh.positions.length / 3, 0);
  const indexCount = meshes.reduce((sum, mesh) => sum + mesh.indices.length, 0);
  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const indices = new Uint32Array(indexCount);
  let vertexOffset = 0;
  let indexOffset = 0;
  for (const mesh of meshes) {
    positions.set(mesh.positions, vertexOffset * 3);
    normals.set(mesh.normals, vertexOffset * 3);
    for (let index = 0; index < mesh.indices.length; index += 1) {
      indices[indexOffset + index] = mesh.indices[index] + vertexOffset;
    }
    vertexOffset += mesh.positions.length / 3;
    indexOffset += mesh.indices.length;
  }
  return { positions, normals, indices };
}

function runBakeWorker(
  input: LocalPbrBakeInput,
  signal: AbortSignal,
  session?: EngineSession,
  onProgress?: (progress: number) => void,
) {
  return new Promise<LocalPbrBakeResult>((resolve, reject) => {
    const worker = new Worker(new URL('../../workers/localPbrBake.worker.ts', import.meta.url), {
      type: 'module',
      name: 'li3d-local-pbr-bake',
    });
    const resourceId = `pbr-bake-worker-${crypto.randomUUID()}`;
    let settled = false;
    const release = session?.registerResource({
      id: resourceId,
      kind: 'worker',
      label: 'Local PBR Bake BVH Worker',
      dispose: () => worker.terminate(),
    });
    const finish = async () => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      if (release) await release();
      else worker.terminate();
    };
    const onAbort = () => {
      void finish().then(() => reject(new DOMException('本地 PBR Bake 已取消。', 'AbortError')));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    worker.onerror = (event) => {
      void finish().then(() => reject(new Error(event.message || '本地 PBR Bake Worker 崩溃。')));
    };
    worker.onmessage = (event: MessageEvent) => {
      if (event.data?.type === 'progress') {
        onProgress?.(event.data.progress);
      } else if (event.data?.type === 'error') {
        void finish().then(() => reject(new Error(event.data.error)));
      } else if (event.data?.type === 'result') {
        void finish().then(() => resolve(event.data.result as LocalPbrBakeResult));
      }
    };
    const buffers = [
      input.high.positions.buffer,
      input.high.normals.buffer,
      input.high.indices.buffer,
      ...input.low.flatMap((mesh) => [
        mesh.positions.buffer,
        mesh.normals.buffer,
        mesh.indices.buffer,
        ...(mesh.uvs ? [mesh.uvs.buffer] : []),
      ]),
    ];
    worker.postMessage({ id: resourceId, input }, buffers as ArrayBuffer[]);
  });
}

function linkedSignal(primary: AbortSignal, secondary?: AbortSignal) {
  if (!secondary) return { signal: primary, cleanup: () => undefined };
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (primary.aborted || secondary.aborted) controller.abort();
  primary.addEventListener('abort', abort, { once: true });
  secondary.addEventListener('abort', abort, { once: true });
  return {
    signal: controller.signal,
    cleanup: () => {
      primary.removeEventListener('abort', abort);
      secondary.removeEventListener('abort', abort);
    },
  };
}

export async function bakePbrFilesLocally(input: {
  projectId: string;
  objectId: string;
  high: File;
  low: File;
  settings: NormalBakeSettings;
  session?: EngineSession;
  signal?: AbortSignal;
  onProgress?: (progress: LocalPbrBakeProgress) => void;
}): Promise<LocalPbrBakeOutput> {
  const unsupported = input.settings.channels.filter(
    (channel) => !supportedChannels.has(channel as LocalBakeChannel),
  );
  if (unsupported.length) {
    throw new Error(`浏览器本地 Bake 尚未支持这些通道：${unsupported.join(', ')}。`);
  }
  if (input.settings.resolution > 2048) {
    throw new Error('浏览器本地 Bake 当前最高支持 2K；4K 质量矩阵通过后再开放。');
  }
  const channels = input.settings.channels as LocalBakeChannel[];
  const execute = async (taskSignal: AbortSignal) => {
    input.onProgress?.({ phase: 'loading', progress: 0.03, message: '正在浏览器本地解析高低模' });
    const [highLoaded, lowLoaded] = await Promise.all([
      loadModelFromFile(input.high, { normalize: false, ground: false, targetMaxDimension: 3, recenter: false }),
      loadModelFromFile(input.low, { normalize: false, ground: false, targetMaxDimension: 3, recenter: false }),
    ]);
    try {
      if (taskSignal.aborted) throw new DOMException('本地 PBR Bake 已取消。', 'AbortError');
      input.onProgress?.({ phase: 'preparing', progress: 0.1, message: '正在构建本地 BVH 与 UV 采样数据' });
      const high = mergeHighMeshes(extractMeshes(highLoaded.root, false));
      const low = extractMeshes(lowLoaded.root, true);
      const result = await runBakeWorker(
        {
          high,
          low,
          resolution: input.settings.resolution,
          padding: input.settings.padding,
          frontalDistance: input.settings.frontalDistance,
          rearDistance: input.settings.rearDistance,
          normalOrientation: input.settings.normalOrientation,
          aoSamples: samplingToAoSamples[input.settings.sampling],
          channels,
        },
        taskSignal,
        input.session,
        (progress) => input.onProgress?.({
          phase: 'baking',
          progress: 0.12 + progress * 0.74,
          message: '本地 BVH 正在投射高模并生成贴图',
        }),
      );
      input.onProgress?.({ phase: 'encoding', progress: 0.88, message: '正在本地编码 PNG' });
      const blobs: Partial<Record<LocalBakeChannel, Blob>> = {};
      const urls: string[] = [];
      const outputs: NormalBakeJob['outputs'] = {};
      for (const channel of channels) {
        const rgba = result.outputs[channel];
        if (!rgba) continue;
        const blob = await encodeRgbaPngBlob(result.width, result.height, rgba, {
          transferOwnership: true,
        });
        blobs[channel] = blob;
        const url = URL.createObjectURL(blob);
        urls.push(url);
        outputs[channel] = {
          fileName: `${input.low.name.replace(/\.[^.]+$/, '')}_${channel}.png`,
          width: result.width,
          height: result.height,
          url,
        };
      }
      const now = new Date().toISOString();
      const job: NormalBakeJob = {
        id: `local-bake-${crypto.randomUUID()}`,
        ownerUserId: 'browser-local',
        kind: 'bake-maps',
        projectId: input.projectId,
        objectId: input.objectId,
        status: 'succeeded',
        stage: 'finished',
        progress: 100,
        settings: input.settings,
        input: { high: input.high.name, low: input.low.name },
        displayInput: { high: input.high.name, low: input.low.name },
        outputs,
        output: outputs.normal,
        logs: [
          'Browser-local BVH bake completed.',
          `Covered ${result.coveredPixels} pixels; missed ${result.missedPixels}; overlaps ${result.overlapPixels}.`,
        ],
        createdAt: now,
        updatedAt: now,
        startedAt: now,
        finishedAt: now,
      };
      input.onProgress?.({ phase: 'encoding', progress: 1, message: '浏览器本地 PBR Bake 完成' });
      return {
        job,
        blobs,
        revoke: () => urls.forEach((url) => URL.revokeObjectURL(url)),
        stats: {
          coveredPixels: result.coveredPixels,
          missedPixels: result.missedPixels,
          overlapPixels: result.overlapPixels,
          triangleCount: result.triangleCount,
        },
      };
    } finally {
      disposeLoaded(highLoaded);
      disposeLoaded(lowLoaded);
    }
  };

  if (!input.session) return execute(input.signal ?? new AbortController().signal);
  return input.session.schedule({
    key: 'local-pbr-bake',
    label: 'bvh-local-pbr-bake',
    lane: 'cpu',
    priority: 'user-visible',
    run: async ({ signal }) => {
      const linked = linkedSignal(signal, input.signal);
      try {
        return await execute(linked.signal);
      } finally {
        linked.cleanup();
      }
    },
  });
}
