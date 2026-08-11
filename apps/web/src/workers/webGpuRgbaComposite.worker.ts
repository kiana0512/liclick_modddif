import { encodeRgbaPngBytesChunked } from '@/utils/encodeRgbaPngCore';

export {};

const GPU_BUFFER_USAGE_MAP_READ = 0x0001;
const GPU_BUFFER_USAGE_COPY_SRC = 0x0004;
const GPU_BUFFER_USAGE_COPY_DST = 0x0008;
const GPU_BUFFER_USAGE_UNIFORM = 0x0040;
const GPU_BUFFER_USAGE_STORAGE = 0x0080;
const GPU_MAP_MODE_READ = 0x0001;
const WORKGROUP_SIZE = 256;
const INTERACTIVE_GPU_PAUSE_MS = 8;

type GpuBuffer = {
  destroy(): void;
  getMappedRange(offset?: number, size?: number): ArrayBuffer;
  mapAsync(mode: number, offset?: number, size?: number): Promise<void>;
  unmap(): void;
};

type GpuPipeline = { getBindGroupLayout(index: number): unknown };

type GpuDevice = {
  createBindGroup(descriptor: unknown): unknown;
  createBuffer(descriptor: { size: number; usage: number }): GpuBuffer;
  createCommandEncoder(): {
    beginComputePass(): {
      dispatchWorkgroups(x: number, y?: number, z?: number): void;
      end(): void;
      setBindGroup(index: number, bindGroup: unknown): void;
      setPipeline(pipeline: GpuPipeline): void;
    };
    copyBufferToBuffer(
      source: GpuBuffer,
      sourceOffset: number,
      destination: GpuBuffer,
      destinationOffset: number,
      size: number,
    ): void;
    finish(): unknown;
  };
  createComputePipeline(descriptor: unknown): GpuPipeline;
  createShaderModule(descriptor: { code: string; label?: string }): unknown;
  lost: Promise<{ message?: string }>;
  queue: {
    onSubmittedWorkDone(): Promise<void>;
    submit(commands: unknown[]): void;
    writeBuffer(
      target: GpuBuffer,
      targetOffset: number,
      source: ArrayBuffer,
      sourceOffset?: number,
      size?: number,
    ): void;
  };
};

type CompositeResources = {
  device: GpuDevice;
  byteLength: number;
  pipeline: GpuPipeline;
  front: GpuBuffer;
  underlay: GpuBuffer;
  params: GpuBuffer;
  readback: GpuBuffer;
};

type CompositeRequest = {
  type: 'composite';
  id: number;
  front: ArrayBuffer;
  underlay?: ArrayBuffer;
  underlayUrl?: string;
  width?: number;
  height?: number;
  opacity: number;
  verify: boolean;
  interactive: boolean;
  interactiveChunkBytes: number;
  idleChunkBytes: number;
  encodePng?: boolean;
};

type NormalizedCompositeRequest = CompositeRequest & { underlay: ArrayBuffer };

type WorkerRequest =
  | CompositeRequest
  | { type: 'budget'; interactive: boolean }
  | { type: 'release' };

type CompositeMetrics = {
  uploadMs: number;
  computeMs: number;
  readbackMs: number;
  totalMs: number;
  bytesTransferred: number;
  chunkBytes: number;
  backend: 'webgpu-worker' | 'cpu-worker';
};

type WorkerResponse =
  | {
      type: 'result';
      id: number;
      output?: ArrayBuffer;
      pngBlob?: Blob;
      encodeMs?: number;
      metrics: CompositeMetrics;
      verification?: CompositeVerification;
    }
  | { type: 'error'; id: number; message: string };

type WebGpuWorkerNavigator = {
  gpu?: {
    requestAdapter(options?: { powerPreference?: 'high-performance' }): Promise<{
      requestDevice(): Promise<GpuDevice>;
    } | null>;
  };
};

type CompositeVerification = {
  byteMismatches: number;
  maximumByteDelta: number;
  firstMismatch?: {
    byteOffset: number;
    expectedRgba: number[];
    actualRgba: number[];
  };
  usedCpuOutput: boolean;
};

const scope = self as unknown as {
  navigator: WebGpuWorkerNavigator;
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
  postMessage(message: WorkerResponse, transfer?: Transferable[]): void;
};

