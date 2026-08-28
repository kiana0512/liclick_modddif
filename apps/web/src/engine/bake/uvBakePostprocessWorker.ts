type UvBakePostprocessInput = {
  imageData: ImageData;
  coverage: Uint8Array;
  seamPairs?: Float32Array;
  repairMissingSeamCoverage: boolean;
  seamBandPixels?: number;
  coverageGapIterations: number;
  interiorHolePixels: number;
  dilationIterations: number;
  gutterPixels: number;
  transparentOutput: boolean;
  conservativeTopology?: Uint8Array;
  coreTopology?: Uint8Array;
  regionIds?: Uint32Array;
  gutterTopology?: Uint8Array;
  transferTopology?: boolean;
};

export type UvBakePostprocessResult = {
  imageData: ImageData;
  coverage: Uint8Array<ArrayBuffer>;
  coverageFilledPixels: number;
  seamPairCount: number;
  seamAdjustedPixels: number;
  interiorFilledPixels: number;
  gutterPaddedPixels: number;
  coverageMs: number;
  seamMs: number;
  interiorMs: number;
  dilationMs: number;
  gutterMs: number;
  totalMs: number;
};

type WorkerResponse =
  | {
      type: 'result';
      id: number;
      image: ArrayBuffer;
      coverage: ArrayBuffer;
      coverageFilledPixels: number;
      seamPairCount: number;
      seamAdjustedPixels: number;
      interiorFilledPixels: number;
      gutterPaddedPixels: number;
      coverageMs: number;
      seamMs: number;
      interiorMs: number;
      dilationMs: number;
      gutterMs: number;
      totalMs: number;
    }
  | { type: 'error'; id: number; message: string };

type Pending = {
  width: number;
  height: number;
  resolve: (result: UvBakePostprocessResult) => void;
  reject: (error: Error) => void;
};

let worker: Worker | undefined;
let nextRequestId = 1;
const pending = new Map<number, Pending>();

function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('../../workers/uvBakePostprocess.worker.ts', import.meta.url), {
    type: 'module',
  });
  worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
    const request = pending.get(event.data.id);
    if (!request) return;
    pending.delete(event.data.id);
    if (event.data.type === 'error') {
      request.reject(new Error(event.data.message));
      return;
    }
    request.resolve({
      imageData: new ImageData(
        new Uint8ClampedArray(event.data.image),
        request.width,
        request.height,
      ),
      coverage: new Uint8Array(event.data.coverage),
      coverageFilledPixels: event.data.coverageFilledPixels,
      seamPairCount: event.data.seamPairCount,
      seamAdjustedPixels: event.data.seamAdjustedPixels,
      interiorFilledPixels: event.data.interiorFilledPixels,
      gutterPaddedPixels: event.data.gutterPaddedPixels,
      coverageMs: event.data.coverageMs,
      seamMs: event.data.seamMs,
      interiorMs: event.data.interiorMs,
      dilationMs: event.data.dilationMs,
      gutterMs: event.data.gutterMs,
      totalMs: event.data.totalMs,
    });
  };
  worker.onerror = (event) => {
    const error = new Error(event.message || 'UV bake postprocess worker failed.');
    for (const request of pending.values()) request.reject(error);
    pending.clear();
    worker?.terminate();
    worker = undefined;
  };
  return worker;
}

/**
 * Runs the canonical topology repair and gutter functions on a persistent
 * worker. Only the mutable image and coverage buffers are transferred; cached
 * topology arrays stay owned by the editor and are structured-cloned.
 */
export function runUvBakePostprocessInWorker(input: UvBakePostprocessInput) {
  const id = nextRequestId++;
  const image =
    input.imageData.data.buffer instanceof ArrayBuffer &&
    input.imageData.data.byteOffset === 0 &&
    input.imageData.data.byteLength === input.imageData.data.buffer.byteLength
      ? input.imageData.data.buffer
      : (input.imageData.data.slice().buffer as ArrayBuffer);
  const coverage =
    input.coverage.buffer instanceof ArrayBuffer &&
    input.coverage.byteOffset === 0 &&
    input.coverage.byteLength === input.coverage.buffer.byteLength
      ? input.coverage.buffer
      : (input.coverage.slice().buffer as ArrayBuffer);
  const transfers: Transferable[] = [image, coverage];
  if (input.transferTopology) {
    for (const topology of [
      input.conservativeTopology,
      input.coreTopology,
      input.regionIds,
      input.gutterTopology,
      input.seamPairs,
    ]) {
      if (
        topology?.buffer instanceof ArrayBuffer &&
        topology.byteOffset === 0 &&
        topology.byteLength === topology.buffer.byteLength
      ) {
        transfers.push(topology.buffer);
      }
    }
  }
  return new Promise<UvBakePostprocessResult>((resolve, reject) => {
    pending.set(id, {
      width: input.imageData.width,
      height: input.imageData.height,
      resolve,
      reject,
    });
    getWorker().postMessage(
      {
        id,
        width: input.imageData.width,
        height: input.imageData.height,
        image,
        coverage,
        seamPairs: input.seamPairs,
        repairMissingSeamCoverage: input.repairMissingSeamCoverage,
        seamBandPixels: input.seamBandPixels,
        coverageGapIterations: input.coverageGapIterations,
        interiorHolePixels: input.interiorHolePixels,
        dilationIterations: input.dilationIterations,
        gutterPixels: input.gutterPixels,
        transparentOutput: input.transparentOutput,
        conservativeTopology: input.conservativeTopology,
        coreTopology: input.coreTopology,
        regionIds: input.regionIds,
        gutterTopology: input.gutterTopology,
      },
      transfers,
    );
  });
}

export function terminateUvBakePostprocessWorker() {
  const error = new Error('UV bake postprocess worker was terminated.');
  for (const request of pending.values()) request.reject(error);
  pending.clear();
  worker?.terminate();
  worker = undefined;
}
