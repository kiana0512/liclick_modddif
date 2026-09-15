import ReadbackWorker from '../../workers/gpuReadbackConversion.worker?worker&inline';

type ConversionMode = 'final' | 'layer' | 'resident' | 'quality';

type ConversionRequest = {
  id: number;
  mode: ConversionMode;
  pixels: ArrayBuffer;
  resolution: number;
  outputAlpha?: 'opaque-viewport' | 'transparent';
  packedQuality?: boolean;
};

type ConversionResponse =
  | {
      id: number;
      mode: 'final' | 'layer' | 'resident';
      imageData: ArrayBuffer;
      coverage: ArrayBuffer;
      coveredPixels: number;
      transparentCleanupTexels?: ArrayBuffer;
    }
  | { id: number; mode: 'quality'; quality: ArrayBuffer }
  | { id: number; mode: 'gutter'; imageData: ArrayBuffer; coverage: ArrayBuffer; paddedPixels: number }
  | { id: number; error: string };

type PendingConversion = {
  resolve: (response: ConversionResponse) => void;
  reject: (error: Error) => void;
};

type WorkerSession = {
  instance: Worker;
  ready: Promise<void>;
  pending: Map<number, PendingConversion>;
  error?: Error;
  gutterTopology?: Uint8Array;
};

let session: WorkerSession | undefined;
let nextRequestId = 1;

function createSession() {
  // Keep the exact conversion/postprocess kernel with the page across deployments.
  const instance = new ReadbackWorker();
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  let started = false;
  const current: WorkerSession = {
    instance,
    ready: new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    }),
    pending: new Map(),
  };
  const fail = (error: Error) => {
    if (current.error) return;
    current.error = error;
    clearTimeout(timeout);
    rejectReady(error);
    current.pending.forEach((request) => request.reject(error));
    current.pending.clear();
    instance.terminate();
    if (session === current) session = undefined;
  };
  const timeout = setTimeout(() => fail(new Error('GPU readback Worker 启动超时。')), 5000);
  instance.onmessage = (event: MessageEvent<ConversionResponse | { ready: 1 }>) => {
    if (current.error) return;
    if ('ready' in event.data) {
      started = true;
      clearTimeout(timeout);
      resolveReady();
      return;
    }
    const request = current.pending.get(event.data.id);
    if (!request) return;
    current.pending.delete(event.data.id);
    if ('error' in event.data) request.reject(new Error(event.data.error));
    else request.resolve(event.data);
  };
  instance.onerror = (event) => {
    event.preventDefault();
    fail(new Error(`GPU readback Worker ${started ? '转换' : '启动'}失败：${event.message || '浏览器终止了 Worker'}`));
  };
  instance.onmessageerror = () => fail(new Error('GPU readback Worker 返回数据无法读取。'));
  return current;
}

async function getReadySession() {
  // Retry bootstrap only; no pixel buffer has been transferred at this point.
  for (let attempt = 0; ; attempt += 1) {
    try {
      const current = session ?? (session = createSession());
      await current.ready;
      if (current.error) throw current.error;
      return current;
    } catch (error) {
      if (attempt === 1) throw error;
    }
  }
}

async function convert(
  mode: ConversionMode,
  pixels: Uint8Array,
  resolution: number,
  outputAlpha?: 'opaque-viewport' | 'transparent',
  packedQuality?: boolean,
) {
  const current = await getReadySession();
  if (current.error) throw current.error;
  const id = nextRequestId++;
  const buffer =
    pixels.buffer instanceof ArrayBuffer &&
    pixels.byteOffset === 0 &&
    pixels.byteLength === pixels.buffer.byteLength
      ? pixels.buffer
      : pixels.slice().buffer;
  const message: ConversionRequest = { id, mode, pixels: buffer, resolution, outputAlpha, packedQuality };
  return new Promise<ConversionResponse>((resolve, reject) => {
    current.pending.set(id, { resolve, reject });
    try {
      current.instance.postMessage(message, [buffer]);
    } catch (error) {
      current.pending.delete(id);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
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
  straightRgba = false,
) {
  const mode=straightRgba ? 'resident' : 'layer';
  const response = await convert(mode, pixels, resolution);
  if ('error' in response || response.mode !== mode) throw new Error('Invalid layer readback.');
  return {
    imageData: new ImageData(new Uint8ClampedArray(response.imageData), resolution, resolution),
    coverage: new Uint8Array(response.coverage),
    coveredPixels: response.coveredPixels,
    transparentCleanupTexels: response.transparentCleanupTexels
      ? new Uint32Array(response.transparentCleanupTexels) : undefined,
  };
}

export async function convertQualityGpuReadbackInWorker(
  pixels: Uint8Array,
  resolution: number,
  packedQuality = false,
) {
  const response = await convert('quality', pixels, resolution, undefined, packedQuality);
  if ('error' in response || response.mode !== 'quality') throw new Error('Invalid quality readback.');
  return new Float32Array(response.quality);
}

/** Consumes exclusive composite buffers and returns replacement owners. */
export async function padResidentUvGutterInWorker(image: ImageData, coverage: Uint8Array<ArrayBuffer>,
  topology: Uint8Array, iterations: number, alphaMode: boolean | 'rgb-only', check?: () => void) {
  const current=await getReadySession();check?.();
  const id=nextRequestId++,pixels=image.data;
  const rgbaBuffer=pixels.byteOffset===0 && pixels.byteLength===pixels.buffer.byteLength ? pixels.buffer : pixels.slice().buffer;
  const coverageBuffer=coverage.byteOffset===0 && coverage.byteLength===coverage.buffer.byteLength ? coverage.buffer : coverage.slice().buffer;
  const mask=current.gutterTopology===topology ? undefined : topology;
  const response=await new Promise<ConversionResponse>((resolve,reject)=>{
    current.pending.set(id,{resolve,reject});
    try {
      current.instance.postMessage({id,mode:'gutter',pixels:rgbaBuffer,coverage:coverageBuffer,
        width:image.width,height:image.height,topology:mask,iterations,alphaMode},[rgbaBuffer,coverageBuffer]);
      current.gutterTopology=topology;
    } catch(error) {current.pending.delete(id);current.gutterTopology=undefined;reject(error);}
  });
  check?.();
  if('error' in response || response.mode!=='gutter') throw new Error('Invalid UV gutter Worker result.');
  return {imageData:new ImageData(new Uint8ClampedArray(response.imageData),image.width,image.height),
    coverage:new Uint8Array(response.coverage),paddedPixels:response.paddedPixels};
}
