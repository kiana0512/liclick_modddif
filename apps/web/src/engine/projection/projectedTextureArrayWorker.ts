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
  cancellationPoll?: number;
};

let nextRequestId = 1;
const slots: WorkerSlot[] = [];
const queue: PackTask[] = [];
let peakActiveCount = 0;

function clearCancellationPoll(slot: WorkerSlot) {
  if (slot.cancellationPoll === undefined) return;
  window.clearTimeout(slot.cancellationPoll);
  slot.cancellationPoll = undefined;
}

function removeWorkerSlot(slot: WorkerSlot) {
  clearCancellationPoll(slot);
  const index = slots.indexOf(slot);
  if (index >= 0) slots.splice(index, 1);
}

function monitorActiveTaskCancellation(slot: WorkerSlot, task: PackTask) {
  clearCancellationPoll(slot);
  const poll = () => {
    if (slot.task !== task) return;
    if (!task.isCancelled?.()) {
      slot.cancellationPoll = window.setTimeout(poll, 16);
      return;
    }

    // Cancellation callbacks cannot cross the Worker boundary. Terminating the
    // superseded slot is the only way to stop its fetch/decode/canvas loop
    // before it allocates and transfers another 50-100MB array buffer. A fresh
    // slot is created immediately for the newest structural build.
    slot.task = undefined;
    slot.worker.terminate();
    removeWorkerSlot(slot);
    task.reject(new Error('Projected texture-array worker task was superseded.'));
    dispatchQueuedPacks();
  };
  slot.cancellationPoll = window.setTimeout(poll, 16);
}

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
  // Colour, mask, depth and normal packing are independent CPU/decode jobs.
  // Keep one worker per profile on high-end machines so the renderer does not
  // wait for a second serial packing wave. The pool never exceeds four because
  // there are only four profiles, and several logical cores remain available
  // for input, React and the WebGL submission thread.
  if (cores >= 12) return 4;
  if (cores >= 8) return 3;
  if (cores >= 6) return 2;
  return 1;
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
    clearCancellationPoll(slot);
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
    clearCancellationPoll(slot);
    slot.task?.reject(new Error(event.message || 'Projected texture-array worker failed.'));
    slot.task = undefined;
    slot.worker.terminate();
    removeWorkerSlot(slot);
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
      monitorActiveTaskCancellation(slot, task);
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
