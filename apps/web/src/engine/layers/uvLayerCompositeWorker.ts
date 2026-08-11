type CompositeUvLayerInput =
  | { bitmap: ImageBitmap; opacity: number }
  | { imageUrl: string; opacity: number };

type CompositeUvResponse =
  | { id: number; bitmap: ImageBitmap; width: number; height: number }
  | { id: number; error: string };

type PendingComposite = {
  id: number;
  layers: CompositeUvLayerInput[];
  resolve: (bitmap: ImageBitmap) => void;
  reject: (error: Error) => void;
};

let worker: Worker | undefined;
let nextRequestId = 1;
let activeComposite: PendingComposite | undefined;
let queuedComposite: PendingComposite | undefined;
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
    Number(Boolean(activeComposite)) + Number(Boolean(queuedComposite)),
  );
  document.body.dataset.uvCompositeReplacedCount = String(replacedCompositeCount);
}

function dispatchNextComposite() {
  if (activeComposite || !queuedComposite) {
    updateQueueProbe();
    return;
  }
  const task = queuedComposite;
  queuedComposite = undefined;
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

export function compositeUvLayersInWorker(layers: CompositeUvLayerInput[]) {
  const id = nextRequestId++;
  return new Promise<ImageBitmap>((resolve, reject) => {
    const task = { id, layers, resolve, reject };
    if (queuedComposite) {
      releaseTaskBitmaps(queuedComposite);
      queuedComposite.reject(abortError());
      replacedCompositeCount += 1;
    }
    queuedComposite = task;
    dispatchNextComposite();
  });
}

export function compositeUvLayerUrlsInWorker(
  layers: Array<{ imageUrl: string; opacity: number }>,
) {
  return compositeUvLayersInWorker(layers);
}