let interactive = false;
let devicePromise: Promise<GpuDevice | undefined> | undefined;
let resources: CompositeResources | undefined;
let workQueue: Promise<void> = Promise.resolve();

const shaderSource = `
  struct Params {
    firstPixel: u32,
    pixelCount: u32,
    opacity: f32,
    workgroupsPerRow: u32,
  };

  @group(0) @binding(0) var<storage, read_write> frontPixels: array<u32>;
  @group(0) @binding(1) var<storage, read> underlayPixels: array<u32>;
  @group(0) @binding(2) var<uniform> params: Params;

  fn byteAt(pixel: u32, shift: u32) -> u32 {
    return (pixel >> shift) & 255u;
  }

  fn roundedByte(value: f32) -> u32 {
    return u32(clamp(floor(value + 0.5), 0.0, 255.0));
  }

  @compute @workgroup_size(256)
  fn compositeUnder(@builtin(global_invocation_id) invocation: vec3<u32>) {
    let localIndex = invocation.y * params.workgroupsPerRow * 256u + invocation.x;
    if (localIndex >= params.pixelCount) { return; }
    let index = params.firstPixel + localIndex;
    let front = frontPixels[index];
    let underlay = underlayPixels[index];
    let frontAlpha = f32(byteAt(front, 24u)) / 255.0;
    let underlayAlpha = (f32(byteAt(underlay, 24u)) / 255.0) * params.opacity;
    let visibleUnderlayAlpha = underlayAlpha * (1.0 - frontAlpha);
    let outputAlpha = frontAlpha + visibleUnderlayAlpha;

    if (outputAlpha <= 0.0) {
      let frontRgb = front & 0x00ffffffu;
      frontPixels[index] = select(frontRgb, underlay & 0x00ffffffu, frontRgb == 0u);
      return;
    }

    let red = roundedByte((f32(byteAt(front, 0u)) * frontAlpha +
      f32(byteAt(underlay, 0u)) * visibleUnderlayAlpha) / outputAlpha);
    let green = roundedByte((f32(byteAt(front, 8u)) * frontAlpha +
      f32(byteAt(underlay, 8u)) * visibleUnderlayAlpha) / outputAlpha);
    let blue = roundedByte((f32(byteAt(front, 16u)) * frontAlpha +
      f32(byteAt(underlay, 16u)) * visibleUnderlayAlpha) / outputAlpha);
    let alpha = roundedByte(outputAlpha * 255.0);
    frontPixels[index] = red | (green << 8u) | (blue << 16u) | (alpha << 24u);
  }
`;

function wait(durationMs = 0) {
  return new Promise<void>((resolve) => setTimeout(resolve, durationMs));
}

async function yieldGpuBudget() {
  await wait(interactive ? INTERACTIVE_GPU_PAUSE_MS : 0);
}

function activeChunkBytes(request: CompositeRequest) {
  return Math.max(
    256,
    Math.floor(
      (interactive ? request.interactiveChunkBytes : request.idleChunkBytes) / 256,
    ) * 256,
  );
}

async function getDevice() {
  devicePromise ??= (async () => {
    const adapter = await scope.navigator.gpu?.requestAdapter({
      powerPreference: 'high-performance',
    });
    if (!adapter) return undefined;
    const device = await adapter.requestDevice();
    void device.lost.then(() => {
      if (resources?.device === device) destroyResources();
      devicePromise = undefined;
    });
    return device;
  })();
  return devicePromise;
}

function destroyResources() {
  resources?.front.destroy();
  resources?.underlay.destroy();
  resources?.params.destroy();
  resources?.readback.destroy();
  resources = undefined;
}

