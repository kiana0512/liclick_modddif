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
  reject: (error: Error) => void;
};

let worker: Worker | undefined;
let nextRequestId = 1;
let activeComposite: PendingComposite | undefined;
const queuedComposites = new Map<string, PendingComposite>();
let replacedCompositeCount = 0;

function abortError() {
  return new DOMException('Superseded by a newer UV composition.', 'AbortError');
}

function releaseTaskBitmaps(task: PendingComposite) {
  task.layers.forEach((layer) => {
    if ('bitmap' in layer) layer.bitmap.close();
  });
}

function updateQueueProbe() {
  document.body.dataset.uvCompositeQueueDepth = String(
    Number(Boolean(activeComposite)) + queuedComposites.size,
  );
  document.body.dataset.uvCompositeReplacedCount = String(replacedCompositeCount);
}

function dispatchNextComposite() {
  if (activeComposite || queuedComposites.size === 0) {
    updateQueueProbe();
    return;
  }
  const next = queuedComposites.entries().next().value as
    | [string, PendingComposite]
    | undefined;
  if (!next) return;
  const [ownerKey, task] = next;
  queuedComposites.delete(ownerKey);
  activeComposite = task;
  updateQueueProbe();
  getWorker().postMessage(
    { id: task.id, layers: task.layers },
    {
      transfer: task.layers.flatMap((layer) =>
        'bitmap' in layer ? [layer.bitmap] : [],
      ),
    },
  );
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

export function compositeUvLayersInWorker(
  layers: CompositeUvLayerInput[],
  ownerKey = 'default',
) {
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

export function compositeUvLayerUrlsInWorker(
  layers: Array<{ imageUrl: string; opacity: number }>,
  ownerKey = 'default',
) {
  return compositeUvLayersInWorker(layers, ownerKey);
}
