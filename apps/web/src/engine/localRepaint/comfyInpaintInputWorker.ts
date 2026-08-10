type ComposeResponse =
  | { id: number; png: ArrayBuffer; processMs: number }
  | { id: number; error: string };

type PendingCompose = {
  resolve: (result: { blob: Blob; processMs: number }) => void;
  reject: (error: Error) => void;
};

let worker: Worker | undefined;
let nextRequestId = 1;
const pending = new Map<number, PendingCompose>();

function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('../../workers/comfyInpaintInput.worker.ts', import.meta.url), {
    type: 'module',
  });
  worker.onmessage = (event: MessageEvent<ComposeResponse>) => {
    const request = pending.get(event.data.id);
    if (!request) return;
    pending.delete(event.data.id);
    if ('error' in event.data) {
      request.reject(new Error(event.data.error));
    } else {
      request.resolve({
        blob: new Blob([event.data.png], { type: 'image/png' }),
        processMs: event.data.processMs,
      });
    }
  };
  worker.onerror = (event) => {
    const error = new Error(event.message || 'Inpaint input worker failed.');
    pending.forEach((request) => request.reject(error));
    pending.clear();
    worker?.terminate();
    worker = undefined;
  };
  return worker;
}

export function prewarmComfyInpaintInputWorker() {
  if (typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined') return false;
  getWorker();
  return true;
}

export async function createComfyInpaintInputInWorker(input: {
  source: CanvasImageSource;
  mask: CanvasImageSource;
  width: number;
  height: number;
}) {
  if (
    typeof Worker === 'undefined' ||
    typeof OffscreenCanvas === 'undefined' ||
    typeof createImageBitmap === 'undefined'
  ) {
    throw new Error('Inpaint input worker is unavailable.');
  }
  const [source, mask] = await Promise.all([
    createImageBitmap(input.source),
    createImageBitmap(input.mask),
  ]);
  const id = nextRequestId++;
  return new Promise<{ blob: Blob; processMs: number }>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    try {
      getWorker().postMessage(
        { id, source, mask, width: input.width, height: input.height },
        { transfer: [source, mask] },
      );
    } catch (error) {
      pending.delete(id);
      source.close();
      mask.close();
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}
