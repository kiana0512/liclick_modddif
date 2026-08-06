export type GpuComputeBackendKind = 'webgpu' | 'webgl2-worker' | 'cpu-worker';

export type GpuComputeBackendCapability = {
  kind: GpuComputeBackendKind;
  available: boolean;
  adapterName?: string;
  reason?: string;
  runtimeStatus: 'capability-only' | 'ready' | 'fallback' | 'failed';
  selfTestDispatches: number;
  productionDispatches: number;
};

type WebGpuAdapterLike = {
  info?: { device?: string; description?: string; vendor?: string };
  requestDevice(): Promise<WebGpuDeviceLike>;
};

export type WebGpuBufferLike = {
  destroy(): void;
  getMappedRange(): ArrayBuffer;
  mapAsync(mode: number): Promise<void>;
  unmap(): void;
};

export type WebGpuComputePipelineLike = {
  getBindGroupLayout(index: number): unknown;
};

type WebGpuCommandEncoderLike = {
  beginComputePass(): {
    dispatchWorkgroups(x: number, y?: number, z?: number): void;
    end(): void;
    setBindGroup(index: number, bindGroup: unknown): void;
    setPipeline(pipeline: WebGpuComputePipelineLike): void;
  };
  copyBufferToBuffer(
    source: WebGpuBufferLike,
    sourceOffset: number,
    destination: WebGpuBufferLike,
    destinationOffset: number,
    size: number,
  ): void;
  finish(): unknown;
};

export type WebGpuDeviceLike = {
  createBindGroup(descriptor: unknown): unknown;
  createBuffer(descriptor: { size: number; usage: number }): WebGpuBufferLike;
  createCommandEncoder(): WebGpuCommandEncoderLike;
  createComputePipeline(descriptor: unknown): WebGpuComputePipelineLike;
  createShaderModule(descriptor: { code: string; label?: string }): unknown;
  destroy?(): void;
  lost: Promise<{ message?: string; reason?: string }>;
  queue: {
    onSubmittedWorkDone(): Promise<void>;
    submit(commandBuffers: unknown[]): void;
    writeBuffer(
      buffer: WebGpuBufferLike,
      bufferOffset: number,
      data: ArrayBuffer,
      dataOffset?: number,
      size?: number,
    ): void;
  };
};

type WebGpuNavigatorLike = Navigator & {
  gpu?: {
    requestAdapter(options?: { powerPreference?: 'low-power' | 'high-performance' }): Promise<
      WebGpuAdapterLike | null
    >;
  };
};

let capabilityPromise: Promise<GpuComputeBackendCapability> | undefined;
let runtimePromise: Promise<GpuComputeBackendCapability> | undefined;
let retainedDevice: WebGpuDeviceLike | undefined;
let currentRuntimeStatus: GpuComputeBackendCapability | undefined;

const GPU_BUFFER_USAGE_COPY_SRC = 0x0004;
const GPU_BUFFER_USAGE_COPY_DST = 0x0008;
const GPU_BUFFER_USAGE_STORAGE = 0x0080;
const GPU_BUFFER_USAGE_MAP_READ = 0x0001;
const GPU_MAP_MODE_READ = 0x0001;
const WEBGPU_SELF_TEST_VALUE = 0x4c693344;

function probeWebGl2WorkerFallback(): GpuComputeBackendCapability {
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(1, 1);
    if (canvas.getContext('webgl2')) {
      return {
        kind: 'webgl2-worker',
        available: true,
        reason: 'WebGPU 不可用，使用 Worker 独立 WebGL2 上下文。',
        runtimeStatus: 'fallback',
        selfTestDispatches: 0,
        productionDispatches: 0,
      };
    }
  }
  return {
    kind: 'cpu-worker',
    available: typeof Worker !== 'undefined',
    reason: 'WebGPU/Worker WebGL2 不可用，使用可中断 CPU Worker。',
    runtimeStatus: 'fallback',
    selfTestDispatches: 0,
    productionDispatches: 0,
  };
}

