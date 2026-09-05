import { createRegisteredObjectUrl, getRegisteredObjectUrlBlob } from '@/utils/blobUrlRegistry';

export type PreparedSingleViewTextureCompletion = {
  imageUrl?: string;
  completionMaskUrl?: string;
  hasVisibleTexture: boolean;
  objectPixelCount: number;
  texturedPixelCount: number;
  uncoveredPixelCount: number;
  visibleTextureRatio: number;
  uncoveredRatio: number;
  processMs: number;
};

type WorkerResponse =
  | ({
      id: number;
      compositeBlob?: Blob;
      completionMaskBlob?: Blob;
    } & Omit<PreparedSingleViewTextureCompletion, 'imageUrl'>)
  | { id: number; error: string };

type PendingRequest = {
  resolve: (result: PreparedSingleViewTextureCompletion) => void;
  reject: (error: Error) => void;
};

let worker: Worker | undefined;
let nextRequestId = 1;
const pendingRequests = new Map<number, PendingRequest>();

function getWorker() {
  if (worker) return worker;
  worker = new Worker(
    new URL('../../workers/singleViewTextureCompletion.worker.ts', import.meta.url),
    { type: 'module' },
  );
  worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
    const pending = pendingRequests.get(event.data.id);
    if (!pending) return;
    pendingRequests.delete(event.data.id);
    if ('error' in event.data) {
      pending.reject(new Error(event.data.error));
      return;
    }
    pending.resolve({
      imageUrl: event.data.compositeBlob
        ? createRegisteredObjectUrl(event.data.compositeBlob)
        : undefined,
      completionMaskUrl: event.data.completionMaskBlob
        ? createRegisteredObjectUrl(event.data.completionMaskBlob)
        : undefined,
      hasVisibleTexture: event.data.hasVisibleTexture,
      objectPixelCount: event.data.objectPixelCount,
      texturedPixelCount: event.data.texturedPixelCount,
      uncoveredPixelCount: event.data.uncoveredPixelCount,
      visibleTextureRatio: event.data.visibleTextureRatio,
      uncoveredRatio: event.data.uncoveredRatio,
      processMs: event.data.processMs,
    });
  };
  worker.onerror = (event) => {
    const error = new Error(event.message || 'Single-view texture input preparation failed.');
    pendingRequests.forEach((pending) => pending.reject(error));
    pendingRequests.clear();
    worker?.terminate();
    worker = undefined;
  };
  return worker;
}

async function readImageBlob(url: string) {
  const registered = getRegisteredObjectUrlBlob(url);
  if (registered) return registered;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not read single-view texture input (${response.status}).`);
  return response.blob();
}

export async function prepareSingleViewTextureCompletion(input: {
  currentEffectUrl: string;
  clayPreviewUrl: string;
  objectMaskUrl: string;
}): Promise<PreparedSingleViewTextureCompletion> {
  if (
    typeof Worker === 'undefined' ||
    typeof OffscreenCanvas === 'undefined' ||
    typeof createImageBitmap === 'undefined'
  ) {
    throw new Error('当前浏览器不支持单视图贴图补全输入合成。');
  }
  const [currentEffectBlob, clayPreviewBlob, objectMaskBlob] = await Promise.all([
    readImageBlob(input.currentEffectUrl),
    readImageBlob(input.clayPreviewUrl),
    readImageBlob(input.objectMaskUrl),
  ]);
  const [currentEffect, clayPreview, objectMask] = await Promise.all([
    createImageBitmap(currentEffectBlob),
    createImageBitmap(clayPreviewBlob),
    createImageBitmap(objectMaskBlob),
  ]);
  const id = nextRequestId++;
  return new Promise<PreparedSingleViewTextureCompletion>((resolve, reject) => {
    pendingRequests.set(id, { resolve, reject });
    try {
      getWorker().postMessage(
        { id, currentEffect, clayPreview, objectMask },
        { transfer: [currentEffect, clayPreview, objectMask] },
      );
    } catch (error) {
      pendingRequests.delete(id);
      currentEffect.close();
      clayPreview.close();
      objectMask.close();
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}