function getResources(device: GpuDevice, byteLength: number) {
  if (resources?.device === device && resources.byteLength === byteLength) return resources;
  destroyResources();
  const pipeline = device.createComputePipeline({
    label: 'Li3D worker straight-alpha RGBA underlay pipeline',
    layout: 'auto',
    compute: {
      module: device.createShaderModule({
        label: 'Li3D worker straight-alpha RGBA underlay composite',
        code: shaderSource,
      }),
      entryPoint: 'compositeUnder',
    },
  });
  resources = {
    device,
    byteLength,
    pipeline,
    front: device.createBuffer({
      size: byteLength,
      usage: GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_COPY_DST | GPU_BUFFER_USAGE_COPY_SRC,
    }),
    underlay: device.createBuffer({
      size: byteLength,
      usage: GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_COPY_DST,
    }),
    params: device.createBuffer({
      size: 16,
      usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST,
    }),
    readback: device.createBuffer({
      size: byteLength,
      usage: GPU_BUFFER_USAGE_MAP_READ | GPU_BUFFER_USAGE_COPY_DST,
    }),
  };
  return resources;
}

async function uploadInBudgetedChunks(
  device: GpuDevice,
  target: GpuBuffer,
  source: ArrayBuffer,
  request: NormalizedCompositeRequest,
) {
  for (let offset = 0; offset < source.byteLength; ) {
    const size = Math.min(activeChunkBytes(request), source.byteLength - offset);
    device.queue.writeBuffer(target, offset, source, offset, size);
    offset += size;
    if (interactive) await device.queue.onSubmittedWorkDone();
    if (offset < source.byteLength) await yieldGpuBudget();
  }
}

async function computeInBudgetedChunks(
  device: GpuDevice,
  target: CompositeResources,
  opacity: number,
  request: NormalizedCompositeRequest,
) {
  const bindGroup = device.createBindGroup({
    layout: target.pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: target.front } },
      { binding: 1, resource: { buffer: target.underlay } },
      { binding: 2, resource: { buffer: target.params } },
    ],
  });
  const totalPixels = target.byteLength / 4;
  for (let firstPixel = 0; firstPixel < totalPixels; ) {
    const pixelCount = Math.min(activeChunkBytes(request) / 4, totalPixels - firstPixel);
    const totalWorkgroups = Math.ceil(pixelCount / WORKGROUP_SIZE);
    const workgroupsPerRow = Math.min(256, totalWorkgroups);
    const params = new ArrayBuffer(16);
    new Uint32Array(params)[0] = firstPixel;
    new Uint32Array(params)[1] = pixelCount;
    new Float32Array(params)[2] = opacity;
    new Uint32Array(params)[3] = workgroupsPerRow;
    device.queue.writeBuffer(target.params, 0, params, 0, 16);
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(target.pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(workgroupsPerRow, Math.ceil(totalWorkgroups / workgroupsPerRow));
    pass.end();
    device.queue.submit([encoder.finish()]);
    firstPixel += pixelCount;
    if (interactive) await device.queue.onSubmittedWorkDone();
    if (firstPixel < totalPixels) await yieldGpuBudget();
  }
  await device.queue.onSubmittedWorkDone();
}

async function copyToReadbackInBudgetedChunks(
  device: GpuDevice,
  target: CompositeResources,
  request: NormalizedCompositeRequest,
) {
  const output = new ArrayBuffer(target.byteLength);
  const outputBytes = new Uint8Array(output);
  // Mapping the complete 64MiB result in one operation can stall Chromium's
  // compositor even though this code runs in a worker. Map bounded 8MiB ranges
  // and copy them into worker-owned memory before PNG encoding.
  const readbackChunkBytes = Math.max(activeChunkBytes(request), 8 * 1024 * 1024);
  for (let offset = 0; offset < target.byteLength; ) {
    const size = Math.min(readbackChunkBytes, target.byteLength - offset);
    const encoder = device.createCommandEncoder();
    encoder.copyBufferToBuffer(target.front, offset, target.readback, offset, size);
    device.queue.submit([encoder.finish()]);
    await device.queue.onSubmittedWorkDone();
    await target.readback.mapAsync(GPU_MAP_MODE_READ, offset, size);
    outputBytes.set(new Uint8Array(target.readback.getMappedRange(offset, size)), offset);
    target.readback.unmap();
    offset += size;
    if (offset < target.byteLength) await yieldGpuBudget();
  }
  return output;
}

