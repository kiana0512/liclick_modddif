type DecodeResponse =
  | { id: number; rgba: ArrayBuffer; width: number; height: number }
  | { id: number; error: string };

let worker: Worker | undefined;
let nextId = 1;
const pending = new Map<number, { resolve: (image: ImageData) => void; reject: (error: Error) => void }>();

function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('../../workers/imageDataDecode.worker.ts', import.meta.url), {
    type: 'module',
  });
  worker.onmessage = (event: MessageEvent<DecodeResponse>) => {
    const request = pending.get(event.data.id);
    if (!request) return;
    pending.delete(event.data.id);
    if ('error' in event.data) request.reject(new Error(event.data.error));
    else request.resolve(new ImageData(new Uint8ClampedArray(event.data.rgba), event.data.width, event.data.height));
  };
  return worker;
}

export function decodeReferenceImageInWorker(url: string, width: number, height: number) {
  const id = nextId++;
  return new Promise<ImageData>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    getWorker().postMessage({ id, url, width, height });
  });
}
