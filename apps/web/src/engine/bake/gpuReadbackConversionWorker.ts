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
      mode: 'final' | 'layer';
      imageData: ArrayBuffer;
      coverage: ArrayBuffer;
      coveredPixels: number;
    }
  | { id: number; mode: 'quality'; quality: ArrayBuffer }
  | { id: number; error: string };

type PendingConversion = {
  resolve: (response: ConversionResponse) => void;
  reject: (error: Error) => void;
};

let worker: Worker | undefined;
let nextRequestId = 1;
const pending = new Map<number, PendingConversion>();

function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('../../workers/gpuReadbackConversion.worker.ts', import.meta.url), {
    type: 'module',
  });
  worker.onmessage = (event: MessageEvent<ConversionResponse>) => {
    const request = pending.get(event.data.id);
    if (!request) return;
    pending.delete(event.data.id);
    if ('error' in event.data) request.reject(new Error(event.data.error));
    else request.resolve(event.data);
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

export async function convertLayerGpuReadbackInWorker(
  pixels: Uint8Array,
  resolution: number,
) {
  const response = await convert('layer', pixels, resolution);
  if ('error' in response || response.mode !== 'layer') throw new Error('Invalid layer readback.');
  return {
    imageData: new ImageData(new Uint8ClampedArray(response.imageData), resolution, resolution),
    coverage: new Uint8Array(response.coverage),
    coveredPixels: response.coveredPixels,
  };
}

export async function convertQualityGpuReadbackInWorker(
  pixels: Uint8Array,
  resolution: number,
) {
  const response = await convert('quality', pixels, resolution);
  if ('error' in response || response.mode !== 'quality') throw new Error('Invalid quality readback.');
  return new Float32Array(response.quality);
}
