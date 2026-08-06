export {};

const TOP_K = 3;
const BLEND_POWER = 2.4;
const RESIDUAL_MIX = 0.2;
const DOMINANCE_BLEND_START = 1.45;
const DOMINANCE_BLEND_END = 2.6;
const DOMINANCE_MARGIN_START = 0.05;
const DOMINANCE_MARGIN_END = 0.2;
const COLOR_CONSISTENCY_SIGMA = 0.22;
const COVERAGE_THRESHOLD = 0.02;
const QUALITY_FLOOR_FROM_COVERAGE = 0.08;
const GPU_BUFFER_USAGE_MAP_READ = 0x0001;
const GPU_BUFFER_USAGE_COPY_SRC = 0x0004;
const GPU_BUFFER_USAGE_COPY_DST = 0x0008;
const GPU_BUFFER_USAGE_UNIFORM = 0x0040;
const GPU_BUFFER_USAGE_STORAGE = 0x0080;
const GPU_MAP_MODE_READ = 0x0001;
const TILE_PIXELS = 262_144;
const WORKGROUP_SIZE = 256;
const MAX_VISUALLY_LOSSLESS_BYTE_DELTA = 1;
const MAX_VISUALLY_LOSSLESS_MISMATCH_RATIO = 0.00001;

const SRGB_BYTE_TO_LINEAR = Array.from({ length: 256 }, (_, value) => {
  const color = value / 255;
  return color <= 0.04045 ? color / 12.92 : ((color + 0.055) / 1.055) ** 2.4;
});

type BlendRequest = {
  type: 'blend';
  id: number;
  resolution: number;
  preserveCoverageConfidenceAlpha: boolean;
  verify: boolean;
  forceCpuOutput: boolean;
  interactive: boolean;
  layers: Array<{ color: ArrayBuffer; quality: ArrayBuffer }>;
  overlays: Array<{ color: ArrayBuffer; quality: ArrayBuffer }>;
};

type WorkerRequest = BlendRequest | { type: 'budget'; interactive: boolean };

type Verification = {
  byteMismatches: number;
  alphaByteMismatches: number;
  mismatchRatio: number;
  maximumByteDelta: number;
  firstMismatch?: {
    byteOffset: number;
    expectedRgba: number[];
    actualRgba: number[];
  };
  usedCpuOutput: boolean;
  acceptedGpuOutput: boolean;
};

type WorkerResponse =
  | {
      type: 'result';
      id: number;
      output: ArrayBuffer;
      coverage: ArrayBuffer;
      writtenTexels: number;
      backend: 'webgpu-worker' | 'cpu-worker';
      accumulateMs: number;
      resolveMs: number;
      overlayMs: number;
      totalMs: number;
      verification?: Verification;
    }
  | { type: 'error'; id: number; message: string };

type GpuBuffer = {
  destroy(): void;
  getMappedRange(): ArrayBuffer;
  mapAsync(mode: number): Promise<void>;
  unmap(): void;
};

type GpuPipeline = { getBindGroupLayout(index: number): unknown };

