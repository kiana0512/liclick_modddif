import { createRegisteredObjectUrl, getRegisteredObjectUrlBlob } from '@/utils/blobUrlRegistry';

export type PreparedLocalRepaintGenerationInput = {
  compositeUrl: string;
  submittedMaskUrl: string;
  selectionMaskUrl?: string;
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
  submittedMaskBlob?: Blob;
  selectionMaskBlob?: Blob;
} & Omit<PreparedLocalRepaintGenerationInput, 'compositeUrl' | 'submittedMaskUrl' | 'selectionMaskUrl'>;

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
  mode: 'local' | 'single' | 'gpt-local';
  currentEffectUrl: string;
  clayPreviewUrl?: string;
  coverageDepthUrl?: string;
  maskUrl: string;
  whiteFill?: boolean;
  fullObject?: boolean;
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
    readImageBlob(input.maskUrl),
    input.clayPreviewUrl ? readImageBlob(input.clayPreviewUrl) : undefined,
    input.coverageDepthUrl ? readImageBlob(input.coverageDepthUrl) : undefined,
  ]);
  const [currentEffect, inputMask, clayPreview, coverageDepth] = await Promise.all(
    blobs.map((blob) => blob ? createImageBitmap(blob) : undefined),
  );
  if (!currentEffect || !inputMask) throw new Error("Missing repaint input.");
  const id = nextRequestId++;
  return new Promise<WorkerResult>((resolve, reject) => {
    pendingRequests.set(id, { resolve, reject });
    try {
      const payload = { mode: input.mode, id, currentEffect, clayPreview, inputMask, coverageDepth,
        whiteFill: input.whiteFill, fullObject: input.fullObject };
      getWorker().postMessage(payload, { transfer: [currentEffect, inputMask, ...(clayPreview ? [clayPreview] : []), ...(coverageDepth ? [coverageDepth] : [])] });
    } catch (error) {
      pendingRequests.delete(id);
      currentEffect.close();
      clayPreview?.close();
      coverageDepth?.close();
      inputMask.close();
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

export async function prepareLocalRepaintGenerationInput(input: {
  gptGuide?: boolean;
  currentEffectUrl: string;
  clayPreviewUrl?: string;
  coverageDepthUrl?: string;
  authoredMaskUrl: string;
}): Promise<PreparedLocalRepaintGenerationInput> {
  const result = (await prepareWorkerInput({
    mode: input.gptGuide ? 'gpt-local' : 'local',
    currentEffectUrl: input.currentEffectUrl,
    clayPreviewUrl: input.clayPreviewUrl,
    coverageDepthUrl: input.coverageDepthUrl,
    maskUrl: input.authoredMaskUrl,
  })) as LocalRepaintWorkerResult;
  if (input.coverageDepthUrl && !result.selectionMaskBlob) throw new Error('Missing visible repaint selection.');
  if (!input.gptGuide && !result.submittedMaskBlob) throw new Error('Missing repaint sampling mask.');
  return {
    compositeUrl: createRegisteredObjectUrl(result.compositeBlob),
    submittedMaskUrl: input.gptGuide ? input.authoredMaskUrl : createRegisteredObjectUrl(result.submittedMaskBlob!),
    selectionMaskUrl: result.selectionMaskBlob ? createRegisteredObjectUrl(result.selectionMaskBlob) : undefined,
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
  whiteFill?: boolean;
  fullObject?: boolean;
}): Promise<PreparedSingleViewTextureCompletion> {
  const result = (await prepareWorkerInput({
    mode: 'single',
    currentEffectUrl: input.currentEffectUrl,
    clayPreviewUrl: input.whiteFill ? undefined : input.clayPreviewUrl,
    maskUrl: input.objectMaskUrl,
    whiteFill: input.whiteFill,
    fullObject: input.fullObject,
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
