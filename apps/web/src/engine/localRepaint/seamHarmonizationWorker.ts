import type {
  LocalRepaintSeamHarmonizationOptions,
  LocalRepaintSeamHarmonizationReport,
} from './seamHarmonizationCore';

type SeamResponse =
  | {
      id: number;
      blob: Blob;
      processMs: number;
      report: LocalRepaintSeamHarmonizationReport;
    }
  | { id: number; error: string };

type PendingSeam = {
  resolve: (result: {
    blob: Blob;
    processMs: number;
    report: LocalRepaintSeamHarmonizationReport;
  }) => void;
  reject: (error: Error) => void;
};

let worker: Worker | undefined;
let nextRequestId = 1;
const pending = new Map<number, PendingSeam>();

function getWorker() {
  if (worker) return worker;
  worker = new Worker(
    new URL('../../workers/localRepaintSeamHarmonization.worker.ts', import.meta.url),
    { type: 'module' },
  );
  worker.onmessage = (event: MessageEvent<SeamResponse>) => {
    const request = pending.get(event.data.id);
    if (!request) return;
    pending.delete(event.data.id);
    if ('error' in event.data) request.reject(new Error(event.data.error));
    else request.resolve(event.data);
  };
  worker.onerror = (event) => {
    const error = new Error(event.message || 'Local repaint seam worker failed.');
    pending.forEach((request) => request.reject(error));
    pending.clear();
    worker?.terminate();
    worker = undefined;
  };
  return worker;
}

async function urlToBitmap(url: string) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not load seam source (${response.status}).`);
  return createImageBitmap(await response.blob());
}

export async function harmonizeLocalRepaintInWorker(input: {
  generatedUrl: string;
  referenceUrl: string;
  maskUrl: string;
  width?: number;
  height?: number;
  options?: LocalRepaintSeamHarmonizationOptions;
}) {
  if (
    typeof Worker === 'undefined' ||
    typeof OffscreenCanvas === 'undefined' ||
    typeof createImageBitmap === 'undefined'
  ) {
    throw new Error('Local repaint seam worker is unavailable.');
  }
  const bitmapResults = await Promise.allSettled([
    urlToBitmap(input.generatedUrl),
    urlToBitmap(input.referenceUrl),
    urlToBitmap(input.maskUrl),
  ]);
  const rejected = bitmapResults.find(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  );
  if (rejected) {
    bitmapResults.forEach((result) => {
      if (result.status === 'fulfilled') result.value.close();
    });
    throw rejected.reason instanceof Error ? rejected.reason : new Error(String(rejected.reason));
  }
  const fulfilledResults = bitmapResults as [
    PromiseFulfilledResult<ImageBitmap>,
    PromiseFulfilledResult<ImageBitmap>,
    PromiseFulfilledResult<ImageBitmap>,
  ];
  const generated = fulfilledResults[0].value;
  const reference = fulfilledResults[1].value;
  const mask = fulfilledResults[2].value;
  const width = input.width ?? generated.width;
  const height = input.height ?? generated.height;
  const id = nextRequestId++;
  return new Promise<{
    blob: Blob;
    processMs: number;
    report: LocalRepaintSeamHarmonizationReport;
  }>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    try {
      getWorker().postMessage(
        { id, generated, reference, mask, width, height, options: input.options },
        { transfer: [generated, reference, mask] },
      );
    } catch (error) {
      pending.delete(id);
      generated.close();
      reference.close();
      mask.close();
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}
