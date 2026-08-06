type EncodeResponse =
  | { id: number; png: ArrayBuffer }
  | { id: number; error: string };

type PendingEncode = {
  resolve: (png: ArrayBuffer) => void;
  reject: (error: Error) => void;
};

let worker: Worker | undefined;
let nextRequestId = 1;
const pending = new Map<number, PendingEncode>();

function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('../../workers/encodeGpuReadbackPng.worker.ts', import.meta.url), {
    type: 'module',
  });
  worker.onmessage = (event: MessageEvent<EncodeResponse>) => {
    const request = pending.get(event.data.id);
    if (!request) return;
    pending.delete(event.data.id);
    if ('error' in event.data) request.reject(new Error(event.data.error));
    else request.resolve(event.data.png);
  };
  worker.onerror = (event) => {
    const error = new Error(event.message || 'GPU readback PNG worker failed.');
    pending.forEach((request) => request.reject(error));
    pending.clear();
    worker?.terminate();
    worker = undefined;
  };
  return worker;
}

export function encodeFlippedGpuReadbackPngInWorker(
  pixels: Uint8Array,
  width: number,
  height: number,
) {
  const id = nextRequestId++;
  const buffer =
    pixels.buffer instanceof ArrayBuffer &&
    pixels.byteOffset === 0 &&
    pixels.byteLength === pixels.buffer.byteLength
      ? pixels.buffer
      : pixels.slice().buffer;
  return new Promise<ArrayBuffer>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    getWorker().postMessage({ id, pixels: buffer, width, height }, [buffer]);
  });
}
