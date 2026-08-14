type ConversionMode = 'final' | 'layer' | 'quality';

type ConversionRequest = {
  id: number;
  mode: ConversionMode;
  pixels: ArrayBuffer;
  resolution: number;
  outputAlpha?: 'opaque-viewport' | 'transparent';
};

type ConversionResponse =
  | {
      id: number;
      mode: 'final';
      imageData: ArrayBuffer;
      coverage: ArrayBuffer;
      recycledPixels: ArrayBuffer;
      coveredPixels: number;
    }
  | {
      id: number;
      mode: 'layer';
      imageData: ArrayBuffer;
      recycledPixels: ArrayBuffer;
      coveredPixels: number;
    }
  | { id: number; mode: 'quality'; quality: ArrayBuffer; recycledPixels: ArrayBuffer }
  | { id: number; error: string };

type PendingConversion = {
  resolve: (response: ConversionResponse) => void;
  reject: (error: Error) => void;
};

let worker: Worker | undefined;
let nextRequestId = 1;
const pending = new Map<number, PendingConversion>();
const recycledReadbackBuffers = new Map<number, ArrayBuffer[]>();
const MAX_RECYCLED_READBACK_BUFFERS_PER_SIZE = 2;

function recycleReadbackBuffer(buffer: ArrayBuffer) {
  if (buffer.byteLength === 0) return;
  const buffers = recycledReadbackBuffers.get(buffer.byteLength) ?? [];
  if (buffers.length >= MAX_RECYCLED_READBACK_BUFFERS_PER_SIZE) return;
  buffers.push(buffer);
  recycledReadbackBuffers.set(buffer.byteLength, buffers);
}

export function acquireGpuReadbackPixels(byteLength: number) {
  const buffers = recycledReadbackBuffers.get(byteLength);
  const buffer = buffers?.pop();
  if (buffers?.length === 0) recycledReadbackBuffers.delete(byteLength);
  return new Uint8Array(buffer ?? new ArrayBuffer(byteLength));
}

function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('../../workers/gpuReadbackConversion.worker.ts', import.meta.url), {
    type: 'module',
  });
  worker.onmessage = (event: MessageEvent<ConversionResponse>) => {
    const request = pending.get(event.data.id);
    if (!request) return;
    pending.delete(event.data.id);
    if ('error' in event.data) {
      request.reject(new Error(event.data.error));
    } else {
      recycleReadbackBuffer(event.data.recycledPixels);
      request.resolve(event.data);
    }
  };
  worker.onerror = (event) => {
    const error = new Error(event.message || 'GPU readback conversion worker failed.');
    pending.forEach((request) => request.reject(error));
    pending.clear();
    worker?.terminate();
    worker = undefined;
  };
  return worker;
}

function convert(
  mode: ConversionMode,
  pixels: Uint8Array,
  resolution: number,
  outputAlpha?: 'opaque-viewport' | 'transparent',
) {
  const id = nextRequestId++;
  const buffer =
    pixels.buffer instanceof ArrayBuffer &&
    pixels.byteOffset === 0 &&
    pixels.byteLength === pixels.buffer.byteLength
      ? pixels.buffer
      : pixels.slice().buffer;
  const message: ConversionRequest = { id, mode, pixels: buffer, resolution, outputAlpha };
  return new Promise<ConversionResponse>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    getWorker().postMessage(message, [buffer]);
  });
}

export async function convertFinalGpuReadbackInWorker(
  pixels: Uint8Array,
  resolution: number,
  outputAlpha: 'opaque-viewport' | 'transparent',
) {
  const response = await convert('final', pixels, resolution, outputAlpha);
  if ('error' in response || response.mode !== 'final') throw new Error('Invalid final readback.');
  return {
    imageData: new ImageData(new Uint8ClampedArray(response.imageData), resolution, resolution),
    coverage: new Uint8Array(response.coverage),
    coveredPixels: response.coveredPixels,
  };
}

export async function convertLayerGpuReadbackInWorker(pixels: Uint8Array, resolution: number) {
  const response = await convert('layer', pixels, resolution);
  if ('error' in response || response.mode !== 'layer') throw new Error('Invalid layer readback.');
  return {
    imageData: new ImageData(new Uint8ClampedArray(response.imageData), resolution, resolution),
    coveredPixels: response.coveredPixels,
  };
}

export async function convertQualityGpuReadbackInWorker(pixels: Uint8Array, resolution: number) {
  const response = await convert('quality', pixels, resolution);
  if ('error' in response || response.mode !== 'quality')
    throw new Error('Invalid quality readback.');
  return new Uint8Array(response.quality);
}
