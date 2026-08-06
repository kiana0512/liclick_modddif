type ProjectedTextureProfile = 'image' | 'mask' | 'depth' | 'normal';

type PackedSource = {
  bitmap?: ImageBitmap;
  previewWidth: number;
  previewHeight: number;
};

type PackResponse = { id: number; buffer: ArrayBuffer } | { id: number; error: string };

type PendingPack = {
  resolve: (pixels: Uint8Array<ArrayBuffer>) => void;
  reject: (error: Error) => void;
  startedAt: number;
};

let worker: Worker | undefined;
let nextRequestId = 1;
const pending = new Map<number, PendingPack>();

function getWorker() {
  if (worker) return worker;
  worker = new Worker(
    new URL('../../workers/packProjectedTextureArray.worker.ts', import.meta.url),
    { type: 'module' },
  );
  worker.onmessage = (event: MessageEvent<PackResponse>) => {
    const request = pending.get(event.data.id);
    if (!request) return;
    pending.delete(event.data.id);
    if ('error' in event.data) {
      document.body.dataset.projectedArrayWorkerStatus = 'error';
      request.reject(new Error(event.data.error));
      return;
    }
    document.body.dataset.projectedArrayWorkerStatus = 'ready';
    document.body.dataset.projectedArrayWorkerDurationMs = String(
      Math.round((performance.now() - request.startedAt) * 10) / 10,
    );
    request.resolve(new Uint8Array(event.data.buffer));
  };
  worker.onerror = (event) => {
    const error = new Error(event.message || 'Projected texture-array worker failed.');
    pending.forEach(({ reject }) => reject(error));
    pending.clear();
    worker?.terminate();
    worker = undefined;
  };
  return worker;
}

export function packProjectedTextureArrayInPersistentWorker(input: {
  width: number;
  height: number;
  profile: ProjectedTextureProfile;
  sources: PackedSource[];
}) {
  const id = nextRequestId++;
  return new Promise<Uint8Array<ArrayBuffer>>((resolve, reject) => {
    document.body.dataset.projectedArrayWorkerStatus = 'packing';
    document.body.dataset.projectedArrayWorkerBackend = 'persistent-worker';
    pending.set(id, { resolve, reject, startedAt: performance.now() });
    getWorker().postMessage(
      { id, ...input },
      { transfer: input.sources.flatMap(({ bitmap }) => (bitmap ? [bitmap] : [])) },
    );
  });
}
