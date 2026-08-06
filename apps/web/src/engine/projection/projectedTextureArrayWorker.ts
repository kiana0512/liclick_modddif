type ProjectedTextureProfile = 'image' | 'mask' | 'depth' | 'normal';

type PackedSource = {
  bitmap?: ImageBitmap;
  url?: string;
  previewWidth: number;
  previewHeight: number;
};

type PackInput = {
  width: number;
  height: number;
  profile: ProjectedTextureProfile;
  sources: PackedSource[];
};

type PackResponse = { id: number; buffer: ArrayBuffer } | { id: number; error: string };

type PackTask = {
  id: number;
  input: PackInput;
  resolve: (pixels: Uint8Array<ArrayBuffer>) => void;
  reject: (error: Error) => void;
  startedAt: number;
  isCancelled?: () => boolean;
};

type WorkerSlot = {
  worker: Worker;
  task?: PackTask;
};

let nextRequestId = 1;
const slots: WorkerSlot[] = [];
const queue: PackTask[] = [];
let peakActiveCount = 0;

function updateWorkerProbe(status: string) {
  if (typeof document === 'undefined') return;
  const activeCount = slots.filter((slot) => slot.task).length;
  peakActiveCount = Math.max(peakActiveCount, activeCount);
  document.body.dataset.projectedArrayWorkerStatus = status;
  document.body.dataset.projectedArrayWorkerBackend = 'persistent-worker-pool';
  document.body.dataset.projectedArrayWorkerPoolSize = String(slots.length);
  document.body.dataset.projectedArrayWorkerQueueDepth = String(queue.length);
  document.body.dataset.projectedArrayWorkerActiveCount = String(activeCount);
  document.body.dataset.projectedArrayWorkerPeakActiveCount = String(peakActiveCount);
}

function desiredWorkerCount() {
  const cores = typeof navigator === 'undefined' ? 4 : navigator.hardwareConcurrency || 4;
  // Projection has four independent profiles, but two packers benchmark more
  // consistently than four because bitmap decode and GPU upload share memory
  // bandwidth. Reserve CPU capacity for rendering, input, and heterogeneous cores.
  return Math.max(1, Math.min(2, Math.floor(Math.max(1, cores - 2) / 3)));
}

function createWorkerSlot(): WorkerSlot {
  const slot: WorkerSlot = {
    worker: new Worker(
      new URL('../../workers/packProjectedTextureArray.worker.ts', import.meta.url),
      { type: 'module' },
    ),
  };
  slot.worker.onmessage = (event: MessageEvent<PackResponse>) => {
    const task = slot.task;
    if (!task || task.id !== event.data.id) return;
    slot.task = undefined;
    if (task.isCancelled?.()) {
      task.reject(new Error('Projected texture-array worker task was superseded.'));
    } else if ('error' in event.data) {
      task.reject(new Error(event.data.error));
    } else {
      if (typeof document !== 'undefined') {
        document.body.dataset.projectedArrayWorkerDurationMs = String(
          Math.round((performance.now() - task.startedAt) * 10) / 10,
        );
      }
      task.resolve(new Uint8Array(event.data.buffer));
    }
    dispatchQueuedPacks();
  };
  slot.worker.onerror = (event) => {
    slot.task?.reject(new Error(event.message || 'Projected texture-array worker failed.'));
    slot.task = undefined;
    slot.worker.terminate();
    const index = slots.indexOf(slot);
    if (index >= 0) slots.splice(index, 1);
    dispatchQueuedPacks();
  };
  return slot;
}

function ensureWorkerPool() {
  while (slots.length < desiredWorkerCount()) slots.push(createWorkerSlot());
}

function dispatchQueuedPacks() {
  ensureWorkerPool();
  for (const slot of slots) {
    if (slot.task) continue;
    let task = queue.shift();
    while (task?.isCancelled?.()) {
      task.input.sources.forEach((source) => source.bitmap?.close());
      task.reject(new Error('Projected texture-array worker task was superseded.'));
      task = queue.shift();
    }
    if (!task) break;
    slot.task = task;
    try {
      slot.worker.postMessage(
        { id: task.id, ...task.input },
        { transfer: task.input.sources.flatMap(({ bitmap }) => (bitmap ? [bitmap] : [])) },
      );
    } catch (error) {
      slot.task = undefined;
      task.input.sources.forEach((source) => source.bitmap?.close());
      task.reject(
        error instanceof Error ? error : new Error('Could not dispatch projected texture pack.'),
      );
    }
  }
  updateWorkerProbe(queue.length > 0 || slots.some((slot) => slot.task) ? 'packing' : 'ready');
}

export function packProjectedTextureArrayInPersistentWorker(
  input: PackInput,
  isCancelled?: () => boolean,
) {
  const id = nextRequestId++;
  return new Promise<Uint8Array<ArrayBuffer>>((resolve, reject) => {
    queue.push({ id, input, resolve, reject, startedAt: performance.now(), isCancelled });
    dispatchQueuedPacks();
  });
}
