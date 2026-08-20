export type LocalRepaintSeamHarmonizationOptions = {
  minBlendWidth?: number;
  maxBlendWidth?: number;
  enableColorMatch?: boolean;
};

export type LocalRepaintSeamHarmonizationReport = {
  applied: boolean;
  blendWidth: number;
  sampledPixels: number;
  reason?: 'empty-mask' | 'full-frame-mask' | 'insufficient-boundary-samples';
};

type LabStats = {
  mean: [number, number, number];
  standardDeviation: [number, number, number];
  count: number;
};

const INF = 1_000_000;

function clamp(value: number, minimum: number, maximum: number) {
  return Math.max(minimum, Math.min(maximum, value));
}

function smoothstep(edge0: number, edge1: number, value: number) {
  const t = clamp((value - edge0) / Math.max(edge1 - edge0, 0.0001), 0, 1);
  return t * t * (3 - 2 * t);
}

function srgbToLinear(value: number) {
  const normalized = value / 255;
  return normalized <= 0.04045
    ? normalized / 12.92
    : ((normalized + 0.055) / 1.055) ** 2.4;
}

function linearToSrgb(value: number) {
  const clamped = clamp(value, 0, 1);
  const encoded =
    clamped <= 0.0031308
      ? clamped * 12.92
      : 1.055 * clamped ** (1 / 2.4) - 0.055;
  return encoded * 255;
}

function rgbToLab(red: number, green: number, blue: number): [number, number, number] {
  const r = srgbToLinear(red);
  const g = srgbToLinear(green);
  const b = srgbToLinear(blue);
  const x = (r * 0.4124564 + g * 0.3575761 + b * 0.1804375) / 0.95047;
  const y = r * 0.2126729 + g * 0.7151522 + b * 0.072175;
  const z = (r * 0.0193339 + g * 0.119192 + b * 0.9503041) / 1.08883;
  const convert = (value: number) =>
    value > 0.008856451679 ? Math.cbrt(value) : 7.787037037 * value + 16 / 116;
  const fx = convert(x);
  const fy = convert(y);
  const fz = convert(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

function labToRgb(lightness: number, a: number, b: number): [number, number, number] {
  const fy = (lightness + 16) / 116;
  const fx = fy + a / 500;
  const fz = fy - b / 200;
  const convert = (value: number) => {
    const cubed = value ** 3;
    return cubed > 0.008856451679 ? cubed : (value - 16 / 116) / 7.787037037;
  };
  const x = 0.95047 * convert(fx);
  const y = convert(fy);
  const z = 1.08883 * convert(fz);
  const r = x * 3.2404542 + y * -1.5371385 + z * -0.4985314;
  const g = x * -0.969266 + y * 1.8760108 + z * 0.041556;
  const blue = x * 0.0556434 + y * -0.2040259 + z * 1.0572252;
  return [linearToSrgb(r), linearToSrgb(g), linearToSrgb(blue)];
}

function createHardMask(mask: Uint8ClampedArray) {
  const output = new Uint8Array(mask.length / 4);
  let insideCount = 0;
  for (let index = 0; index < output.length; index += 1) {
    const offset = index * 4;
    const coverage =
      (Math.max(mask[offset] ?? 0, mask[offset + 1] ?? 0, mask[offset + 2] ?? 0) / 255) *
      ((mask[offset + 3] ?? 0) / 255);
    if (coverage >= 0.5) {
      output[index] = 1;
      insideCount += 1;
    }
  }
  return { mask: output, insideCount };
}

function distanceToValue(mask: Uint8Array, width: number, height: number, target: 0 | 1) {
  const distance = new Float32Array(mask.length);
  for (let index = 0; index < mask.length; index += 1) {
    distance[index] = mask[index] === target ? 0 : INF;
  }
  const diagonal = Math.SQRT2;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      let value = distance[index] ?? INF;
      if (x > 0) value = Math.min(value, (distance[index - 1] ?? INF) + 1);
      if (y > 0) value = Math.min(value, (distance[index - width] ?? INF) + 1);
      if (x > 0 && y > 0)
        value = Math.min(value, (distance[index - width - 1] ?? INF) + diagonal);
      if (x + 1 < width && y > 0)
        value = Math.min(value, (distance[index - width + 1] ?? INF) + diagonal);
      distance[index] = value;
    }
  }
  for (let y = height - 1; y >= 0; y -= 1) {
    for (let x = width - 1; x >= 0; x -= 1) {
      const index = y * width + x;
      let value = distance[index] ?? INF;
      if (x + 1 < width) value = Math.min(value, (distance[index + 1] ?? INF) + 1);
      if (y + 1 < height) value = Math.min(value, (distance[index + width] ?? INF) + 1);
      if (x + 1 < width && y + 1 < height)
        value = Math.min(value, (distance[index + width + 1] ?? INF) + diagonal);
      if (x > 0 && y + 1 < height)
        value = Math.min(value, (distance[index + width - 1] ?? INF) + diagonal);
      distance[index] = value;
    }
  }
  return distance;
}

