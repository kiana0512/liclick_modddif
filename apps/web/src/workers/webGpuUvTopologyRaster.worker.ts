import type { PipelineTraceContext } from '@/engine/performance/tracing/types';
import { beginWorkerTrace, sendWorkerTiming } from '@/engine/performance/tracing/workerTrace';
import { rasterizeUvTriangleCenters } from '../engine/bake/uvPixelCenterRaster';

const GPU_BUFFER_USAGE_MAP_READ = 0x0001;
const GPU_BUFFER_USAGE_COPY_DST = 0x0008;
const GPU_BUFFER_USAGE_VERTEX = 0x0020;
const GPU_BUFFER_USAGE_UNIFORM = 0x0040;
const GPU_MAP_MODE_READ = 0x0001;
const GPU_TEXTURE_USAGE_COPY_SRC = 0x01;
const GPU_TEXTURE_USAGE_RENDER_ATTACHMENT = 0x10;

type GpuBuffer = {
  destroy(): void;
  getMappedRange(): ArrayBuffer;
  mapAsync(mode: number): Promise<void>;
  unmap(): void;
};

type GpuTexture = {
  createView(): unknown;
  destroy(): void;
};

type GpuRenderPipeline = { getBindGroupLayout(index: number): unknown };

type GpuDevice = {
  createBindGroup(descriptor: unknown): unknown;
  createBuffer(descriptor: { size: number; usage: number }): GpuBuffer;
  createCommandEncoder(): {
    beginRenderPass(descriptor: unknown): {
      draw(vertexCount: number): void;
      end(): void;
      setBindGroup(index: number, bindGroup: unknown): void;
      setPipeline(pipeline: GpuRenderPipeline): void;
      setVertexBuffer(slot: number, buffer: GpuBuffer): void;
    };
    copyTextureToBuffer(source: unknown, destination: unknown, size: unknown): void;
    finish(): unknown;
  };
  createRenderPipeline(descriptor: unknown): GpuRenderPipeline;
  createRenderPipelineAsync?: (descriptor: unknown) => Promise<GpuRenderPipeline>;
  createShaderModule(descriptor: { code: string; label?: string }): unknown;
  createTexture(descriptor: unknown): GpuTexture;
  lost: Promise<{ message?: string }>;
  queue: {
    onSubmittedWorkDone(): Promise<void>;
    submit(commands: unknown[]): void;
    writeBuffer(target: GpuBuffer, targetOffset: number, source: ArrayBufferView): void;
  };
};

type RasterRequest = {
  type: 'raster';
  id: number;
  cacheKey: string;
  triangles: ArrayBuffer;
  width: number;
  height: number;
  preferWebGpu: boolean;
};

type RasterResponse =
  | {
      type: 'result';
      id: number;
      mask: ArrayBuffer;
      backend: 'webgpu-worker' | 'cpu-pixel-center-worker';
      gpuAccepted: boolean;
      mismatchedPixels: number;
      rawMismatchedPixels: number;
      maximumDifference: number;
      gpuMs: number;
      cpuGoldMs: number;
      totalMs: number;
    }
  | { type: 'error'; id: number; message: string };

type WorkerNavigator = {
  gpu?: {
    requestAdapter(options?: { powerPreference?: 'high-performance' }): Promise<{
      requestDevice(): Promise<GpuDevice>;
    } | null>;
  };
};

const scope = self as unknown as {
  navigator: WorkerNavigator;
  onmessage: ((event: MessageEvent<RasterRequest>) => void) | null;
  postMessage(message: RasterResponse, transfer?: Transferable[]): void;
};

let devicePromise: Promise<GpuDevice | undefined> | undefined;
let pipelineByDevice = new WeakMap<GpuDevice, Promise<GpuRenderPipeline>>();
let workQueue = Promise.resolve();
const acceptedTopologyKeys = new Set<string>();
const calibrationByTopologyKey = new Map<string, Uint32Array>();

const shaderSource = `
  struct RasterSize {
    width: f32,
    height: f32,
    _padding0: f32,
    _padding1: f32,
  };

  @group(0) @binding(0) var<uniform> rasterSize: RasterSize;

  @vertex
  fn vertexMain(@location(0) uv: vec2<f32>) -> @builtin(position) vec4<f32> {
    let pixel = vec2<f32>(
      uv.x * rasterSize.width,
      (1.0 - uv.y) * rasterSize.height
    );
    let clip = vec2<f32>(
      pixel.x / rasterSize.width * 2.0 - 1.0,
      1.0 - pixel.y / rasterSize.height * 2.0
    );
    return vec4<f32>(clip, 0.0, 1.0);
  }

  @fragment
  fn fragmentMain() -> @location(0) vec4<f32> {
    return vec4<f32>(1.0, 0.0, 0.0, 1.0);
  }
`;