async function probeCapability(): Promise<GpuComputeBackendCapability> {
  const webGpu = (navigator as WebGpuNavigatorLike).gpu;
  if (!webGpu) return probeWebGl2WorkerFallback();
  try {
    const adapter = await webGpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) return probeWebGl2WorkerFallback();
    return {
      kind: 'webgpu',
      available: true,
      adapterName:
        adapter.info?.device || adapter.info?.description || adapter.info?.vendor || 'WebGPU adapter',
      runtimeStatus: 'capability-only',
      selfTestDispatches: 0,
      productionDispatches: 0,
    };
  } catch (error) {
    const fallback = probeWebGl2WorkerFallback();
    return {
      ...fallback,
      reason: `WebGPU 探测失败：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Side-effect-light capability probe. It requests an adapter but deliberately
 * does not allocate a GPUDevice, command queue or large buffers. Actual compute
 * stages request those lazily and must retain the fallback selected here.
 */
export function probeGpuComputeBackend() {
  capabilityPromise ??= probeCapability();
  return capabilityPromise;
}

async function initializeWebGpuRuntime(): Promise<GpuComputeBackendCapability> {
  const capability = await probeGpuComputeBackend();
  if (capability.kind !== 'webgpu') return capability;

  const webGpu = (navigator as WebGpuNavigatorLike).gpu;
  if (!webGpu) return probeWebGl2WorkerFallback();
  const adapter = await webGpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) return probeWebGl2WorkerFallback();

  let outputBuffer: WebGpuBufferLike | undefined;
  let readbackBuffer: WebGpuBufferLike | undefined;
  try {
    const device = await adapter.requestDevice();
    retainedDevice = device;
    void device.lost.then((info) => {
      if (retainedDevice !== device) return;
      retainedDevice = undefined;
      runtimePromise = undefined;
      console.warn(
        `[Liclick 3D Texture] WebGPU device lost${info.reason ? ` (${info.reason})` : ''}: ${info.message ?? 'unknown reason'}`,
      );
    });

    const shader = device.createShaderModule({
      label: 'Li3D WebGPU runtime self-test',
      code: `
        @group(0) @binding(0) var<storage, read_write> outputValue: array<u32>;
        @compute @workgroup_size(1)
        fn main() {
          outputValue[0] = 0x4c693344u;
        }
      `,
    });
    const pipeline = device.createComputePipeline({
      label: 'Li3D WebGPU runtime self-test pipeline',
      layout: 'auto',
      compute: { module: shader, entryPoint: 'main' },
    });
    outputBuffer = device.createBuffer({
      size: 4,
      usage: GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_COPY_SRC,
    });
    readbackBuffer = device.createBuffer({
      size: 4,
      usage: GPU_BUFFER_USAGE_COPY_DST | GPU_BUFFER_USAGE_MAP_READ,
    });
    const bindGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: outputBuffer } }],
    });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(1);
    pass.end();
    encoder.copyBufferToBuffer(outputBuffer, 0, readbackBuffer, 0, 4);
    device.queue.submit([encoder.finish()]);
    await device.queue.onSubmittedWorkDone();
    await readbackBuffer.mapAsync(GPU_MAP_MODE_READ);
    const actual = new Uint32Array(readbackBuffer.getMappedRange().slice(0))[0];
    readbackBuffer.unmap();
    if (actual !== WEBGPU_SELF_TEST_VALUE) {
      throw new Error(`WebGPU self-test mismatch: ${actual.toString(16)}`);
    }
    return {
      ...capability,
      runtimeStatus: 'ready',
      selfTestDispatches: 1,
    };
  } catch (error) {
    retainedDevice?.destroy?.();
    retainedDevice = undefined;
    const fallback = probeWebGl2WorkerFallback();
    return {
      ...fallback,
      runtimeStatus: 'failed',
      reason: `WebGPU 运行时初始化失败：${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    outputBuffer?.destroy();
    readbackBuffer?.destroy();
  }
}

/**
 * Creates one retained high-performance GPUDevice and validates a real compute
 * dispatch. Production stages reuse this device; they must not create a device
 * or transfer a full 4K buffer per operation.
 */
export function prepareGpuComputeBackend() {
  runtimePromise ??= initializeWebGpuRuntime().then((status) => {
    currentRuntimeStatus = status;
    return status;
  });
  return runtimePromise;
}

export async function getRetainedWebGpuDevice() {
  const status = await prepareGpuComputeBackend();
  return status.kind === 'webgpu' && status.runtimeStatus === 'ready'
    ? retainedDevice
    : undefined;
}

export function recordWebGpuProductionDispatch() {
  if (!currentRuntimeStatus || currentRuntimeStatus.kind !== 'webgpu') return;
  currentRuntimeStatus = {
    ...currentRuntimeStatus,
    productionDispatches: currentRuntimeStatus.productionDispatches + 1,
  };
  if (typeof window !== 'undefined') {
    window.dispatchEvent(
      new CustomEvent<GpuComputeBackendCapability>('liclick-webgpu-status', {
        detail: currentRuntimeStatus,
      }),
    );
  }
}

export function resetGpuComputeBackendProbeForTests() {
  retainedDevice?.destroy?.();
  retainedDevice = undefined;
  currentRuntimeStatus = undefined;
  capabilityPromise = undefined;
  runtimePromise = undefined;
}
