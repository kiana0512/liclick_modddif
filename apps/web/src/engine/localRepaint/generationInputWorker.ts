import { createRegisteredObjectUrl, getRegisteredObjectUrlBlob } from '@/utils/blobUrlRegistry';

export type PreparedLocalRepaintGenerationInput = {
  compositeUrl: string;
  submittedMaskUrl: string;
  dilationRadius: number;
  featherRadius: number;
  processMs: number;
  phaseDurationsMs: Record<string, number>;
};

export type PreparedSingleViewTextureCompletion = {
  imageUrl?: string;
  completionMaskUrl?: string;
  hasVisibleTexture: boolean;
  uncoveredPixelCount: number;
};

type LocalRepaintWorkerResult = {
  id: number;
  compositeBlob: Blob;
  submittedMaskBlob: Blob;
} & Omit<PreparedLocalRepaintGenerationInput, 'compositeUrl' | 'submittedMaskUrl'>;

type SingleViewWorkerResult = {
  id: number;
  compositeBlob?: Blob;
  submittedMaskBlob?: Blob;
} & Omit<PreparedSingleViewTextureCompletion, 'imageUrl' | 'completionMaskUrl'>;

type WorkerResult = LocalRepaintWorkerResult | SingleViewWorkerResult;
type WorkerResponse = WorkerResult | { id: number; error: string };
type PendingRequest = {
  resolve: (result: WorkerResult) => void;
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
  worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
    const pending = pendingRequests.get(event.data.id);
    if (!pending) return;
    pendingRequests.delete(event.data.id);
    if ('error' in event.data) pending.reject(new Error(event.data.error));
    else pending.resolve(event.data);
  };
  worker.onerror = (event) => {
    const error = new Error(event.message || 'Texture input preparation failed.');
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
  if (!response.ok) throw new Error(`Could not read texture input (${response.status}).`);
  return response.blob();
}

async function prepareWorkerInput(input: {
  mode: 'local' | 'single';
  currentEffectUrl: string;
  clayPreviewUrl: string;
  maskUrl: string;
}) {
  if (
    typeof Worker === 'undefined' ||
    typeof OffscreenCanvas === 'undefined' ||
    typeof createImageBitmap === 'undefined'
  ) {
    throw new Error('当前浏览器不支持贴图输入合成。');
  }
  const blobs = await Promise.all([
    readImageBlob(input.currentEffectUrl),
    readImageBlob(input.clayPreviewUrl),
    readImageBlob(input.maskUrl),
  ]);
  const [currentEffect, clayPreview, inputMask] = await Promise.all(
    blobs.map((blob) => createImageBitmap(blob)),
  );
  const id = nextRequestId++;
  return new Promise<WorkerResult>((resolve, reject) => {
    pendingRequests.set(id, { resolve, reject });
    try {
      const payload = { mode: input.mode, id, currentEffect, clayPreview, inputMask };
      getWorker().postMessage(payload, { transfer: [currentEffect, clayPreview, inputMask] });
    } catch (error) {
      pendingRequests.delete(id);
      currentEffect.close();
      clayPreview.close();
      inputMask.close();
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

export async function prepareLocalRepaintGenerationInput(input: {
  currentEffectUrl: string;
  clayPreviewUrl: string;
  authoredMaskUrl: string;
}): Promise<PreparedLocalRepaintGenerationInput> {
  const result = (await prepareWorkerInput({
    mode: 'local',
    currentEffectUrl: input.currentEffectUrl,
    clayPreviewUrl: input.clayPreviewUrl,
    maskUrl: input.authoredMaskUrl,
  })) as LocalRepaintWorkerResult;
  return {
    compositeUrl: createRegisteredObjectUrl(result.compositeBlob),
    submittedMaskUrl: createRegisteredObjectUrl(result.submittedMaskBlob),
    dilationRadius: result.dilationRadius,
    featherRadius: result.featherRadius,
    processMs: result.processMs,
    phaseDurationsMs: result.phaseDurationsMs,
  };
}

export async function prepareSingleViewTextureCompletion(input: {
  currentEffectUrl: string;
  clayPreviewUrl: string;
  objectMaskUrl: string;
}): Promise<PreparedSingleViewTextureCompletion> {
  const result = (await prepareWorkerInput({
    mode: 'single',
    currentEffectUrl: input.currentEffectUrl,
    clayPreviewUrl: input.clayPreviewUrl,
    maskUrl: input.objectMaskUrl,
  })) as SingleViewWorkerResult;
  return {
    imageUrl: result.compositeBlob
      ? createRegisteredObjectUrl(result.compositeBlob)
      : undefined,
    completionMaskUrl: result.submittedMaskBlob
      ? createRegisteredObjectUrl(result.submittedMaskBlob)
      : undefined,
    hasVisibleTexture: result.hasVisibleTexture,
    uncoveredPixelCount: result.uncoveredPixelCount,
  };
}