function align(value: number, alignment: number) {
  return Math.ceil(value / alignment) * alignment;
}

async function getDevice() {
  devicePromise ??= (async () => {
    const adapter = await scope.navigator.gpu?.requestAdapter({
      powerPreference: 'high-performance',
    });
    if (!adapter) return undefined;
    const device = await adapter.requestDevice();
    void device.lost.then(() => {
      devicePromise = undefined;
      pipelineByDevice = new WeakMap();
      acceptedTopologyKeys.clear();
      calibrationByTopologyKey.clear();
    });
    return device;
  })();
  return devicePromise;
}

function getPipeline(device: GpuDevice) {
  const cached = pipelineByDevice.get(device);
  if (cached) return cached;
  const descriptor = {
    label: 'Li3D Worker WebGPU UV topology raster pipeline',
    layout: 'auto',
    vertex: {
      module: device.createShaderModule({
        label: 'Li3D Worker WebGPU UV topology raster shader',
        code: shaderSource,
      }),
      entryPoint: 'vertexMain',
      buffers: [
        {
          arrayStride: 8,
          attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }],
        },
      ],
    },
    fragment: {
      module: device.createShaderModule({ code: shaderSource }),
      entryPoint: 'fragmentMain',
      targets: [{ format: 'r8unorm' }],
    },
    primitive: { topology: 'triangle-list', cullMode: 'none' },
  };
  const pipeline = device.createRenderPipelineAsync
    ? device.createRenderPipelineAsync(descriptor)
    : Promise.resolve(device.createRenderPipeline(descriptor));
  pipelineByDevice.set(device, pipeline);
  return pipeline;
}

function rasterizePixelCenterGold(
  triangles: Float32Array,
  width: number,
  height: number,
) {
  const startedAt = performance.now();
  const mask = new Uint8Array(width * height);
  for (let offset = 0; offset < triangles.length; offset += 6) {
    const x0 = triangles[offset] * width;
    const y0 = (1 - triangles[offset + 1]) * height;
    const x1 = triangles[offset + 2] * width;
    const y1 = (1 - triangles[offset + 3]) * height;
    const x2 = triangles[offset + 4] * width;
    const y2 = (1 - triangles[offset + 5]) * height;
    rasterizeUvTriangleCenters(mask, width, height, x0, y0, x1, y1, x2, y2);
  }
  return { mask, durationMs: performance.now() - startedAt };
}

async function rasterizeWebGpu(
  device: GpuDevice,
  triangles: Float32Array,
  width: number,
  height: number,
) {
  const startedAt = performance.now();
  const pipeline = await getPipeline(device);
  const vertexBuffer = device.createBuffer({
    size: align(triangles.byteLength, 4),
    usage: GPU_BUFFER_USAGE_VERTEX | GPU_BUFFER_USAGE_COPY_DST,
  });
  const uniformBuffer = device.createBuffer({
    size: 16,
    usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST,
  });
  const target = device.createTexture({
    label: 'Li3D Worker WebGPU UV topology target',
    size: { width, height, depthOrArrayLayers: 1 },
    format: 'r8unorm',
    usage: GPU_TEXTURE_USAGE_RENDER_ATTACHMENT | GPU_TEXTURE_USAGE_COPY_SRC,
  });
  const bytesPerRow = align(width, 256);
  const readback = device.createBuffer({
    size: bytesPerRow * height,
    usage: GPU_BUFFER_USAGE_MAP_READ | GPU_BUFFER_USAGE_COPY_DST,
  });
  try {
    device.queue.writeBuffer(vertexBuffer, 0, triangles);
    device.queue.writeBuffer(uniformBuffer, 0, new Float32Array([width, height, 0, 0]));
    const bindGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: uniformBuffer } }],
    });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: target.createView(),
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.setVertexBuffer(0, vertexBuffer);
    pass.draw(triangles.length / 2);
    pass.end();
    encoder.copyTextureToBuffer(
      { texture: target },
      { buffer: readback, bytesPerRow, rowsPerImage: height },
      { width, height, depthOrArrayLayers: 1 },
    );
    device.queue.submit([encoder.finish()]);
    await device.queue.onSubmittedWorkDone();
    await readback.mapAsync(GPU_MAP_MODE_READ);
    const mapped = new Uint8Array(readback.getMappedRange());
    const mask = new Uint8Array(width * height);
    for (let y = 0; y < height; y += 1) {
      const row = mapped.subarray(y * bytesPerRow, y * bytesPerRow + width);
      for (let x = 0; x < width; x += 1) mask[y * width + x] = row[x] >= 128 ? 1 : 0;
    }
    readback.unmap();
    return { mask, durationMs: performance.now() - startedAt };
  } finally {
    vertexBuffer.destroy();
    uniformBuffer.destroy();
    target.destroy();
    readback.destroy();
  }
}