function compositeOnCpu(frontBuffer: ArrayBuffer, underlayBuffer: ArrayBuffer, opacity: number) {
  const front = new Uint8ClampedArray(frontBuffer);
  const underlay = new Uint8ClampedArray(underlayBuffer);
  for (let offset = 0; offset < front.length; offset += 4) {
    const frontAlpha = front[offset + 3] / 255;
    const underlayAlpha = (underlay[offset + 3] / 255) * opacity;
    const visibleUnderlayAlpha = underlayAlpha * (1 - frontAlpha);
    const outputAlpha = frontAlpha + visibleUnderlayAlpha;
    if (outputAlpha <= 0) {
      if (front[offset] === 0 && front[offset + 1] === 0 && front[offset + 2] === 0) {
        front[offset] = underlay[offset];
        front[offset + 1] = underlay[offset + 1];
        front[offset + 2] = underlay[offset + 2];
      }
      continue;
    }
    front[offset] = Math.round(
      (front[offset] * frontAlpha + underlay[offset] * visibleUnderlayAlpha) / outputAlpha,
    );
    front[offset + 1] = Math.round(
      (front[offset + 1] * frontAlpha + underlay[offset + 1] * visibleUnderlayAlpha) /
        outputAlpha,
    );
    front[offset + 2] = Math.round(
      (front[offset + 2] * frontAlpha + underlay[offset + 2] * visibleUnderlayAlpha) /
        outputAlpha,
    );
    front[offset + 3] = Math.round(outputAlpha * 255);
  }
  return frontBuffer;
}

async function loadUnderlayInWorker(request: CompositeRequest) {
  if (request.underlay) return request.underlay;
  if (!request.underlayUrl || !request.width || !request.height) {
    throw new Error('Composite underlay source is missing.');
  }
  const response = await fetch(request.underlayUrl);
  if (!response.ok) throw new Error(`Could not load UV underlay (${response.status}).`);
  const bitmap = await createImageBitmap(await response.blob());
  try {
    const canvas = new OffscreenCanvas(request.width, request.height);
    const context = canvas.getContext('2d', { alpha: true, willReadFrequently: true });
    if (!context) throw new Error('Could not create UV underlay worker canvas.');
    context.drawImage(bitmap, 0, 0, request.width, request.height);
    return context.getImageData(0, 0, request.width, request.height).data.buffer as ArrayBuffer;
  } finally {
    bitmap.close();
  }
}

async function runComposite(rawRequest: CompositeRequest) {
  const request: NormalizedCompositeRequest = {
    ...rawRequest,
    underlay: await loadUnderlayInWorker(rawRequest),
  };
  interactive = request.interactive;
  const startedAt = performance.now();
  const device = await getDevice();
  if (!device) {
    const output = compositeOnCpu(request.front, request.underlay, request.opacity);
    return {
      output,
      metrics: {
        uploadMs: 0,
        computeMs: performance.now() - startedAt,
        readbackMs: 0,
        totalMs: performance.now() - startedAt,
        bytesTransferred: request.front.byteLength * 2,
        chunkBytes: activeChunkBytes(request),
        backend: 'cpu-worker' as const,
      },
    };
  }

  try {
    const target = getResources(device, request.front.byteLength);
    const uploadStartedAt = performance.now();
    await uploadInBudgetedChunks(device, target.front, request.front, request);
    await uploadInBudgetedChunks(device, target.underlay, request.underlay, request);
    const uploadMs = performance.now() - uploadStartedAt;
    const computeStartedAt = performance.now();
    await computeInBudgetedChunks(device, target, request.opacity, request);
    const computeMs = performance.now() - computeStartedAt;
    const readbackStartedAt = performance.now();
    const output = await copyToReadbackInBudgetedChunks(device, target, request);
    const readbackMs = performance.now() - readbackStartedAt;
    return {
      output,
      metrics: {
        uploadMs,
        computeMs,
        readbackMs,
        totalMs: performance.now() - startedAt,
        bytesTransferred: request.front.byteLength * 3,
        chunkBytes: activeChunkBytes(request),
        backend: 'webgpu-worker' as const,
      },
    };
  } catch {
    // A driver/device failure must not send the 4K arrays back to the UI
    // thread. Preserve exact output in the same worker with the parity path.
    destroyResources();
    devicePromise = undefined;
    const cpuStartedAt = performance.now();
    const output = compositeOnCpu(request.front, request.underlay, request.opacity);
    return {
      output,
      metrics: {
        uploadMs: 0,
        computeMs: performance.now() - cpuStartedAt,
        readbackMs: 0,
        totalMs: performance.now() - startedAt,
        bytesTransferred: request.front.byteLength * 2,
        chunkBytes: activeChunkBytes(request),
        backend: 'cpu-worker' as const,
      },
    };
  }
}