function collectLabStats(
  pixels: Uint8ClampedArray,
  include: (index: number) => boolean,
): LabStats {
  let count = 0;
  const mean = [0, 0, 0];
  const m2 = [0, 0, 0];
  for (let index = 0; index < pixels.length / 4; index += 1) {
    if (!include(index)) continue;
    const offset = index * 4;
    if ((pixels[offset + 3] ?? 0) < 16) continue;
    const lab = rgbToLab(pixels[offset] ?? 0, pixels[offset + 1] ?? 0, pixels[offset + 2] ?? 0);
    count += 1;
    for (let channel = 0; channel < 3; channel += 1) {
      const delta = lab[channel] - (mean[channel] ?? 0);
      mean[channel] = (mean[channel] ?? 0) + delta / count;
      m2[channel] = (m2[channel] ?? 0) + delta * (lab[channel] - (mean[channel] ?? 0));
    }
  }
  return {
    mean: [mean[0] ?? 0, mean[1] ?? 0, mean[2] ?? 0],
    standardDeviation: [
      Math.sqrt((m2[0] ?? 0) / Math.max(count - 1, 1)),
      Math.sqrt((m2[1] ?? 0) / Math.max(count - 1, 1)),
      Math.sqrt((m2[2] ?? 0) / Math.max(count - 1, 1)),
    ],
    count,
  };
}

function boxBlurRgb(input: Uint8ClampedArray, width: number, height: number, radius: number) {
  if (radius <= 0) return new Uint8ClampedArray(input);
  const temporary = new Float32Array(width * height * 3);
  const output = new Uint8ClampedArray(input.length);
  const diameter = radius * 2 + 1;
  for (let y = 0; y < height; y += 1) {
    const sums = [0, 0, 0];
    for (let x = -radius; x <= radius; x += 1) {
      const sourceX = clamp(x, 0, width - 1);
      const offset = (y * width + sourceX) * 4;
      sums[0] += input[offset] ?? 0;
      sums[1] += input[offset + 1] ?? 0;
      sums[2] += input[offset + 2] ?? 0;
    }
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 3;
      temporary[offset] = (sums[0] ?? 0) / diameter;
      temporary[offset + 1] = (sums[1] ?? 0) / diameter;
      temporary[offset + 2] = (sums[2] ?? 0) / diameter;
      const removeX = clamp(x - radius, 0, width - 1);
      const addX = clamp(x + radius + 1, 0, width - 1);
      const removeOffset = (y * width + removeX) * 4;
      const addOffset = (y * width + addX) * 4;
      sums[0] += (input[addOffset] ?? 0) - (input[removeOffset] ?? 0);
      sums[1] += (input[addOffset + 1] ?? 0) - (input[removeOffset + 1] ?? 0);
      sums[2] += (input[addOffset + 2] ?? 0) - (input[removeOffset + 2] ?? 0);
    }
  }
  for (let x = 0; x < width; x += 1) {
    const sums = [0, 0, 0];
    for (let y = -radius; y <= radius; y += 1) {
      const sourceY = clamp(y, 0, height - 1);
      const offset = (sourceY * width + x) * 3;
      sums[0] += temporary[offset] ?? 0;
      sums[1] += temporary[offset + 1] ?? 0;
      sums[2] += temporary[offset + 2] ?? 0;
    }
    for (let y = 0; y < height; y += 1) {
      const pixelOffset = (y * width + x) * 4;
      output[pixelOffset] = Math.round((sums[0] ?? 0) / diameter);
      output[pixelOffset + 1] = Math.round((sums[1] ?? 0) / diameter);
      output[pixelOffset + 2] = Math.round((sums[2] ?? 0) / diameter);
      output[pixelOffset + 3] = input[pixelOffset + 3] ?? 255;
      const removeY = clamp(y - radius, 0, height - 1);
      const addY = clamp(y + radius + 1, 0, height - 1);
      const removeOffset = (removeY * width + x) * 3;
      const addOffset = (addY * width + x) * 3;
      sums[0] += (temporary[addOffset] ?? 0) - (temporary[removeOffset] ?? 0);
      sums[1] += (temporary[addOffset + 1] ?? 0) - (temporary[removeOffset + 1] ?? 0);
      sums[2] += (temporary[addOffset + 2] ?? 0) - (temporary[removeOffset + 2] ?? 0);
    }
  }
  return output;
}

