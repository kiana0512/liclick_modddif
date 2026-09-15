// Canonical ALG-UV-003 pixel resolver, shared by the Worker and sparse GPU rounding correction.
const TOP_K = 3;
const BLEND_POWER = 2.4;
const RESIDUAL_MIX = 0.2;
const DOMINANCE_BLEND_START = 1.45;
const DOMINANCE_BLEND_END = 2.6;
const DOMINANCE_MARGIN_START = 0.05;
const DOMINANCE_MARGIN_END = 0.2;
const COLOR_CONSISTENCY_SIGMA = 0.22;
const COVERAGE_THRESHOLD = 0.02;

// Synchronous, non-reentrant kernel: every slot is overwritten before reading.
// Reuse only scratch, never output. Sparse GPU correction can call this hundreds
// of thousands of times; per-pixel nested arrays cause avoidable GC stalls.
const pixelCoverages = [0, 0, 0];
const pixelQualities = [0, 0, 0];
const pixelColors = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];


const SRGB_BYTE_TO_LINEAR = Array.from({ length: 256 }, (_, value) => {
  const color = value / 255;
  return color <= 0.04045 ? color / 12.92 : ((color + 0.055) / 1.055) ** 2.4;
});


type TopK = {
  colors: Uint32Array[];
  coverages: Float32Array[];
  qualities: Float32Array[];
  coverage: Uint8Array;
  writtenTexels: number;
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


export function resolvePixelCpu(topK: TopK, pixelIndex: number, preserveAlpha: boolean, output: Uint8ClampedArray) {
  if (!topK.coverage[pixelIndex]) return false;
  const offset = pixelIndex * 4;
  let candidateCount = 0;
  let remaining = 1;
  const coverages = pixelCoverages;
  const qualities = pixelQualities;
  const colors = pixelColors;
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