type GpuDevice = {
  createBindGroup(descriptor: unknown): unknown;
  createBuffer(descriptor: { size: number; usage: number }): GpuBuffer;
  createCommandEncoder(): {
    beginComputePass(): {
      dispatchWorkgroups(x: number): void;
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
  lost: Promise<unknown>;
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

type TopK = {
  colors: Uint32Array[];
  coverages: Float32Array[];
  qualities: Float32Array[];
  coverage: Uint8Array;
  writtenTexels: number;
};

const scope = self as unknown as {
  navigator: {
    gpu?: {
      requestAdapter(options?: { powerPreference?: 'high-performance' }): Promise<{
        requestDevice(): Promise<GpuDevice>;
      } | null>;
    };
  };
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
  postMessage(message: WorkerResponse, transfer?: Transferable[]): void;
};

let interactive = false;
let devicePromise: Promise<GpuDevice | undefined> | undefined;
let workQueue = Promise.resolve();
const gpuQualityApproval = {
  opaque: false,
  confidenceAlpha: false,
};

function clampByte(value: number) {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function smoothstep(edge0: number, edge1: number, value: number) {
  const t = Math.max(0, Math.min(1, (value - edge0) / Math.max(edge1 - edge0, 0.000001)));
  return t * t * (3 - 2 * t);
}

function linearToSrgbByte(value: number) {
  const color = Math.max(0, Math.min(1, value));
  const srgb = color <= 0.0031308 ? color * 12.92 : 1.055 * color ** (1 / 2.4) - 0.055;
  return clampByte(srgb * 255);
}

function packRgb(source: Uint8ClampedArray, offset: number) {
  return source[offset] | (source[offset + 1] << 8) | (source[offset + 2] << 16);
}

function createTopK(pixelCount: number): TopK {
  return {
    colors: Array.from({ length: TOP_K }, () => new Uint32Array(pixelCount)),
    coverages: Array.from({ length: TOP_K }, () => new Float32Array(pixelCount)),
    qualities: Array.from({ length: TOP_K }, () => new Float32Array(pixelCount)),
    coverage: new Uint8Array(pixelCount),
    writtenTexels: 0,
  };
}

async function yieldWorkerBudget() {
  await new Promise<void>((resolve) => setTimeout(resolve, interactive ? 8 : 0));
}

async function accumulate(topK: TopK, request: BlendRequest) {
  const pixelCount = request.resolution * request.resolution;
  for (const layer of request.layers) {
    const color = new Uint8ClampedArray(layer.color);
    const qualityMap = new Float32Array(layer.quality);
    for (let pixelIndex = 0, offset = 0; pixelIndex < pixelCount; pixelIndex += 1, offset += 4) {
      const coverage = color[offset + 3] / 255;
      if (coverage <= COVERAGE_THRESHOLD) continue;
      const quality = Math.max(qualityMap[pixelIndex], coverage * QUALITY_FLOOR_FROM_COVERAGE);
      let insertAt = -1;
      for (let slot = 0; slot < TOP_K; slot += 1) {
        if (quality > topK.qualities[slot][pixelIndex]) {
          insertAt = slot;
          break;
        }
      }
      if (insertAt < 0) continue;
      for (let slot = TOP_K - 1; slot > insertAt; slot -= 1) {
        topK.coverages[slot][pixelIndex] = topK.coverages[slot - 1][pixelIndex];
        topK.qualities[slot][pixelIndex] = topK.qualities[slot - 1][pixelIndex];
        topK.colors[slot][pixelIndex] = topK.colors[slot - 1][pixelIndex];
      }
      topK.coverages[insertAt][pixelIndex] = coverage;
      topK.qualities[insertAt][pixelIndex] = quality;
      topK.colors[insertAt][pixelIndex] = packRgb(color, offset);
      if (!topK.coverage[pixelIndex]) {
        topK.coverage[pixelIndex] = 1;
        topK.writtenTexels += 1;
      }
      if (interactive && pixelIndex > 0 && pixelIndex % 262_144 === 0) await yieldWorkerBudget();
    }
    await yieldWorkerBudget();
  }
}

function resolvePixelCpu(topK: TopK, pixelIndex: number, preserveAlpha: boolean, output: Uint8ClampedArray) {
  if (!topK.coverage[pixelIndex]) return false;
  const offset = pixelIndex * 4;
  let candidateCount = 0;
  let remaining = 1;
  const coverages = [0, 0, 0];
  const qualities = [0, 0, 0];
  const colors = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let slot = 0; slot < TOP_K; slot += 1) {
    const coverage = topK.coverages[slot][pixelIndex];
    coverages[slot] = coverage;
    qualities[slot] = topK.qualities[slot][pixelIndex];
    remaining *= 1 - Math.max(0, Math.min(1, coverage));
    if (coverage > COVERAGE_THRESHOLD) candidateCount += 1;
    const packed = topK.colors[slot][pixelIndex];
    colors[slot][0] = SRGB_BYTE_TO_LINEAR[packed & 255];
    colors[slot][1] = SRGB_BYTE_TO_LINEAR[(packed >>> 8) & 255];
    colors[slot][2] = SRGB_BYTE_TO_LINEAR[(packed >>> 16) & 255];
  }
  const alpha = preserveAlpha ? clampByte((1 - remaining) * 255) : 255;
  if (candidateCount === 1) {
    const packed = topK.colors[0][pixelIndex];
    output[offset] = packed & 255;
    output[offset + 1] = (packed >>> 8) & 255;
    output[offset + 2] = (packed >>> 16) & 255;
    output[offset + 3] = alpha;
    return true;
  }
  let totalQuality = 0;
  let baseRed = 0;
  let baseGreen = 0;
  let baseBlue = 0;
  for (let slot = 0; slot < TOP_K; slot += 1) {
    const quality = qualities[slot];
    if (quality <= 0) continue;
    totalQuality += quality;
    baseRed += colors[slot][0] * quality;
    baseGreen += colors[slot][1] * quality;
    baseBlue += colors[slot][2] * quality;
  }
  if (totalQuality > 0) {
    baseRed /= totalQuality;
    baseGreen /= totalQuality;
    baseBlue /= totalQuality;
    for (let slot = 0; slot < TOP_K; slot += 1) {
      if (qualities[slot] <= 0) continue;
      const diff = Math.hypot(
        colors[slot][0] - baseRed,
        colors[slot][1] - baseGreen,
        colors[slot][2] - baseBlue,
      );
      const consistency = Math.exp(
        -(diff * diff) / (COLOR_CONSISTENCY_SIGMA * COLOR_CONSISTENCY_SIGMA),
      );
      qualities[slot] *= 0.35 + 0.65 * consistency;
    }
  }
  let sumStrong = 0;
  let sumSoft = 0;
  for (let slot = 0; slot < TOP_K; slot += 1) {
    sumStrong += Math.max(0, qualities[slot]) ** BLEND_POWER;
    sumSoft += Math.max(0, coverages[slot]);
  }
  if (sumSoft <= 0.000001) return false;
  let finalRed = 0;
  let finalGreen = 0;
  let finalBlue = 0;
  for (let slot = 0; slot < TOP_K; slot += 1) {
    const quality = Math.max(0, qualities[slot]);
    const coverage = Math.max(0, coverages[slot]);
    if (coverage <= 0) continue;
    const strongWeight = quality ** BLEND_POWER / Math.max(sumStrong, 0.000001);
    const softWeight = coverage / sumSoft;
    const weight = strongWeight * (1 - RESIDUAL_MIX) + softWeight * RESIDUAL_MIX;
    finalRed += colors[slot][0] * weight;
    finalGreen += colors[slot][1] * weight;
    finalBlue += colors[slot][2] * weight;
  }
  const dominance =
    smoothstep(DOMINANCE_BLEND_START, DOMINANCE_BLEND_END, qualities[0] / Math.max(qualities[1], 0.000001)) *
    smoothstep(DOMINANCE_MARGIN_START, DOMINANCE_MARGIN_END, qualities[0] - qualities[1]);
  output[offset] = linearToSrgbByte(finalRed * (1 - dominance) + colors[0][0] * dominance);
  output[offset + 1] = linearToSrgbByte(finalGreen * (1 - dominance) + colors[0][1] * dominance);
  output[offset + 2] = linearToSrgbByte(finalBlue * (1 - dominance) + colors[0][2] * dominance);
  output[offset + 3] = alpha;
  return true;
}

async function resolveCpu(topK: TopK, preserveAlpha: boolean) {
  const output = new Uint8ClampedArray(topK.coverage.length * 4);
  let writtenTexels = 0;
  for (let pixelIndex = 0; pixelIndex < topK.coverage.length; pixelIndex += 1) {
    if (resolvePixelCpu(topK, pixelIndex, preserveAlpha, output)) writtenTexels += 1;
    if (interactive && pixelIndex > 0 && pixelIndex % 262_144 === 0) await yieldWorkerBudget();
  }
  return { output, writtenTexels };
}

async function applyOverlays(
  output: Uint8ClampedArray,
  coverage: Uint8Array,
  overlays: BlendRequest['overlays'],
) {
  let addedCoverage = 0;
  for (const overlay of overlays) {
    const imageData = new Uint8ClampedArray(overlay.color);
    const qualityMap = new Float32Array(overlay.quality);
    for (let pixelIndex = 0, offset = 0; offset < imageData.length; pixelIndex += 1, offset += 4) {
      const layerCoverage = imageData[offset + 3] / 255;
      if (layerCoverage <= COVERAGE_THRESHOLD) continue;
      const qualityFade = smoothstep(
        0,
        0.15,
        Math.max(qualityMap[pixelIndex], layerCoverage * 0.25),
      );
      const alpha = Math.max(0, Math.min(1, layerCoverage * (0.75 + 0.25 * qualityFade)));
      if (alpha <= 0.0001) continue;
      const baseAlpha = output[offset + 3] / 255;
      const outputAlpha = alpha + baseAlpha * (1 - alpha);
      if (outputAlpha <= 0.0001) continue;
      const retainedBaseAlpha = baseAlpha * (1 - alpha);
      output[offset] = linearToSrgbByte(
        (SRGB_BYTE_TO_LINEAR[output[offset]] * retainedBaseAlpha +
          SRGB_BYTE_TO_LINEAR[imageData[offset]] * alpha) /
          outputAlpha,
      );
      output[offset + 1] = linearToSrgbByte(
        (SRGB_BYTE_TO_LINEAR[output[offset + 1]] * retainedBaseAlpha +
          SRGB_BYTE_TO_LINEAR[imageData[offset + 1]] * alpha) /
          outputAlpha,
      );
      output[offset + 2] = linearToSrgbByte(
        (SRGB_BYTE_TO_LINEAR[output[offset + 2]] * retainedBaseAlpha +
          SRGB_BYTE_TO_LINEAR[imageData[offset + 2]] * alpha) /
          outputAlpha,
      );
      output[offset + 3] = Math.round(outputAlpha * 255);
      if (!coverage[pixelIndex]) {
        coverage[pixelIndex] = 1;
        addedCoverage += 1;
      }
      if (interactive && pixelIndex > 0 && pixelIndex % 262_144 === 0) {
        await yieldWorkerBudget();
      }
    }
    await yieldWorkerBudget();
  }
  return addedCoverage;
}

const shader = `
  struct Candidate {
    color: u32,
    coverage: f32,
    quality: f32,
    linearRed: f32,
    linearGreen: f32,
    linearBlue: f32,
  };
  @group(0) @binding(0) var<storage, read> candidates: array<Candidate>;
  @group(0) @binding(1) var<storage, read_write> output: array<u32>;
  struct Params { preserveCoverageAlpha: u32, _padding0: u32, _padding1: u32, _padding2: u32 };
  @group(0) @binding(2) var<uniform> params: Params;

  fn linearToSrgbByte(value: f32) -> u32 {
    let color = clamp(value, 0.0, 1.0);
    let srgb = select(1.055 * pow(color, 1.0 / 2.4) - 0.055, color * 12.92, color <= 0.0031308);
    return u32(clamp(floor(srgb * 255.0 + 0.5), 0.0, 255.0));
  }
  fn smoothStepExact(edge0: f32, edge1: f32, value: f32) -> f32 {
    let t = clamp((value - edge0) / max(edge1 - edge0, 0.000001), 0.0, 1.0);
    return t * t * (3.0 - 2.0 * t);
  }
  fn component(color: u32, shift: u32) -> u32 { return (color >> shift) & 255u; }
  fn outputAlpha(a: Candidate, b: Candidate, c: Candidate) -> u32 {
    if (params.preserveCoverageAlpha == 0u) { return 255u; }
    let confidence = 1.0 -
      (1.0 - clamp(a.coverage, 0.0, 1.0)) *
      (1.0 - clamp(b.coverage, 0.0, 1.0)) *
      (1.0 - clamp(c.coverage, 0.0, 1.0));
    return u32(clamp(floor(confidence * 255.0 + 0.5), 0.0, 255.0));
  }

  @compute @workgroup_size(${WORKGROUP_SIZE})
  fn resolve(@builtin(global_invocation_id) id: vec3<u32>) {
    let pixel = id.x;
    let base = pixel * 3u;
    if (base + 2u >= arrayLength(&candidates)) { return; }
    let a = candidates[base]; let b = candidates[base + 1u]; let c = candidates[base + 2u];
    let count = select(0u, 1u, a.coverage > ${COVERAGE_THRESHOLD}) + select(0u, 1u, b.coverage > ${COVERAGE_THRESHOLD}) + select(0u, 1u, c.coverage > ${COVERAGE_THRESHOLD});
    if (count == 0u) { output[pixel] = 0u; return; }
    let alpha = outputAlpha(a, b, c);
    if (count == 1u) { output[pixel] = a.color | (alpha << 24u); return; }
    let ca = vec3<f32>(a.linearRed, a.linearGreen, a.linearBlue);
    let cb = vec3<f32>(b.linearRed, b.linearGreen, b.linearBlue);
    let cc = vec3<f32>(c.linearRed, c.linearGreen, c.linearBlue);
    let totalQ = a.quality + b.quality + c.quality;
    let baseColor = (ca * a.quality + cb * b.quality + cc * c.quality) / max(totalQ, 0.000001);
    var qa = a.quality * (0.35 + 0.65 * exp(-dot(ca - baseColor, ca - baseColor) / ${COLOR_CONSISTENCY_SIGMA * COLOR_CONSISTENCY_SIGMA}));
    var qb = b.quality * (0.35 + 0.65 * exp(-dot(cb - baseColor, cb - baseColor) / ${COLOR_CONSISTENCY_SIGMA * COLOR_CONSISTENCY_SIGMA}));
    var qc = c.quality * (0.35 + 0.65 * exp(-dot(cc - baseColor, cc - baseColor) / ${COLOR_CONSISTENCY_SIGMA * COLOR_CONSISTENCY_SIGMA}));
    let strong = vec3<f32>(pow(max(qa, 0.0), ${BLEND_POWER}), pow(max(qb, 0.0), ${BLEND_POWER}), pow(max(qc, 0.0), ${BLEND_POWER}));
    let coverage = vec3<f32>(max(a.coverage, 0.0), max(b.coverage, 0.0), max(c.coverage, 0.0));
    let weights = (strong / max(strong.x + strong.y + strong.z, 0.000001)) * ${1 - RESIDUAL_MIX} + (coverage / max(coverage.x + coverage.y + coverage.z, 0.000001)) * ${RESIDUAL_MIX};
    let blended = ca * weights.x + cb * weights.y + cc * weights.z;
    let dominance = smoothStepExact(${DOMINANCE_BLEND_START}, ${DOMINANCE_BLEND_END}, qa / max(qb, 0.000001)) * smoothStepExact(${DOMINANCE_MARGIN_START}, ${DOMINANCE_MARGIN_END}, qa - qb);
    let finalColor = mix(blended, ca, dominance);
    output[pixel] = linearToSrgbByte(finalColor.r) | (linearToSrgbByte(finalColor.g) << 8u) | (linearToSrgbByte(finalColor.b) << 16u) | (alpha << 24u);
  }
`;

async function getDevice() {
  devicePromise ??= (async () => {
    const adapter = await scope.navigator.gpu?.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) return undefined;
    const device = await adapter.requestDevice();
    void device.lost.then(() => { devicePromise = undefined; });
    return device;
  })();
  return devicePromise;
}

async function resolveGpu(topK: TopK, preserveAlpha: boolean) {
  const device = await getDevice();
  if (!device) return undefined;
  const pipeline = device.createComputePipeline({
    layout: 'auto',
    compute: { module: device.createShaderModule({ code: shader, label: 'Li3D top-k quality blend' }), entryPoint: 'resolve' },
  });
  const finalOutput = new Uint8ClampedArray(topK.coverage.length * 4);
  for (let first = 0; first < topK.coverage.length; first += TILE_PIXELS) {
    const count = Math.min(TILE_PIXELS, topK.coverage.length - first);
    const packed = new ArrayBuffer(count * TOP_K * 24);
    const view = new DataView(packed);
    for (let local = 0; local < count; local += 1) {
      for (let slot = 0; slot < TOP_K; slot += 1) {
        const byteOffset = (local * TOP_K + slot) * 24;
        const pixel = first + local;
        const packedColor = topK.colors[slot][pixel];
        view.setUint32(byteOffset, packedColor, true);
        view.setFloat32(byteOffset + 4, topK.coverages[slot][pixel], true);
        view.setFloat32(byteOffset + 8, topK.qualities[slot][pixel], true);
        view.setFloat32(byteOffset + 12, SRGB_BYTE_TO_LINEAR[packedColor & 255], true);
        view.setFloat32(byteOffset + 16, SRGB_BYTE_TO_LINEAR[(packedColor >>> 8) & 255], true);
        view.setFloat32(byteOffset + 20, SRGB_BYTE_TO_LINEAR[(packedColor >>> 16) & 255], true);
      }
    }
    const outputBytes = count * 4;
    const inputBuffer = device.createBuffer({ size: packed.byteLength, usage: GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_COPY_DST });
    const outputBuffer = device.createBuffer({ size: outputBytes, usage: GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_COPY_SRC });
    const readback = device.createBuffer({ size: outputBytes, usage: GPU_BUFFER_USAGE_MAP_READ | GPU_BUFFER_USAGE_COPY_DST });
    const paramsBuffer = device.createBuffer({ size: 16, usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST });
    try {
      device.queue.writeBuffer(inputBuffer, 0, packed);
      const params = new Uint32Array(4);
      params[0] = preserveAlpha ? 1 : 0;
      device.queue.writeBuffer(paramsBuffer, 0, params.buffer);
      const bindGroup = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: inputBuffer } },
          { binding: 1, resource: { buffer: outputBuffer } },
          { binding: 2, resource: { buffer: paramsBuffer } },
        ],
      });
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.dispatchWorkgroups(Math.ceil(count / WORKGROUP_SIZE));
      pass.end();
      encoder.copyBufferToBuffer(outputBuffer, 0, readback, 0, outputBytes);
      device.queue.submit([encoder.finish()]);
      await device.queue.onSubmittedWorkDone();
      await readback.mapAsync(GPU_MAP_MODE_READ);
      finalOutput.set(new Uint8ClampedArray(readback.getMappedRange()), first * 4);
      readback.unmap();
    } finally {
      inputBuffer.destroy(); outputBuffer.destroy(); readback.destroy(); paramsBuffer.destroy();
    }
    await yieldWorkerBudget();
  }
  return finalOutput;
}