function applyLowFrequencyLabCorrection(
  generated: Uint8ClampedArray,
  width: number,
  height: number,
  sourceStats: LabStats,
  targetStats: LabStats,
  blurRadius: number,
) {
  const lowFrequency = boxBlurRgb(generated, width, height, blurRadius);
  const output = new Uint8ClampedArray(generated);
  const scale: [number, number, number] = [
    clamp(
      targetStats.standardDeviation[0] / Math.max(sourceStats.standardDeviation[0], 1),
      0.78,
      1.22,
    ),
    clamp(
      targetStats.standardDeviation[1] / Math.max(sourceStats.standardDeviation[1], 1),
      0.85,
      1.15,
    ),
    clamp(
      targetStats.standardDeviation[2] / Math.max(sourceStats.standardDeviation[2], 1),
      0.85,
      1.15,
    ),
  ];
  for (let index = 0; index < generated.length / 4; index += 1) {
    const offset = index * 4;
    const originalLow = [
      lowFrequency[offset] ?? 0,
      lowFrequency[offset + 1] ?? 0,
      lowFrequency[offset + 2] ?? 0,
    ] as const;
    const lab = rgbToLab(originalLow[0], originalLow[1], originalLow[2]);
    const correctedLab: [number, number, number] = [
      clamp((lab[0] - sourceStats.mean[0]) * scale[0] + targetStats.mean[0], 0, 100),
      clamp((lab[1] - sourceStats.mean[1]) * scale[1] + targetStats.mean[1], -128, 127),
      clamp((lab[2] - sourceStats.mean[2]) * scale[2] + targetStats.mean[2], -128, 127),
    ];
    const correctedLow = labToRgb(correctedLab[0], correctedLab[1], correctedLab[2]);
    for (let channel = 0; channel < 3; channel += 1) {
      const delta = correctedLow[channel] - originalLow[channel];
      output[offset + channel] = Math.round(clamp((generated[offset + channel] ?? 0) + delta, 0, 255));
    }
    output[offset + 3] = generated[offset + 3] ?? 255;
  }
  return output;
}

