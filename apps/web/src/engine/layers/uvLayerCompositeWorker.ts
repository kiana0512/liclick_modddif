type CompositeUvLayerInput = {
  bitmap: ImageBitmap;
  opacity: number;
};

type CompositeUvResponse =
  | { id: number; bitmap: ImageBitmap; width: number; height: number }
  | { id: number; error: string };

type PendingComposite = {
  resolve: (bitmap: ImageBitmap) => void;
  reject: (error: Error) => void;
};

let worker: Worker | undefined;
let nextRequestId = 1;
const pending = new Map<number, PendingComposite>();

function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('../../workers/compositeUvLayers.worker.ts', import.meta.url), {
    type: 'module',
  });
  worker.onmessage = (event: MessageEvent<CompositeUvResponse>) => {
    const request = pending.get(event.data.id);
    if (!request) {
      if ('bitmap' in event.data) event.data.bitmap.close();
      return;
    }
    pending.delete(event.data.id);
    if ('error' in event.data) {
      request.reject(new Error(event.data.error));
      return;
    }
    request.resolve(event.data.bitmap);
  };
  worker.onerror = (event) => {
    const error = new Error(event.message || 'UV composition worker failed.');
    pending.forEach(({ reject }) => reject(error));
    pending.clear();
    worker?.terminate();
    worker = undefined;
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
    pending.set(id, { resolve, reject });
    getWorker().postMessage(
      { id, layers },
      { transfer: layers.map(({ bitmap }) => bitmap) },
    );
  });
}
