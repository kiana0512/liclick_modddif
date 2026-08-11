type ProjectionMaskEncodeResponse =
  | { id: number; blob: Blob; processMs: number }
  | { id: number; error: string };

let worker: Worker | undefined;
let nextRequestId = 1;
const pending = new Map<
  number,
  {
    resolve: (result: { blob: Blob; processMs: number }) => void;
    reject: (error: Error) => void;
  }
>();

function getWorker() {
  if (worker) return worker;
  worker = new Worker(
    new URL('../../workers/localRepaintProjectionMaskEncode.worker.ts', import.meta.url),
    { type: 'module' },
  );
  worker.onmessage = (event: MessageEvent<ProjectionMaskEncodeResponse>) => {
    const request = pending.get(event.data.id);
    if (!request) return;
    pending.delete(event.data.id);
    if ('error' in event.data) request.reject(new Error(event.data.error));
    else request.resolve({ blob: event.data.blob, processMs: event.data.processMs });
  };
  worker.onerror = (event) => {
    const error = new Error(event.message || 'Projection mask encode worker failed.');
    pending.forEach((request) => request.reject(error));
    pending.clear();
    worker?.terminate();
    worker = undefined;
  };
  return worker;
}

export async function encodeProjectionMaskInWorker(source: HTMLCanvasElement) {
  if (
    typeof Worker === 'undefined' ||
    typeof OffscreenCanvas === 'undefined' ||
    typeof createImageBitmap === 'undefined'
  ) {
    throw new Error('Projection mask encode worker is unavailable.');
  }
  const bitmap = await createImageBitmap(source);
  const id = nextRequestId++;
  return new Promise<{ blob: Blob; processMs: number }>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    try {
      getWorker().postMessage({ id, bitmap }, { transfer: [bitmap] });
    } catch (error) {
      pending.delete(id);
      bitmap.close();
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}