export function harmonizeLocalRepaintPixels(input: {
  generated: Uint8ClampedArray;
  reference: Uint8ClampedArray;
  mask: Uint8ClampedArray;
  width: number;
  height: number;
  options?: LocalRepaintSeamHarmonizationOptions;
}): { pixels: Uint8ClampedArray; report: LocalRepaintSeamHarmonizationReport } {
  const { generated, reference, mask, width, height } = input;
  if (
    generated.length !== width * height * 4 ||
    reference.length !== generated.length ||
    mask.length !== generated.length
  ) {
    throw new Error('Local repaint seam inputs must have identical RGBA dimensions.');
  }
  const hardMaskResult = createHardMask(mask);
  if (hardMaskResult.insideCount === 0) {
    return {
      pixels: new Uint8ClampedArray(generated),
      report: { applied: false, blendWidth: 0, sampledPixels: 0, reason: 'empty-mask' },
    };
  }
  if (hardMaskResult.insideCount === hardMaskResult.mask.length) {
    return {
      pixels: new Uint8ClampedArray(generated),
      report: { applied: false, blendWidth: 0, sampledPixels: 0, reason: 'full-frame-mask' },
    };
  }
  const minimumBlendWidth = input.options?.minBlendWidth ?? 8;
  const maximumBlendWidth = input.options?.maxBlendWidth ?? 32;
  const blendWidth = clamp(
    Math.round(Math.min(width, height) * 0.018),
    minimumBlendWidth,
    maximumBlendWidth,
  );
  const insideDistance = distanceToValue(hardMaskResult.mask, width, height, 0);
  const outsideDistance = distanceToValue(hardMaskResult.mask, width, height, 1);
  const innerStart = Math.max(2, Math.round(blendWidth * 0.2));
  let sampledPixels = 0;
  let corrected = new Uint8ClampedArray(generated);
  // The Lab matcher is intentionally dormant for now. Keeping it behind an
  // explicit option lets us evaluate it later without coupling this release's
  // boundary-only blend to a global colour change.
  if (input.options?.enableColorMatch === true) {
    const sourceStats = collectLabStats(
      generated,
      (index) =>
        hardMaskResult.mask[index] === 1 &&
        (insideDistance[index] ?? INF) >= innerStart &&
        (insideDistance[index] ?? INF) <= blendWidth,
    );
    const targetStats = collectLabStats(
      reference,
      (index) =>
        (hardMaskResult.mask[index] === 1 &&
          (insideDistance[index] ?? INF) >= innerStart &&
          (insideDistance[index] ?? INF) <= blendWidth) ||
        (hardMaskResult.mask[index] === 0 &&
          (outsideDistance[index] ?? INF) >= 1 &&
          (outsideDistance[index] ?? INF) <= blendWidth),
    );
    sampledPixels = Math.min(sourceStats.count, targetStats.count);
    const minimumSamples = Math.max(64, Math.round(blendWidth * 4));
    if (sourceStats.count >= minimumSamples && targetStats.count >= minimumSamples) {
      corrected = applyLowFrequencyLabCorrection(
        generated,
        width,
        height,
        sourceStats,
        targetStats,
        Math.max(4, Math.round(blendWidth / 2)),
      );
    }
  }
  const mediumRadius = Math.max(2, Math.round(blendWidth / 6));
  const lowRadius = Math.max(mediumRadius + 1, Math.round(blendWidth / 2));
  const generatedMedium = boxBlurRgb(corrected, width, height, mediumRadius);
  const generatedLow = boxBlurRgb(corrected, width, height, lowRadius);
  const referenceMedium = boxBlurRgb(reference, width, height, mediumRadius);
  const referenceLow = boxBlurRgb(reference, width, height, lowRadius);
  const output = new Uint8ClampedArray(corrected.length);
  for (let index = 0; index < hardMaskResult.mask.length; index += 1) {
    const offset = index * 4;
    const distance = hardMaskResult.mask[index] === 1 ? (insideDistance[index] ?? 0) : 0;
    if (distance >= blendWidth) {
      output[offset] = corrected[offset] ?? 0;
      output[offset + 1] = corrected[offset + 1] ?? 0;
      output[offset + 2] = corrected[offset + 2] ?? 0;
      output[offset + 3] = generated[offset + 3] ?? 255;
      continue;
    }
    const lowWeight = smoothstep(0, blendWidth, distance);
    const mediumWeight = smoothstep(0, Math.max(2, blendWidth * 0.55), distance);
    const fineWeight = smoothstep(0, Math.max(1, blendWidth * 0.24), distance);
    for (let channel = 0; channel < 3; channel += 1) {
      const referenceLowValue = referenceLow[offset + channel] ?? 0;
      const generatedLowValue = generatedLow[offset + channel] ?? 0;
      const referenceMediumBand =
        (referenceMedium[offset + channel] ?? 0) - referenceLowValue;
      const generatedMediumBand =
        (generatedMedium[offset + channel] ?? 0) - generatedLowValue;
      const referenceFineBand =
        (reference[offset + channel] ?? 0) - (referenceMedium[offset + channel] ?? 0);
      const generatedFineBand =
        (corrected[offset + channel] ?? 0) - (generatedMedium[offset + channel] ?? 0);
      const value =
        referenceLowValue * (1 - lowWeight) +
        generatedLowValue * lowWeight +
        referenceMediumBand * (1 - mediumWeight) +
        generatedMediumBand * mediumWeight +
        referenceFineBand * (1 - fineWeight) +
        generatedFineBand * fineWeight;
      output[offset + channel] = Math.round(clamp(value, 0, 255));
    }
    // Projection coverage and authored brush feather remain the sole authority
    // for alpha. Seam harmonization only changes RGB.
    output[offset + 3] = generated[offset + 3] ?? 255;
  }
  return {
    pixels: output,
    report: {
      applied: true,
      blendWidth,
      sampledPixels,
    },
  };
}