function verifyGpuOutput(
  request: NormalizedCompositeRequest,
  gpuOutput: ArrayBuffer,
): { output: ArrayBuffer; verification?: CompositeVerification } {
  if (!request.verify) return { output: gpuOutput };
  const cpuOutput = compositeOnCpu(
    request.front.slice(0),
    request.underlay,
    request.opacity,
  );
  const expected = new Uint8ClampedArray(cpuOutput);
  const actual = new Uint8ClampedArray(gpuOutput);
  let byteMismatches = 0;
  let maximumByteDelta = 0;
  let firstMismatch: CompositeVerification['firstMismatch'];
  for (let offset = 0; offset < expected.length; offset += 1) {
    const delta = Math.abs(expected[offset] - actual[offset]);
    if (delta > 0) {
      byteMismatches += 1;
      if (!firstMismatch) {
        const pixelOffset = offset - (offset % 4);
        firstMismatch = {
          byteOffset: offset,
          expectedRgba: Array.from(expected.subarray(pixelOffset, pixelOffset + 4)),
          actualRgba: Array.from(actual.subarray(pixelOffset, pixelOffset + 4)),
        };
      }
      maximumByteDelta = Math.max(maximumByteDelta, delta);
    }
  }
  const usedCpuOutput = byteMismatches > 0;
  return {
    output: usedCpuOutput ? cpuOutput : gpuOutput,
    verification: {
      byteMismatches,
      maximumByteDelta,
      firstMismatch,
      usedCpuOutput,
    },
  };
}

scope.onmessage = (event) => {
  const request = event.data;
  if (request.type === 'budget') {
    interactive = request.interactive;
    return;
  }
  if (request.type === 'release') {
    destroyResources();
    return;
  }
  workQueue = workQueue.then(async () => {
    try {
      const normalizedRequest: NormalizedCompositeRequest = {
        ...request,
        underlay: await loadUnderlayInWorker(request),
      };
      const result = await runComposite(normalizedRequest);
      const verified =
        result.metrics.backend === 'webgpu-worker'
          ? verifyGpuOutput(normalizedRequest, result.output)
          : { output: result.output };
      if (request.encodePng) {
        if (!request.width || !request.height) {
          throw new Error('PNG output dimensions are missing.');
        }
        const encodeStartedAt = performance.now();
        let pngBlob: Blob;
        if (interactive && typeof OffscreenCanvas !== 'undefined') {
          // Chromium's native worker encoder keeps the compositor responsive
          // during an active 4K viewport. putImageData is lossless RGBA; only
          // PNG container compression differs from the deterministic idle path.
          const canvas = new OffscreenCanvas(request.width, request.height);
          const context = canvas.getContext('2d', { alpha: true });
          if (!context) throw new Error('Could not create interactive PNG canvas.');
          context.putImageData(
            new ImageData(
              new Uint8ClampedArray(verified.output),
              request.width,
              request.height,
            ),
            0,
            0,
          );
          pngBlob = await canvas.convertToBlob({ type: 'image/png' });
        } else {
          const encoded = await encodeRgbaPngBytesChunked(
            request.width,
            request.height,
            new Uint8ClampedArray(verified.output),
            () => wait(0),
          );
          pngBlob = new Blob([encoded], { type: 'image/png' });
        }
        const response: WorkerResponse = {
          type: 'result',
          id: request.id,
          pngBlob,
          encodeMs: performance.now() - encodeStartedAt,
          metrics: result.metrics,
          verification: verified.verification,
        };
        scope.postMessage(response);
      } else {
        const response: WorkerResponse = {
          type: 'result',
          id: request.id,
          output: verified.output,
          metrics: result.metrics,
          verification: verified.verification,
        };
        scope.postMessage(response, [verified.output]);
      }
    } catch (error) {
      const response: WorkerResponse = {
        type: 'error',
        id: request.id,
        message: error instanceof Error ? error.message : String(error),
      };
      scope.postMessage(response);
    }
  });
};