function verify(cpu: Uint8ClampedArray, gpu: Uint8ClampedArray): Verification {
  let byteMismatches = 0;
  let alphaByteMismatches = 0;
  let maximumByteDelta = 0;
  let firstMismatch: Verification['firstMismatch'];
  for (let offset = 0; offset < cpu.length; offset += 1) {
    const delta = Math.abs(cpu[offset] - gpu[offset]);
    if (delta === 0) continue;
    byteMismatches += 1;
    if (offset % 4 === 3) alphaByteMismatches += 1;
    maximumByteDelta = Math.max(maximumByteDelta, delta);
    if (!firstMismatch) {
      const pixelOffset = offset - (offset % 4);
      firstMismatch = {
        byteOffset: offset,
        expectedRgba: Array.from(cpu.subarray(pixelOffset, pixelOffset + 4)),
        actualRgba: Array.from(gpu.subarray(pixelOffset, pixelOffset + 4)),
      };
    }
  }
  return {
    byteMismatches,
    alphaByteMismatches,
    mismatchRatio: byteMismatches / Math.max(1, cpu.length),
    maximumByteDelta,
    firstMismatch,
    usedCpuOutput: false,
    acceptedGpuOutput: false,
  };
}

async function run(request: BlendRequest) {
  interactive = request.interactive;
  const startedAt = performance.now();
  const topK = createTopK(request.resolution * request.resolution);
  const accumulateStartedAt = performance.now();
  await accumulate(topK, request);
  const accumulateMs = performance.now() - accumulateStartedAt;
  const resolveStartedAt = performance.now();
  const approvedForMode = request.preserveCoverageConfidenceAlpha
    ? gpuQualityApproval.confidenceAlpha
    : gpuQualityApproval.opaque;
  const needsCpuReference =
    request.forceCpuOutput ||
    request.verify ||
    !approvedForMode;
  let cpu = needsCpuReference
    ? await resolveCpu(topK, request.preserveCoverageConfidenceAlpha)
    : undefined;
  let backend: 'webgpu-worker' | 'cpu-worker' = 'cpu-worker';
  let output = cpu?.output;
  let verification: Verification | undefined;
  try {
    const gpu = await resolveGpu(topK, request.preserveCoverageConfidenceAlpha);
    if (gpu) {
      backend = 'webgpu-worker';
      if (cpu) {
        verification = verify(cpu.output, gpu);
        const visuallyLossless =
          verification.alphaByteMismatches === 0 &&
          verification.maximumByteDelta <= MAX_VISUALLY_LOSSLESS_BYTE_DELTA &&
          verification.mismatchRatio <= MAX_VISUALLY_LOSSLESS_MISMATCH_RATIO;
        verification.acceptedGpuOutput = visuallyLossless && !request.forceCpuOutput;
        verification.usedCpuOutput = !verification.acceptedGpuOutput;
        if (visuallyLossless) {
          if (request.preserveCoverageConfidenceAlpha) {
            gpuQualityApproval.confidenceAlpha = true;
          } else {
            gpuQualityApproval.opaque = true;
          }
        }
        output = verification.acceptedGpuOutput ? gpu : cpu.output;
      } else {
        output = gpu;
      }
    }
  } catch {
    devicePromise = undefined;
  }
  if (!output) {
    cpu = await resolveCpu(topK, request.preserveCoverageConfidenceAlpha);
    output = cpu.output;
    backend = 'cpu-worker';
  }
  const resolveMs = performance.now() - resolveStartedAt;
  const overlayStartedAt = performance.now();
  const overlayAddedCoverage = await applyOverlays(output, topK.coverage, request.overlays);
  const overlayMs = performance.now() - overlayStartedAt;
  return {
    output,
    coverage: topK.coverage,
    writtenTexels: (cpu?.writtenTexels ?? topK.writtenTexels) + overlayAddedCoverage,
    backend,
    accumulateMs,
    resolveMs,
    overlayMs,
    totalMs: performance.now() - startedAt,
    verification,
  };
}

scope.onmessage = (event) => {
  const request = event.data;
  if (request.type === 'budget') {
    interactive = request.interactive;
    return;
  }
  workQueue = workQueue.then(async () => {
    try {
      const result = await run(request);
      const response: WorkerResponse = {
        type: 'result', id: request.id,
        output: result.output.buffer as ArrayBuffer,
        coverage: result.coverage.buffer as ArrayBuffer,
        writtenTexels: result.writtenTexels,
        backend: result.backend,
        accumulateMs: result.accumulateMs,
        resolveMs: result.resolveMs,
        overlayMs: result.overlayMs,
        totalMs: result.totalMs,
        verification: result.verification,
      };
      scope.postMessage(response, [response.output, response.coverage]);
    } catch (error) {
      scope.postMessage({ type: 'error', id: request.id, message: error instanceof Error ? error.message : String(error) });
    }
  });
};
