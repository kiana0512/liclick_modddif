type FalloffResponse =
  | { id: number; bitmap: ImageBitmap; processMs: number }
  | { id: number; error: string };

type PendingFalloff = {
  resolve: (result: { bitmap: ImageBitmap; processMs: number }) => void;
  reject: (error: Error) => void;
};

let worker: Worker | undefined;
let nextRequestId = 1;
const pending = new Map<number, PendingFalloff>();

function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('../../workers/localRepaintFalloff.worker.ts', import.meta.url), {
    type: 'module',
  });
  worker.onmessage = (event: MessageEvent<FalloffResponse>) => {
    const request = pending.get(event.data.id);
    if (!request) return;
    pending.delete(event.data.id);
    if ('error' in event.data) request.reject(new Error(event.data.error));
    else request.resolve({ bitmap: event.data.bitmap, processMs: event.data.processMs });
  };
  worker.onerror = (event) => {
    const error = new Error(event.message || 'Local repaint falloff worker failed.');
    pending.forEach((request) => request.reject(error));
    pending.clear();
    worker?.terminate();
    worker = undefined;
  };
  return worker;
}

export async function createLocalRepaintFalloffInWorker(input: {
  mask: CanvasImageSource;
  source: CanvasImageSource;
  width: number;
  height: number;
}) {
  if (
    typeof Worker === 'undefined' ||
    typeof OffscreenCanvas === 'undefined' ||
    typeof createImageBitmap === 'undefined'
  ) {
    throw new Error('Local repaint falloff worker is unavailable.');
  }
  const [maskResult, sourceResult] = await Promise.allSettled([
    createImageBitmap(input.mask),
    createImageBitmap(input.source),
  ]);
  if (maskResult.status === 'rejected') {
    if (sourceResult.status === 'fulfilled') sourceResult.value.close();
    throw maskResult.reason instanceof Error
      ? maskResult.reason
      : new Error(String(maskResult.reason));
  }
  if (sourceResult.status === 'rejected') {
    maskResult.value.close();
    throw sourceResult.reason instanceof Error
      ? sourceResult.reason
      : new Error(String(sourceResult.reason));
  }
  const mask = maskResult.value;
  const source = sourceResult.value;
  const id = nextRequestId++;
  return new Promise<{ bitmap: ImageBitmap; processMs: number }>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    try {
      getWorker().postMessage(
        { id, mask, source, width: input.width, height: input.height },
        { transfer: [mask, source] },
      );
    } catch (error) {
      pending.delete(id);
      mask.close();
      source.close();
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}
