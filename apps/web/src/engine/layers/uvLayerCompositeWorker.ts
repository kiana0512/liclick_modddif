type CompositeUvLayerInput =
  | { bitmap: ImageBitmap; opacity: number }
  | { imageUrl: string; opacity: number };

type CompositeUvResponse =
  | { id: number; bitmap: ImageBitmap; width: number; height: number }
  | { id: number; error: string };

type PendingComposite = {
  id: number;
  ownerKey: string;
  layers: CompositeUvLayerInput[];
  resolve: (bitmap: ImageBitmap) => void;
  reject: (error: unknown) => void;
};

let worker: Worker | undefined;
let nextRequestId = 1;
let activeComposite: PendingComposite | undefined;
const queuedComposites = new Map<string, PendingComposite>();
let replacedCompositeCount = 0;
let cancelledCompositeCount = 0;

function abortError() {
  return new DOMException('Superseded by a newer UV composition.', 'AbortError');
}

function releaseTaskBitmaps(task: PendingComposite) {
  task.layers.forEach((layer) => {
    if ('bitmap' in layer) layer.bitmap.close();
  });
}

function updateQueueProbe() {
  const probe = document.body.dataset;
  probe.uvCompositeQueueDepth = String((activeComposite ? 1 : 0) + queuedComposites.size);
  probe.uvCompositeReplacedCount = String(replacedCompositeCount);
  probe.uvCompositeCancelledCount = String(cancelledCompositeCount);
}

function dispatchNextComposite() {
  if (activeComposite || !queuedComposites.size) {
    updateQueueProbe();
    return;
  }
  const task = queuedComposites.values().next().value!;
  queuedComposites.delete(task.ownerKey);
  activeComposite = task;
  updateQueueProbe();
  try {
    getWorker().postMessage(
      { id: task.id, layers: task.layers },
      {
        transfer: task.layers.flatMap((layer) => ('bitmap' in layer ? [layer.bitmap] : [])),
      },
    );
  } catch (error) {
    activeComposite = undefined;
    releaseTaskBitmaps(task);
    task.reject(error);
    updateQueueProbe();
    // Avoid recursive dispatch if several queued tasks fail synchronously.
    queueMicrotask(dispatchNextComposite);
  }
}

function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('../../workers/compositeUvLayers.worker.ts', import.meta.url), {
    type: 'module',
  });
  worker.onmessage = (event: MessageEvent<CompositeUvResponse>) => {
    const request = activeComposite;
    if (!request || request.id !== event.data.id) {
      if ('bitmap' in event.data) event.data.bitmap.close();
      return;
    }
    activeComposite = undefined;
    if ('error' in event.data) {
      request.reject(new Error(event.data.error));
    } else {
      request.resolve(event.data.bitmap);
    }
    dispatchNextComposite();
  };
  worker.onerror = (event) => {
    const error = new Error(event.message || 'UV composition worker failed.');
    activeComposite?.reject(error);
    activeComposite = undefined;
    worker?.terminate();
    worker = undefined;
    dispatchNextComposite();
  };
  return worker;
}

export function canCompositeUvLayersInWorker() {
  return (
    typeof Worker !== 'undefined' &&
    typeof OffscreenCanvas !== 'undefined' &&
    typeof createImageBitmap !== 'undefined'
  );
}

/** Keep successful snapshots for transfer; drain and close every input on failure. */
export function prepareUvCompositeBitmaps(
  pending: Promise<{ bitmap: ImageBitmap; opacity: number }>[],
) {
  return Promise.all(pending).catch(async (error: unknown) => {
    // Native bitmap decoding cannot be cancelled. Keep the caller's composing
    // guard until late successes are owned and released, before the next job.
    await Promise.all(
      pending.map((decode) => decode.then(
        (layer) => layer.bitmap.close(),
        () => {},
      )),
    );
    throw error;
  });
}

export function compositeUvLayersInWorker(layers: CompositeUvLayerInput[], ownerKey = 'default') {
  const id = nextRequestId++;
  return new Promise<ImageBitmap>((resolve, reject) => {
    const task = { id, ownerKey, layers, resolve, reject };
    const queuedForOwner = queuedComposites.get(ownerKey);
    if (queuedForOwner) {
      releaseTaskBitmaps(queuedForOwner);
      queuedForOwner.reject(abortError());
      replacedCompositeCount += 1;
    }
    queuedComposites.set(ownerKey, task);
    dispatchNextComposite();
  });
}

/**
 * Removes queued obsolete work for one mounted compositor. An already active
 * OffscreenCanvas job is allowed to finish so rapid owner changes cannot churn
 * worker processes or transient ImageBitmap allocations.
 */
export function cancelUvLayerCompositions(ownerKey: string) {
  const queued = queuedComposites.get(ownerKey);
  if (queued) {
    queuedComposites.delete(ownerKey);
    releaseTaskBitmaps(queued);
    queued.reject(abortError());
    cancelledCompositeCount += 1;
  }
  updateQueueProbe();
}
