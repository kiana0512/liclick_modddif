// Frozen diagnostic resolver before sharing the canonical kernel (local 2026-09-29).
const TOP_K_BLEND_LAYERS=3,COVERAGE_THRESHOLD=.02,BLEND_POWER=2.4,RESIDUAL_MIX=.2,DOMINANCE_BLEND_START=1.45,DOMINANCE_BLEND_END=2.6,DOMINANCE_MARGIN_START=.05,DOMINANCE_MARGIN_END=.2,COLOR_CONSISTENCY_SIGMA=.22;
const yieldToBakeUi=async()=>{};
const clampByte=(v:number)=>Math.max(0,Math.min(255,Math.round(v)));
const srgbByteToLinear=(v:number)=>v/255<=.04045?v/255/12.92:((v/255+.055)/1.055)**2.4;
const linearToSrgbByte=(v:number)=>clampByte(255*(v<=.0031308?v*12.92:1.055*v**(1/2.4)-.055));
const smoothstepScalar=(a:number,b:number,v:number)=>{const t=Math.max(0,Math.min(1,(v-a)/(b-a)));return t*t*(3-2*t);};
function applyColorConsistency(qualities: number[], colors: number[][]) {
  let totalQuality = 0;
  let baseRed = 0;
  let baseGreen = 0;
  let baseBlue = 0;
  for (let index = 0; index < qualities.length; index += 1) {
    const quality = qualities[index];
    if (quality <= 0) continue;
    totalQuality += quality;
    baseRed += colors[index][0] * quality;
    baseGreen += colors[index][1] * quality;
    baseBlue += colors[index][2] * quality;
  }
  if (totalQuality <= 0) return;
  baseRed /= totalQuality;
  baseGreen /= totalQuality;
  baseBlue /= totalQuality;

  for (let index = 0; index < qualities.length; index += 1) {
    if (qualities[index] <= 0) continue;
    const color = colors[index];
    const diff = Math.hypot(color[0] - baseRed, color[1] - baseGreen, color[2] - baseBlue);
    const consistency = Math.exp(
      -(diff * diff) / (COLOR_CONSISTENCY_SIGMA * COLOR_CONSISTENCY_SIGMA),
    );
    qualities[index] *= 0.35 + 0.65 * consistency;
  }
}

export async function writeQualityBlendStackComposite(
  composite: QualityBlendStackComposite,
  output: ImageData,
  preserveCoverageConfidenceAlpha: boolean | 'display' = false,
) {
  let writtenTexels = 0;
  const colors = Array.from({ length: TOP_K_BLEND_LAYERS }, () => [0, 0, 0]);
  const coverages = new Array<number>(TOP_K_BLEND_LAYERS).fill(0);
  const qualities = new Array<number>(TOP_K_BLEND_LAYERS).fill(0);

  for (
    let pixelIndex = 0, offset = 0;
    pixelIndex < composite.coverage.length;
    pixelIndex += 1, offset += 4
  ) {
    if (pixelIndex > 0 && pixelIndex % 8_192 === 0) await yieldToBakeUi();
    if (!composite.coverage[pixelIndex]) continue;
    const colorOffset = pixelIndex * 3;
    let candidateCount = 0;
    for (let slot = 0; slot < TOP_K_BLEND_LAYERS; slot += 1) {
      coverages[slot] = composite.coverages[slot][pixelIndex];
      qualities[slot] = composite.qualities[slot][pixelIndex];
      if (coverages[slot] > COVERAGE_THRESHOLD) candidateCount += 1;
    }
    const coverageConfidence =
      1 -
      coverages.reduce(
        (remaining, coverage) => remaining * (1 - Math.max(0, Math.min(1, coverage))),
        1,
      );
    const outputAlpha = preserveCoverageConfidenceAlpha
      ? clampByte((preserveCoverageConfidenceAlpha === 'display'
        ? smoothstepScalar(0, 0.12, coverageConfidence) : coverageConfidence) * 255)
      : 255;

    if (candidateCount === 1) {
      output.data[offset] = composite.colors[0][colorOffset];
      output.data[offset + 1] = composite.colors[0][colorOffset + 1];
      output.data[offset + 2] = composite.colors[0][colorOffset + 2];
      output.data[offset + 3] = outputAlpha;
      writtenTexels += 1;
      continue;
    }

    for (let slot = 0; slot < TOP_K_BLEND_LAYERS; slot += 1) {
      colors[slot][0] = srgbByteToLinear(composite.colors[slot][colorOffset]);
      colors[slot][1] = srgbByteToLinear(composite.colors[slot][colorOffset + 1]);
      colors[slot][2] = srgbByteToLinear(composite.colors[slot][colorOffset + 2]);
    }

    applyColorConsistency(qualities, colors);
    let sumStrong = 0;
    let sumSoft = 0;
    for (let slot = 0; slot < TOP_K_BLEND_LAYERS; slot += 1) {
      const effectiveQuality = Math.max(0, qualities[slot]);
      sumStrong += effectiveQuality ** BLEND_POWER;
      sumSoft += Math.max(0, coverages[slot]);
    }
    if (sumSoft <= 0.000001) continue;

    let finalRed = 0;
    let finalGreen = 0;
    let finalBlue = 0;
    for (let slot = 0; slot < TOP_K_BLEND_LAYERS; slot += 1) {
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

    const qualityRatio = qualities[0] / Math.max(qualities[1], 0.000001);
    const dominance =
      smoothstepScalar(DOMINANCE_BLEND_START, DOMINANCE_BLEND_END, qualityRatio) *
      smoothstepScalar(
        DOMINANCE_MARGIN_START,
        DOMINANCE_MARGIN_END,
        qualities[0] - qualities[1],
      );
    const winnerRed = colors[0][0];
    const winnerGreen = colors[0][1];
    const winnerBlue = colors[0][2];
    output.data[offset] = linearToSrgbByte(finalRed * (1 - dominance) + winnerRed * dominance);
    output.data[offset + 1] = linearToSrgbByte(
      finalGreen * (1 - dominance) + winnerGreen * dominance,
    );
    output.data[offset + 2] = linearToSrgbByte(
      finalBlue * (1 - dominance) + winnerBlue * dominance,
    );
    output.data[offset + 3] = outputAlpha;
    writtenTexels += 1;
  }
  return writtenTexels;
}
