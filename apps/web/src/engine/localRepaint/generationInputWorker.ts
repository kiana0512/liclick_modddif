import { createRegisteredObjectUrl, getRegisteredObjectUrlBlob } from '@/utils/blobUrlRegistry';

export type PreparedLocalRepaintGenerationInput = {
  compositeUrl: string;
  submittedMaskUrl: string;
  dilationRadius: number;
  featherRadius: number;
  processMs: number;
  phaseDurationsMs: Record<string, number>;
};

type GenerationInputWorkerResponse =
  | ({
      id: number;
      compositeBlob: Blob;
      submittedMaskBlob: Blob;
    } & Omit<PreparedLocalRepaintGenerationInput, 'compositeUrl' | 'submittedMaskUrl'>)
  | { id: number; error: string };

type PendingRequest = {
  resolve: (result: PreparedLocalRepaintGenerationInput) => void;
  reject: (error: Error) => void;
};

let worker: Worker | undefined;
let nextRequestId = 1;
const pendingRequests = new Map<number, PendingRequest>();

function getWorker() {
  if (worker) return worker;
  worker = new Worker(
    new URL('../../workers/localRepaintGenerationInput.worker.ts', import.meta.url),
    { type: 'module' },
  );
  worker.onmessage = (event: MessageEvent<GenerationInputWorkerResponse>) => {
    const pending = pendingRequests.get(event.data.id);
    if (!pending) return;
    pendingRequests.delete(event.data.id);
    if ('error' in event.data) {
      pending.reject(new Error(event.data.error));
      return;
    }
    pending.resolve({
      compositeUrl: createRegisteredObjectUrl(event.data.compositeBlob),
      submittedMaskUrl: createRegisteredObjectUrl(event.data.submittedMaskBlob),
      dilationRadius: event.data.dilationRadius,
      featherRadius: event.data.featherRadius,
      processMs: event.data.processMs,
      phaseDurationsMs: event.data.phaseDurationsMs,
    });
  };
  worker.onerror = (event) => {
    const error = new Error(event.message || 'Local repaint input preparation failed.');
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
  if (!response.ok) throw new Error(`Could not read local repaint input (${response.status}).`);
  return response.blob();
}

export async function prepareLocalRepaintGenerationInput(input: {
  currentEffectUrl: string;
  clayPreviewUrl: string;
  authoredMaskUrl: string;
}): Promise<PreparedLocalRepaintGenerationInput> {
  if (
    typeof Worker === 'undefined' ||
    typeof OffscreenCanvas === 'undefined' ||
    typeof createImageBitmap === 'undefined'
  ) {
    throw new Error('当前浏览器不支持局部重绘输入合成。');
  }
  const [currentEffectBlob, clayPreviewBlob, authoredMaskBlob] = await Promise.all([
    readImageBlob(input.currentEffectUrl),
    readImageBlob(input.clayPreviewUrl),
    readImageBlob(input.authoredMaskUrl),
  ]);
  const [currentEffect, clayPreview, authoredMask] = await Promise.all([
    createImageBitmap(currentEffectBlob),
    createImageBitmap(clayPreviewBlob),
    createImageBitmap(authoredMaskBlob),
  ]);
  const id = nextRequestId++;
  return new Promise<PreparedLocalRepaintGenerationInput>((resolve, reject) => {
    pendingRequests.set(id, { resolve, reject });
    try {
      getWorker().postMessage(
        { id, currentEffect, clayPreview, authoredMask },
        { transfer: [currentEffect, clayPreview, authoredMask] },
      );
    } catch (error) {
      pendingRequests.delete(id);
      currentEffect.close();
      clayPreview.close();
      authoredMask.close();
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}