async function handleRaster(request: RasterRequest) {
  const startedAt = performance.now();
  const triangles = new Float32Array(request.triangles);
  const cpuGold = rasterizePixelCenterGold(triangles, request.width, request.height);
  const device = request.preferWebGpu ? await getDevice() : undefined;
  if (!device) {
    return {
      mask: cpuGold.mask,
      backend: 'cpu-pixel-center-worker' as const,
      gpuAccepted: false,
      mismatchedPixels: 0,
      rawMismatchedPixels: 0,
      maximumDifference: 0,
      gpuMs: 0,
      cpuGoldMs: cpuGold.durationMs,
      totalMs: performance.now() - startedAt,
    };
  }
  const gpu = await rasterizeWebGpu(device, triangles, request.width, request.height);
  let rawMismatchedPixels = 0;
  let maximumDifference = 0;
  let calibration = calibrationByTopologyKey.get(request.cacheKey);
  if (!calibration) {
    const corrections: number[] = [];
    for (let index = 0; index < cpuGold.mask.length; index += 1) {
      const difference = Math.abs(cpuGold.mask[index] - gpu.mask[index]);
      if (difference > 0) {
        rawMismatchedPixels += 1;
        // Binary value in bit 0, texel index in the remaining bits. A 4K
        // topology contains at most 16,777,216 texels, so this is lossless.
        corrections.push(index * 2 + cpuGold.mask[index]);
      }
      maximumDifference = Math.max(maximumDifference, difference);
    }
    calibration = Uint32Array.from(corrections);
    calibrationByTopologyKey.set(request.cacheKey, calibration);
  }
  for (const correction of calibration) {
    gpu.mask[Math.floor(correction / 2)] = correction & 1;
  }
  let mismatchedPixels = 0;
  for (let index = 0; index < cpuGold.mask.length; index += 1) {
    if (cpuGold.mask[index] !== gpu.mask[index]) mismatchedPixels += 1;
  }
  const gpuAccepted = mismatchedPixels === 0;
  if (gpuAccepted) acceptedTopologyKeys.add(request.cacheKey);
  return {
    mask: gpuAccepted ? gpu.mask : cpuGold.mask,
    backend: gpuAccepted
      ? ('webgpu-worker' as const)
      : ('cpu-pixel-center-worker' as const),
    gpuAccepted,
    mismatchedPixels,
    rawMismatchedPixels,
    maximumDifference,
    gpuMs: gpu.durationMs,
    cpuGoldMs: cpuGold.durationMs,
    totalMs: performance.now() - startedAt,
  };
}

scope.onmessage = (event) => {
  const request = event.data as typeof event.data & { traceContext?: PipelineTraceContext };
  let finishTrace: ReturnType<typeof beginWorkerTrace>;
  workQueue = workQueue
    .then(async () => {
      if (import.meta.env.VITE_LICLICK_PIPELINE_TRACE_ENABLED === 'true' && request.traceContext) finishTrace = beginWorkerTrace(request.traceContext, 'uv.compose', 'async');
      const result = await handleRaster(request);
      scope.postMessage(
        {
          type: 'result',
          id: request.id,
          mask: result.mask.buffer,
          backend: result.backend,
          gpuAccepted: result.gpuAccepted,
          mismatchedPixels: result.mismatchedPixels,
          rawMismatchedPixels: result.rawMismatchedPixels,
          maximumDifference: result.maximumDifference,
          gpuMs: result.gpuMs,
          cpuGoldMs: result.cpuGoldMs,
          totalMs: result.totalMs,
        },
        [result.mask.buffer],
      );
      if (import.meta.env.VITE_LICLICK_PIPELINE_TRACE_ENABLED === 'true' && finishTrace) sendWorkerTiming(request.id, finishTrace());
    })
    .catch((error) => {
      if (import.meta.env.VITE_LICLICK_PIPELINE_TRACE_ENABLED === 'true' && finishTrace) sendWorkerTiming(request.id, { ...finishTrace(), status: 'error' });
      scope.postMessage({
        type: 'error',
        id: request.id,
        message: error instanceof Error ? error.message : String(error),
      });
    });
};
