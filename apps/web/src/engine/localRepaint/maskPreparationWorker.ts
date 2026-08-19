import type { MaskBitmap, Rect } from '@/types/localRepaint';

type MaskPreparationResult = {
  userMask: MaskBitmap;
  editMask: MaskBitmap;
  protectMask: MaskBitmap;
  bbox?: Rect;
  processMs: number;
};

type MaskPreparationResponse =
  | ({ id: number } & MaskPreparationResult)
  | { id: number; error: string };

type PendingRequest = {
  resolve: (result: MaskPreparationResult) => void;
  reject: (error: Error) => void;
};

let worker: Worker | undefined;
let nextRequestId = 1;
const pendingRequests = new Map<number, PendingRequest>();

function getWorker() {
  if (worker) return worker;
  worker = new Worker(
    new URL('../../workers/localRepaintMaskPreparation.worker.ts', import.meta.url),
    { type: 'module' },
  );
  worker.onmessage = (event: MessageEvent<MaskPreparationResponse>) => {
    const pending = pendingRequests.get(event.data.id);
    if (!pending) return;
    pendingRequests.delete(event.data.id);
    if ('error' in event.data) pending.reject(new Error(event.data.error));
    else pending.resolve(event.data);
  };
  worker.onerror = (event) => {
    const error = new Error(event.message || 'Local repaint mask preparation failed.');
    pendingRequests.forEach((pending) => pending.reject(error));
    pendingRequests.clear();
    worker?.terminate();
    worker = undefined;
  };
  return worker;
}

export async function prepareLocalRepaintMasksInWorker(input: {
  maskCanvas: HTMLCanvasElement;
  objectMask: MaskBitmap;
  holeMask: MaskBitmap;
  mode: 'edit_layer_image' | 'repair_current_view';
  includeBlankArea: boolean;
  limitToBlankAndSelection: boolean;
  preserveUnmaskedArea: boolean;
}): Promise<MaskPreparationResult> {
  if (
    typeof Worker === 'undefined' ||
    typeof OffscreenCanvas === 'undefined' ||
    typeof createImageBitmap === 'undefined'
  ) {
    throw new Error('Local repaint mask worker is unavailable.');
  }
  const bitmap = await createImageBitmap(input.maskCanvas);
  const id = nextRequestId++;
  return new Promise<MaskPreparationResult>((resolve, reject) => {
    pendingRequests.set(id, { resolve, reject });
    try {
      getWorker().postMessage(
        {
          id,
          bitmap,
          objectMask: {
            width: input.objectMask.width,
            height: input.objectMask.height,
            data: new Uint8ClampedArray(input.objectMask.data),
          },
          holeMask: {
            width: input.holeMask.width,
            height: input.holeMask.height,
            data: new Uint8ClampedArray(input.holeMask.data),
          },
          mode: input.mode,
          includeBlankArea: input.includeBlankArea,
          limitToBlankAndSelection: input.limitToBlankAndSelection,
          preserveUnmaskedArea: input.preserveUnmaskedArea,
        },
        { transfer: [bitmap] },
      );
    } catch (error) {
      pendingRequests.delete(id);
      bitmap.close();
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}
