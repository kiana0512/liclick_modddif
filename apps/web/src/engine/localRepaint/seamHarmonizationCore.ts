export type LocalRepaintSeamHarmonizationOptions = {
  minBlendWidth?: number;
  maxBlendWidth?: number;
  minSampleWidth?: number;
  maxSampleWidth?: number;
  edgeOpacity?: number;
  localSampleCellSize?: number;
  correctionDepth?: number;
  coreColorMatchStrength?: number;
  enableColorMatch?: boolean;
};

export type LocalRepaintSeamHarmonizationReport = {
  applied: boolean;
  blendWidth: number;
  innerBlendWidth: number;
  sampleWidth: number;
  sampledPixels: number;
  outerSampledPixels: number;
  localColorRegions: number;
  colorMatchApplied: boolean;
  reason?:
    | 'empty-mask'
    | 'full-frame-mask'
    | 'mask-too-thin'
    | 'insufficient-boundary-samples';
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

type LabTransfer = {
  sourceMean: [number, number, number];
  targetMean: [number, number, number];
  scale: [number, number, number];
};

function createLabTransfer(source: LabStats, target: LabStats): LabTransfer {
  const maximumMeanShift = [12, 10, 10] as const;
  const targetMean = source.mean.map((value, channel) =>
    value + clamp(target.mean[channel] - value, -maximumMeanShift[channel], maximumMeanShift[channel]),
  ) as [number, number, number];
  return {
    sourceMean: source.mean,
    targetMean,
    scale: [
      clamp(target.standardDeviation[0] / Math.max(source.standardDeviation[0], 1), 0.82, 1.18),
      clamp(target.standardDeviation[1] / Math.max(source.standardDeviation[1], 1), 0.88, 1.12),
      clamp(target.standardDeviation[2] / Math.max(source.standardDeviation[2], 1), 0.88, 1.12),
    ],
  };
}

function estimateReferenceBackground(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
): [number, number, number] {
  const inset = Math.max(1, Math.round(Math.min(width, height) * 0.01));
  const points = [
    [inset, inset],
    [width - 1 - inset, inset],
    [inset, height - 1 - inset],
    [width - 1 - inset, height - 1 - inset],
  ] as const;
  const sum = [0, 0, 0];
  for (const [x, y] of points) {
    const offset = (y * width + x) * 4;
    sum[0] += pixels[offset] ?? 0;
    sum[1] += pixels[offset + 1] ?? 0;
    sum[2] += pixels[offset + 2] ?? 0;
  }
  return [sum[0] / points.length, sum[1] / points.length, sum[2] / points.length];
}

function rgbDistanceFrom(
  pixels: Uint8ClampedArray,
  offset: number,
  color: [number, number, number],
) {
  const red = (pixels[offset] ?? 0) - color[0];
  const green = (pixels[offset + 1] ?? 0) - color[1];
  const blue = (pixels[offset + 2] ?? 0) - color[2];
  return Math.sqrt(red * red + green * green + blue * blue);
}

function applyBoundaryAwareLowFrequencyLabCorrection(input: {
  generated: Uint8ClampedArray;
  reference: Uint8ClampedArray;
  hardMask: Uint8Array;
  insideDistance: Float32Array;
  outsideDistance: Float32Array;
  width: number;
  height: number;
  sampleWidth: number;
  blendWidth: number;
  options?: LocalRepaintSeamHarmonizationOptions;
}) {
  const {
    generated,
    reference,
    hardMask,
    insideDistance,
    outsideDistance,
    width,
    height,
    sampleWidth,
    blendWidth,
  } = input;
  const blurRadius = Math.max(8, Math.round(sampleWidth * 0.75));
  const generatedLow = boxBlurRgb(generated, width, height, blurRadius);
  const referenceLow = boxBlurRgb(reference, width, height, blurRadius);
  const background = estimateReferenceBackground(reference, width, height);
  const isInnerSample = (index: number) =>
    hardMask[index] === 1 &&
    (insideDistance[index] ?? INF) >= 1 &&
    (insideDistance[index] ?? INF) <= sampleWidth;
  const isOuterSample = (index: number) => {
    if (
      hardMask[index] !== 0 ||
      (outsideDistance[index] ?? INF) < 1 ||
      (outsideDistance[index] ?? INF) > sampleWidth
    ) {
      return false;
    }
    const offset = index * 4;
    return (
      (reference[offset + 3] ?? 0) >= 16 &&
      rgbDistanceFrom(reference, offset, background) >= 24 &&
      rgbDistanceFrom(referenceLow, offset, background) >= 16
    );
  };
  const sourceStats = collectLabStats(generatedLow, isInnerSample);
  const targetStats = collectLabStats(referenceLow, isOuterSample);
  const minimumSamples = Math.max(128, Math.round(sampleWidth * 8));
  if (sourceStats.count < minimumSamples || targetStats.count < minimumSamples) {
    return {
      pixels: new Uint8ClampedArray(generated),
      sourceSamples: sourceStats.count,
      outerSamples: targetStats.count,
      localRegions: 0,
      applied: false,
    };
  }

  const cellSize = clamp(
    Math.round(input.options?.localSampleCellSize ?? Math.min(width, height) * 0.0625),
    64,
    160,
  );
  const gridWidth = Math.max(1, Math.ceil(width / cellSize));
  const gridHeight = Math.max(1, Math.ceil(height / cellSize));
  const cellCount = gridWidth * gridHeight;
  const sourceCounts = new Uint32Array(cellCount);
  const targetCounts = new Uint32Array(cellCount);
  const sourceSums = new Float64Array(cellCount * 6);
  const targetSums = new Float64Array(cellCount * 6);
  const addSample = (
    sums: Float64Array,
    counts: Uint32Array,
    cellIndex: number,
    lab: [number, number, number],
  ) => {
    counts[cellIndex] = (counts[cellIndex] ?? 0) + 1;
    const base = cellIndex * 6;
    for (let channel = 0; channel < 3; channel += 1) {
      const value = lab[channel];
      sums[base + channel] = (sums[base + channel] ?? 0) + value;
      sums[base + 3 + channel] = (sums[base + 3 + channel] ?? 0) + value * value;
    }
  };
  for (let index = 0; index < hardMask.length; index += 1) {
    const inner = isInnerSample(index);
    const outer = isOuterSample(index);
    if (!inner && !outer) continue;
    const x = index % width;
    const y = Math.floor(index / width);
    const cellIndex = Math.floor(y / cellSize) * gridWidth + Math.floor(x / cellSize);
    const offset = index * 4;
    if (inner) {
      addSample(
        sourceSums,
        sourceCounts,
        cellIndex,
        rgbToLab(generatedLow[offset] ?? 0, generatedLow[offset + 1] ?? 0, generatedLow[offset + 2] ?? 0),
      );
    }
    if (outer) {
      addSample(
        targetSums,
        targetCounts,
        cellIndex,
        rgbToLab(referenceLow[offset] ?? 0, referenceLow[offset + 1] ?? 0, referenceLow[offset + 2] ?? 0),
      );
    }
  }

  const statsFromGrid = (
    sums: Float64Array,
    counts: Uint32Array,
    cellX: number,
    cellY: number,
  ): LabStats => {
    const sum = [0, 0, 0];
    const sumSquares = [0, 0, 0];
    let count = 0;
    for (let y = Math.max(0, cellY - 1); y <= Math.min(gridHeight - 1, cellY + 1); y += 1) {
      for (let x = Math.max(0, cellX - 1); x <= Math.min(gridWidth - 1, cellX + 1); x += 1) {
        const cellIndex = y * gridWidth + x;
        count += counts[cellIndex] ?? 0;
        const base = cellIndex * 6;
        for (let channel = 0; channel < 3; channel += 1) {
          sum[channel] += sums[base + channel] ?? 0;
          sumSquares[channel] += sums[base + 3 + channel] ?? 0;
        }
      }
    }
    const mean = sum.map((value) => value / Math.max(count, 1)) as [number, number, number];
    return {
      mean,
      standardDeviation: sumSquares.map((value, channel) =>
        Math.sqrt(Math.max(0, value / Math.max(count, 1) - mean[channel] * mean[channel])),
      ) as [number, number, number],
      count,
    };
  };

  const globalTransfer = createLabTransfer(sourceStats, targetStats);
  const sourceMeanField = new Float32Array(cellCount * 3);
  const targetMeanField = new Float32Array(cellCount * 3);
  const scaleField = new Float32Array(cellCount * 3);
  let localRegions = 0;
  for (let cellY = 0; cellY < gridHeight; cellY += 1) {
    for (let cellX = 0; cellX < gridWidth; cellX += 1) {
      const source = statsFromGrid(sourceSums, sourceCounts, cellX, cellY);
      const target = statsFromGrid(targetSums, targetCounts, cellX, cellY);
      const usesLocal = source.count >= 32 && target.count >= 32;
      const transfer = usesLocal ? createLabTransfer(source, target) : globalTransfer;
      if (usesLocal) localRegions += 1;
      const base = (cellY * gridWidth + cellX) * 3;
      for (let channel = 0; channel < 3; channel += 1) {
        sourceMeanField[base + channel] = transfer.sourceMean[channel];
        targetMeanField[base + channel] = transfer.targetMean[channel];
        scaleField[base + channel] = transfer.scale[channel];
      }
    }
  }

  const output = new Uint8ClampedArray(generated);
  const correctionDepth = clamp(
    Math.round(input.options?.correctionDepth ?? Math.min(width, height) * 0.05),
    48,
    128,
  );
  const coreStrength = clamp(input.options?.coreColorMatchStrength ?? 0.35, 0, 1);
  for (let index = 0; index < hardMask.length; index += 1) {
    const inside = hardMask[index] === 1;
    if (!inside && (outsideDistance[index] ?? INF) >= blendWidth) continue;
    const x = index % width;
    const y = Math.floor(index / width);
    const gridX = clamp(x / cellSize - 0.5, 0, gridWidth - 1);
    const gridY = clamp(y / cellSize - 0.5, 0, gridHeight - 1);
    const x0 = Math.floor(gridX);
    const y0 = Math.floor(gridY);
    const x1 = Math.min(gridWidth - 1, x0 + 1);
    const y1 = Math.min(gridHeight - 1, y0 + 1);
    const tx = gridX - x0;
    const ty = gridY - y0;
    const interpolate = (field: Float32Array, channel: number) => {
      const top =
        (field[(y0 * gridWidth + x0) * 3 + channel] ?? 0) * (1 - tx) +
        (field[(y0 * gridWidth + x1) * 3 + channel] ?? 0) * tx;
      const bottom =
        (field[(y1 * gridWidth + x0) * 3 + channel] ?? 0) * (1 - tx) +
        (field[(y1 * gridWidth + x1) * 3 + channel] ?? 0) * tx;
      return top * (1 - ty) + bottom * ty;
    };
    const offset = index * 4;
    const originalLow = [
      generatedLow[offset] ?? 0,
      generatedLow[offset + 1] ?? 0,
      generatedLow[offset + 2] ?? 0,
    ] as const;
    const lab = rgbToLab(originalLow[0], originalLow[1], originalLow[2]);
    const correctedLab = [0, 0, 0] as [number, number, number];
    for (let channel = 0; channel < 3; channel += 1) {
      correctedLab[channel] =
        (lab[channel] - interpolate(sourceMeanField, channel)) *
          interpolate(scaleField, channel) +
        interpolate(targetMeanField, channel);
    }
    correctedLab[0] = clamp(correctedLab[0], 0, 100);
    correctedLab[1] = clamp(correctedLab[1], -128, 127);
    correctedLab[2] = clamp(correctedLab[2], -128, 127);
    const correctedLow = labToRgb(correctedLab[0], correctedLab[1], correctedLab[2]);
    const boundaryStrength = inside
      ? coreStrength +
        (1 - coreStrength) *
          (1 - smoothstep(1, correctionDepth, insideDistance[index] ?? correctionDepth))
      : 1;
    for (let channel = 0; channel < 3; channel += 1) {
      const delta = (correctedLow[channel] - originalLow[channel]) * boundaryStrength;
      output[offset + channel] = Math.round(
        clamp((generated[offset + channel] ?? 0) + delta, 0, 255),
      );
    }
    output[offset + 3] = generated[offset + 3] ?? 255;
  }
  return {
    pixels: output,
    sourceSamples: sourceStats.count,
    outerSamples: targetStats.count,
    localRegions,
    applied: true,
  };
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
      report: {
        applied: false,
        blendWidth: 0,
        innerBlendWidth: 0,
        sampleWidth: 0,
        sampledPixels: 0,
        outerSampledPixels: 0,
        localColorRegions: 0,
        colorMatchApplied: false,
        reason: 'empty-mask',
      },
    };
  }
  if (hardMaskResult.insideCount === hardMaskResult.mask.length) {
    return {
      pixels: new Uint8ClampedArray(generated),
      report: {
        applied: false,
        blendWidth: 0,
        innerBlendWidth: 0,
        sampleWidth: 0,
        sampledPixels: 0,
        outerSampledPixels: 0,
        localColorRegions: 0,
        colorMatchApplied: false,
        reason: 'full-frame-mask',
      },
    };
  }
  // The authored mask is an absolute replacement contract: every pixel inside
  // it uses the corrected generated frame at 100% opacity. A single opacity
  // ramp is applied only outside that boundary. RGB is never spatially blurred.
  const requestedMinimumBlendWidth = input.options?.minBlendWidth ?? 12;
  const requestedMaximumBlendWidth = input.options?.maxBlendWidth ?? 40;
  const requestedBlendWidth = clamp(
    Math.round(Math.min(width, height) * 0.012),
    requestedMinimumBlendWidth,
    requestedMaximumBlendWidth,
  );
  const outsideDistance = distanceToValue(hardMaskResult.mask, width, height, 1);
  const insideDistance = distanceToValue(hardMaskResult.mask, width, height, 0);
  const blendWidth = requestedBlendWidth;
  const edgeOpacity = clamp(input.options?.edgeOpacity ?? 1, 0, 1);
  const innerBlendWidth = 0;
  const sampleWidth = clamp(
    Math.round(Math.min(width, height) * 0.012),
    input.options?.minSampleWidth ?? 8,
    input.options?.maxSampleWidth ?? 32,
  );
  let sampledPixels = 0;
  let outerSampledPixels = 0;
  let localColorRegions = 0;
  let colorMatchApplied = false;
  let corrected = new Uint8ClampedArray(generated);
  if (input.options?.enableColorMatch === true) {
    const correction = applyBoundaryAwareLowFrequencyLabCorrection({
      generated,
      reference,
      hardMask: hardMaskResult.mask,
      insideDistance,
      outsideDistance,
      width,
      height,
      sampleWidth,
      blendWidth,
      options: input.options,
    });
    sampledPixels = correction.sourceSamples;
    outerSampledPixels = correction.outerSamples;
    localColorRegions = correction.localRegions;
    corrected = correction.pixels;
    colorMatchApplied = correction.applied;
  }
  const output = new Uint8ClampedArray(corrected.length);
  for (let index = 0; index < hardMaskResult.mask.length; index += 1) {
    const offset = index * 4;
    const isInside = hardMaskResult.mask[index] === 1;
    if (isInside) {
      output[offset] = corrected[offset] ?? 0;
      output[offset + 1] = corrected[offset + 1] ?? 0;
      output[offset + 2] = corrected[offset + 2] ?? 0;
      output[offset + 3] = generated[offset + 3] ?? 255;
      continue;
    }
    const distance = outsideDistance[index] ?? INF;
    if (distance >= blendWidth) {
      output[offset] = reference[offset] ?? 0;
      output[offset + 1] = reference[offset + 1] ?? 0;
      output[offset + 2] = reference[offset + 2] ?? 0;
      output[offset + 3] = reference[offset + 3] ?? 255;
      continue;
    }
    // Source-over compositing with a declining generated-layer opacity. RGB is
    // not blurred or filtered: every pixel remains sampled at its original 2K
    // coordinate and only the overlay opacity changes across the outer ring.
    const falloff = 1 - smoothstep(1, blendWidth, distance);
    const generatedOpacity =
      edgeOpacity * falloff * ((generated[offset + 3] ?? 255) / 255);
    for (let channel = 0; channel < 3; channel += 1) {
      output[offset + channel] = Math.round(
        (reference[offset + channel] ?? 0) * (1 - generatedOpacity) +
          (corrected[offset + channel] ?? 0) * generatedOpacity,
      );
    }
    const referenceAlpha = (reference[offset + 3] ?? 255) / 255;
    output[offset + 3] = Math.round(
      (generatedOpacity + referenceAlpha * (1 - generatedOpacity)) * 255,
    );
  }
  return {
    pixels: output,
    report: {
      applied: true,
      blendWidth,
      innerBlendWidth,
      sampleWidth,
      sampledPixels,
      outerSampledPixels,
      localColorRegions,
      colorMatchApplied,
    },
  };
}
