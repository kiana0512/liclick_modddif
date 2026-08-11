import type * as THREE from 'three';
import { createBakeReport } from './bakeReport';
import {
  dilateImageData,
  dilateUvCoverageWithinTopology,
  fillEnclosedUvCoverageGaps,
  fillEnclosedUvCoverageGapsWithinTopology,
  getUvDilationPixels,
  padUvIslandGutters,
  padUvIslandGuttersWithTopology,
} from './dilation';
import {
  bakeProjectedLayerRastersWithGpu,
  bakeProjectedLayerStackWithGpu,
  type GpuLayerSourceSize,
} from './gpuUvBakeRenderer';
import { loadImageData } from './imageSampler';
import { getVisibleProjectedLayerStack } from './layerStackCache';
import { getDebugGpuProjectedImageUvFlipY, getDebugUvBakeMethod } from './uvBakeDebugControls';
import { rasterizeProjectedLayerToUv } from './uvRasterizer';
import { reconcileUvSeams } from './uvSeamReconciliation';
import { createRuntimeProjectionDepth } from '@/engine/projection/createRuntimeProjectionDepth';
import { buildContentAwareSurfaceTopology } from '@/engine/contentAware/buildSurfaceTopology';
import type {
  BakeProjectedLayerInput,
  BakeProjectedLayerResult,
  BakeVisibleProjectedLayersInput,
  BakedTexture,
  UvBakeResolution,
} from './uvBakeTypes';
import { useLayerStore } from '@/stores/layerStore';
import { useProjectStore } from '@/stores/projectStore';
import { useSceneStore } from '@/stores/sceneStore';
import { isViewportInteractionBusy } from '@/engine/viewport/viewportInteractionState';
import type { Layer } from '@/types/layer';
import { createRegisteredObjectUrl } from '@/utils/blobUrlRegistry';
import { encodeRgbaPngBlob } from '@/utils/encodeRgbaPng';
import { createId } from '@/utils/id';
import { blendProjectedRastersInWorker } from './qualityBlendWorker';
import {
  rasterizeUvTopologyMaskWithWebGpu,
  type WebGpuUvTopologyRasterResult,
} from './webGpuUvTopologyRaster';

const UNPROJECTED_TEXTURE_FILL: [number, number, number] = [8, 9, 13];
const MIN_VALID_COVERAGE_RATIO = 0.001;
const SHARPEN_AMOUNT = 0.24;
const SHARPEN_DETAIL_THRESHOLD = 5;
const MAX_CPU_SHARPEN_RESOLUTION = 2048;
const MIN_TRANSPARENT_OUTPUT_ALPHA = 8;
const TOP_K_BLEND_LAYERS = 3;
const BLEND_POWER = 2.4;
const RESIDUAL_MIX = 0.2;
const DOMINANCE_BLEND_START = 1.45;
const DOMINANCE_BLEND_END = 2.6;
const DOMINANCE_MARGIN_START = 0.05;
const DOMINANCE_MARGIN_END = 0.2;
const COLOR_CONSISTENCY_SIGMA = 0.22;
const COVERAGE_THRESHOLD = 0.02;
const QUALITY_FLOOR_FROM_COVERAGE = 0.08;
const GPU_COVERAGE_VALIDATION_RESOLUTION = 512 as UvBakeResolution;
const MIN_GPU_CPU_COVERAGE_IOU = 0.45;
const MIN_GPU_CPU_COVERAGE_RATIO = 0.55;
const MAX_GPU_CPU_COLOR_MEAN_ERROR = 0.18;
const SRGB_BYTE_TO_LINEAR = Array.from({ length: 256 }, (_, value) => {
  const color = value / 255;
  return color <= 0.04045 ? color / 12.92 : ((color + 0.055) / 1.055) ** 2.4;
});
const SHARPEN_KERNEL = [
  { x: -1, y: -1, weight: 1 },
  { x: 0, y: -1, weight: 2 },
  { x: 1, y: -1, weight: 1 },
  { x: -1, y: 0, weight: 2 },
  { x: 0, y: 0, weight: 4 },
  { x: 1, y: 0, weight: 2 },
  { x: -1, y: 1, weight: 1 },
  { x: 0, y: 1, weight: 2 },
  { x: 1, y: 1, weight: 1 },
];

function markUvBakePerformancePhase(phase: string) {
  if (
    typeof document !== 'undefined' &&
    document.body.dataset.perfSimulatedViewportInteraction === '1'
  ) {
    document.body.dataset.perfUvBakePhase = phase;
  }
}

async function fillUvInteriorGapsWithIslandOwnership(
  imageData: ImageData,
  coverage: Uint8Array,
  root: THREE.Object3D,
  iterations: number,
) {
  if (iterations <= 0) return 0;
  try {
    // This is the same cached topology used by content-aware repair. Its
    // regionIds let the micro-crack pass distinguish a missing texel inside
    // one UV island from an intentional one-pixel gap between two islands.
    const topology = await buildContentAwareSurfaceTopology(
      root,
      imageData.width,
      imageData.height,
      {
        includeInvisible: false,
        includeSeamLinks: true,
        seamBandPixels: 1,
        minimumSeamNormalDot: 0.65,
        yieldIntervalMs: 8,
      },
    );
    return fillEnclosedUvCoverageGaps(
      imageData,
      coverage,
      topology.coreMask,
      iterations,
      topology.regionIds,
    );
  } catch (error) {
    console.warn(
      '[Liclick 3D Texture] Island-aware UV repair topology failed; using conservative fallback.',
      error,
    );
    return fillEnclosedUvCoverageGapsWithinTopology(
      imageData,
      coverage,
      root,
      iterations,
    );
  }
}

function shouldValidateGpuBakeCoverage() {
  try {
    return window.localStorage.getItem('liclick-debug-gpu-coverage-validation') === '1';
  } catch {
    return false;
  }
}

async function encodeBakeCanvas(canvas: HTMLCanvasElement, preferBlobOutput?: boolean) {
  if (!preferBlobOutput) {
    return { imageUrl: canvas.toDataURL('image/png') };
  }

  const imageBlob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('Could not encode baked texture PNG.'));
    }, 'image/png');
  });
  return {
    imageBlob,
    imageUrl: createRegisteredObjectUrl(imageBlob),
  };
}

function encodeVisibleBakeCanvas(
  canvas: HTMLCanvasElement,
  input: BakeVisibleProjectedLayersInput,
  straightRgbaImageData?: ImageData,
): Promise<{ imageUrl: string; imageBlob?: Blob }> {
  if (input.skipImageEncoding) return Promise.resolve({ imageUrl: '', imageBlob: undefined });
  if (
    input.outputAlpha === 'transparent' &&
    (input.uvIslandGutterPixels ?? 0) > 0 &&
    straightRgbaImageData
  ) {
    return encodeRgbaPngBlob(
      straightRgbaImageData.width,
      straightRgbaImageData.height,
      straightRgbaImageData.data,
    ).then(async (imageBlob) => {
      if (input.preferBlobOutput) {
        return { imageBlob, imageUrl: createRegisteredObjectUrl(imageBlob) };
      }
      const imageUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () =>
          typeof reader.result === 'string'
            ? resolve(reader.result)
            : reject(new Error('Could not encode baked texture PNG data URL.'));
        reader.onerror = () =>
          reject(reader.error ?? new Error('Could not read baked texture PNG.'));
        reader.readAsDataURL(imageBlob);
      });
      return { imageUrl };
    });
  }
  return encodeBakeCanvas(canvas, input.preferBlobOutput);
}

function validateBakeCoverage(
  coveredPixels: number,
  resolution: number,
  minimumCoverageRatio = MIN_VALID_COVERAGE_RATIO,
) {
  const coverageRatio = coveredPixels / (resolution * resolution);
  if (coverageRatio < minimumCoverageRatio) {
    throw new Error(
      'UV bake produced almost no valid texels; keeping the projected layer unbaked.',
    );
  }
  return coverageRatio;
}

type CpuLayerSourceSize = {
  layerId: string;
  layerName: string;
  projectedImage: string;
  maskImage?: string;
  depthImage?: string;
};

function logTransparentBakeSizeDiagnostics(
  input: BakeVisibleProjectedLayersInput,
  canvas: HTMLCanvasElement,
  bakedTexture: BakedTexture,
  sourceSizes: Array<GpuLayerSourceSize | CpuLayerSourceSize> = [],
) {
  if (input.outputAlpha !== 'transparent') return;
  console.table({
    requestedBakeResolution: input.resolution,
    outputCanvas: `${canvas.width}x${canvas.height}`,
    bakedTextureMeta: `${bakedTexture.width}x${bakedTexture.height}`,
  });
  if (sourceSizes.length > 0) console.table(sourceSizes);
}

async function loadOptionalBakeImage(
  url: string | undefined,
  resolution: number,
  label: string,
  warnings: string[],
) {
  if (!url) return undefined;
  try {
    return await loadImageData(url, resolution, label);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warnings.push(`${label}: optional bake input ignored. ${message}`);
    console.warn('[Liclick 3D Texture] Ignoring optional bake image:', label, error);
    return undefined;
  }
}

function clampProgress(progress: number) {
  return Math.max(0, Math.min(1, progress));
}

const BAKE_PIXELS_PER_YIELD = 32_768;

function yieldToBakeUi() {
  if (isViewportInteractionBusy()) {
    // Let the viewport present first, then consume only a bounded CPU slice.
    // This changes scheduling only; every source pixel is still processed.
    return new Promise<void>((resolve) =>
      window.requestAnimationFrame(() => window.setTimeout(resolve, 0)),
    );
  }
  const browserScheduler = (
    globalThis as typeof globalThis & {
      scheduler?: { yield?: () => Promise<void> };
    }
  ).scheduler;
  return browserScheduler?.yield
    ? browserScheduler.yield()
    : new Promise<void>((resolve) => window.setTimeout(resolve, 0));
}

async function fillTransparentTexelsForViewport(imageData: ImageData) {
  for (let offset = 0; offset < imageData.data.length; offset += 4) {
    if (offset > 0 && offset % (BAKE_PIXELS_PER_YIELD * 4) === 0) {
      await yieldToBakeUi();
    }
    if (imageData.data[offset + 3] !== 0) continue;
    imageData.data[offset] = UNPROJECTED_TEXTURE_FILL[0];
    imageData.data[offset + 1] = UNPROJECTED_TEXTURE_FILL[1];
    imageData.data[offset + 2] = UNPROJECTED_TEXTURE_FILL[2];
    imageData.data[offset + 3] = 255;
  }
}

async function clearWeakTransparentTexels(imageData: ImageData, coverage?: Uint8Array) {
  for (let offset = 0; offset < imageData.data.length; offset += 4) {
    if (offset > 0 && offset % (BAKE_PIXELS_PER_YIELD * 4) === 0) {
      await yieldToBakeUi();
    }
    if (imageData.data[offset + 3] > MIN_TRANSPARENT_OUTPUT_ALPHA) continue;
    const pixelIndex = offset / 4;
    // `padUvIslandGutters(..., 'rgb-only')` marks filter-only gutter texels
    // with coverage value 2. Keep their hidden RGB while alpha remains zero.
    if (imageData.data[offset + 3] === 0 && coverage?.[pixelIndex] === 2) continue;
    imageData.data[offset] = 0;
    imageData.data[offset + 1] = 0;
    imageData.data[offset + 2] = 0;
    imageData.data[offset + 3] = 0;
    // Keep the logical coverage mask in lockstep with the exported alpha.
    // Otherwise an alpha<=8 edge sample is treated as a valid wall/donor by
    // the UV-hole pass and is only erased afterwards, leaving 1px cracks in
    // the final PNG even though coverage still says that texel is occupied.
    if (coverage) coverage[pixelIndex] = 0;
  }
}

function clampByte(value: number) {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function smoothstep(edge0: number, edge1: number, value: number) {
  const t = Math.max(0, Math.min(1, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function isSharpenTarget(
  imageData: ImageData,
  coverage: Uint8Array | undefined,
  pixelIndex: number,
) {
  const alpha = imageData.data[pixelIndex * 4 + 3];
  if (alpha === 0) return false;
  return coverage ? coverage[pixelIndex] === 1 : true;
}

async function sharpenCoveredTexels(imageData: ImageData, coverage?: Uint8Array) {
  if (imageData.width > MAX_CPU_SHARPEN_RESOLUTION || imageData.height > MAX_CPU_SHARPEN_RESOLUTION)
    return;

  const { width, height, data } = imageData;
  const source = new Uint8ClampedArray(data);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const pixelIndex = y * width + x;
      if (!isSharpenTarget(imageData, coverage, pixelIndex)) continue;

      const offset = pixelIndex * 4;
      for (let channel = 0; channel < 3; channel += 1) {
        let weightedSum = 0;
        let totalWeight = 0;

        for (const sample of SHARPEN_KERNEL) {
          const sampleX = Math.max(0, Math.min(width - 1, x + sample.x));
          const sampleY = Math.max(0, Math.min(height - 1, y + sample.y));
          const sampleIndex = sampleY * width + sampleX;
          if (!isSharpenTarget(imageData, coverage, sampleIndex)) continue;

          weightedSum += source[sampleIndex * 4 + channel] * sample.weight;
          totalWeight += sample.weight;
        }

        const original = source[offset + channel];
        const blurred = totalWeight > 0 ? weightedSum / totalWeight : original;
        const detail = original - blurred;
        data[offset + channel] =
          Math.abs(detail) < SHARPEN_DETAIL_THRESHOLD
            ? original
            : clampByte(original + detail * SHARPEN_AMOUNT);
      }
    }
    if ((y + 1) % 16 === 0 && y + 1 < height) await yieldToBakeUi();
  }
}

export async function bakeProjectedLayerToTexture(
  input: BakeProjectedLayerInput,
): Promise<BakeProjectedLayerResult> {
  const startedAt = performance.now();
  const importedModel = useSceneStore.getState().importedModel;
  if (!importedModel || importedModel.objectId !== input.objectId) {
    throw new Error('Please import a model first.');
  }

  const layer = useLayerStore.getState().layers.find((item) => item.id === input.layerId);
  if (!layer) throw new Error('Please add a projected layer first.');
  if (layer.type !== 'projected')
    throw new Error('Only projected layers can be baked in this MVP.');
  if (!layer.camera) throw new Error('Projected layer has no capture camera.');
  if (!importedModel.uvSets.includes('UV0')) throw new Error('This model has no UVs.');
  const dilationPixels = getUvDilationPixels(input.resolution, input.dilationPixels);

  input.onProgress?.({
    phase: 'loading-assets',
    progress: 0.04,
    layerName: layer.name,
    layerIndex: 0,
    layerCount: 1,
  });
  const optionalWarnings: string[] = [];
  const projectedImage = await loadImageData(
    layer.imageUrl,
    input.resolution,
    `${layer.name} image`,
  );
  const [maskImage, depthImage] = await Promise.all([
    loadOptionalBakeImage(layer.maskUrl, input.resolution, `${layer.name} mask`, optionalWarnings),
    loadOptionalBakeImage(
      layer.depthUrl,
      input.resolution,
      `${layer.name} depth`,
      optionalWarnings,
    ),
  ]);
  const rasterized = await rasterizeProjectedLayerToUv({
    group: importedModel.group,
    layer,
    projectedImage,
    maskImage,
    depthImage,
    bakeInput: {
      ...input,
      enableDilation: false,
      dilationPixels: 0,
      onProgress: (progress) =>
        input.onProgress?.({
          ...progress,
          progress: 0.08 + clampProgress(progress.progress) * 0.78,
          layerName: progress.layerName ?? layer.name,
          layerIndex: 0,
          layerCount: 1,
        }),
    },
  });
  const rasterContext = rasterized.canvas.getContext('2d', { willReadFrequently: true });
  if (!rasterContext) throw new Error('Could not read UV bake canvas.');
  const rasterImage = rasterContext.getImageData(0, 0, input.resolution, input.resolution);
  await sharpenCoveredTexels(rasterImage, rasterized.coverage);
  const seamResult = reconcileUvSeams(rasterImage, importedModel.group, rasterized.coverage);
  if (input.enableDilation) {
    dilateImageData(rasterImage, rasterized.coverage, dilationPixels);
  }
  if (seamResult.adjustedPixels > 0) {
    optionalWarnings.push(
      `Geometry-aware UV seam reconciliation adjusted ${seamResult.adjustedPixels} edge texels across ${seamResult.seamPairs} seam pairs.`,
    );
  }
  input.onProgress?.({
    phase: 'compositing',
    progress: 0.9,
    layerName: layer.name,
    layerIndex: 0,
    layerCount: 1,
  });
  await fillTransparentTexelsForViewport(rasterImage);
  rasterContext.putImageData(rasterImage, 0, 0);
  input.onProgress?.({
    phase: 'encoding',
    progress: 0.96,
    layerName: layer.name,
    layerIndex: 0,
    layerCount: 1,
  });
  const { imageBlob, imageUrl } = await encodeBakeCanvas(rasterized.canvas, input.preferBlobOutput);
  const coverageRatio = validateBakeCoverage(rasterized.coveredPixels, input.resolution);
  const report = createBakeReport({
    startedAt,
    objectId: input.objectId,
    layerId: input.layerId,
    width: input.resolution,
    height: input.resolution,
    totalTriangles: rasterized.totalTriangles,
    processedTriangles: rasterized.processedTriangles,
    coveredPixels: rasterized.coveredPixels,
    skippedPixels: rasterized.skippedPixels,
    totalTexels: input.resolution * input.resolution,
    inFrustumTexels: rasterized.inFrustumPixels,
    maskRejectedTexels: rasterized.maskRejectedPixels,
    depthRejectedTexels: rasterized.depthRejectedPixels,
    backfaceRejectedTexels: rasterized.backfaceRejectedPixels,
    writtenTexels: rasterized.coveredPixels,
    coverageRatio,
    warnings: [...optionalWarnings, ...rasterized.warnings],
  });

  const bakedTexture: BakedTexture = {
    id: createId('baked-texture'),
    objectId: input.objectId,
    sourceLayerId: input.layerId,
    sourceLayerIds: [input.layerId],
    imageUrl,
    width: input.resolution,
    height: input.resolution,
    format: 'png',
    createdAt: new Date().toISOString(),
    coverageRatio,
    report,
  };

  useProjectStore.getState().addBakedTexture(bakedTexture);
  useLayerStore.getState().markLayerBaked(input.layerId, bakedTexture.id, bakedTexture.createdAt);
  console.info('[Liclick 3D Texture] UV bake report:', report);

  return {
    bakedTexture,
    canvas: rasterized.canvas,
    imageBlob,
    imageUrl,
    report,
  };
}

type QualityBlendStackComposite = {
  colors: Uint8ClampedArray[];
  coverages: Float32Array[];
  qualities: Float32Array[];
  coverage: Uint8Array;
  winnerLayerIds: Array<string | undefined>;
};

type OverlayRaster = {
  layer: Layer;
  imageData: ImageData;
  quality: Float32Array;
};

function createQualityBlendStackComposite(resolution: number): QualityBlendStackComposite {
  const pixelCount = resolution * resolution;
  return {
    colors: Array.from({ length: TOP_K_BLEND_LAYERS }, () => new Uint8ClampedArray(pixelCount * 3)),
    coverages: Array.from({ length: TOP_K_BLEND_LAYERS }, () => new Float32Array(pixelCount)),
    qualities: Array.from({ length: TOP_K_BLEND_LAYERS }, () => new Float32Array(pixelCount)),
    coverage: new Uint8Array(pixelCount),
    winnerLayerIds: new Array<string | undefined>(pixelCount),
  };
}

function insertBlendCandidate(
  composite: QualityBlendStackComposite,
  pixelIndex: number,
  offset: number,
  coverage: number,
  quality: number,
  layerImage: ImageData,
  layerId: string,
) {
  let insertAt = -1;
  for (let slot = 0; slot < TOP_K_BLEND_LAYERS; slot += 1) {
    if (quality > composite.qualities[slot][pixelIndex]) {
      insertAt = slot;
      break;
    }
  }
  if (insertAt < 0) return;

  const colorOffset = pixelIndex * 3;
  for (let slot = TOP_K_BLEND_LAYERS - 1; slot > insertAt; slot -= 1) {
    composite.coverages[slot][pixelIndex] = composite.coverages[slot - 1][pixelIndex];
    composite.qualities[slot][pixelIndex] = composite.qualities[slot - 1][pixelIndex];
    composite.colors[slot][colorOffset] = composite.colors[slot - 1][colorOffset];
    composite.colors[slot][colorOffset + 1] = composite.colors[slot - 1][colorOffset + 1];
    composite.colors[slot][colorOffset + 2] = composite.colors[slot - 1][colorOffset + 2];
  }

  composite.coverages[insertAt][pixelIndex] = coverage;
  composite.qualities[insertAt][pixelIndex] = quality;
  composite.colors[insertAt][colorOffset] = layerImage.data[offset];
  composite.colors[insertAt][colorOffset + 1] = layerImage.data[offset + 1];
  composite.colors[insertAt][colorOffset + 2] = layerImage.data[offset + 2];
  composite.coverage[pixelIndex] = 1;
  if (insertAt === 0) composite.winnerLayerIds[pixelIndex] = layerId;
}

async function accumulateQualityBlendLayer(
  composite: QualityBlendStackComposite,
  layer: ImageData,
  qualityMap: Float32Array,
  layerId: string,
) {
  for (let pixelIndex = 0, offset = 0; offset < layer.data.length; pixelIndex += 1, offset += 4) {
    if (pixelIndex > 0 && pixelIndex % BAKE_PIXELS_PER_YIELD === 0) {
      await yieldToBakeUi();
    }
    const coverage = layer.data[offset + 3] / 255;
    if (coverage <= COVERAGE_THRESHOLD) continue;
    const quality = Math.max(qualityMap[pixelIndex], coverage * QUALITY_FLOOR_FROM_COVERAGE);
    insertBlendCandidate(composite, pixelIndex, offset, coverage, quality, layer, layerId);
  }
}

function srgbByteToLinear(value: number) {
  return SRGB_BYTE_TO_LINEAR[value] ?? 0;
}

function smoothstepScalar(edge0: number, edge1: number, value: number) {
  const t = Math.max(0, Math.min(1, (value - edge0) / Math.max(edge1 - edge0, 0.000001)));
  return t * t * (3 - 2 * t);
}

function linearToSrgbByte(value: number) {
  const color = Math.max(0, Math.min(1, value));
  const srgb = color <= 0.0031308 ? color * 12.92 : 1.055 * color ** (1 / 2.4) - 0.055;
  return clampByte(srgb * 255);
}

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

async function writeQualityBlendStackComposite(
  composite: QualityBlendStackComposite,
  output: ImageData,
  preserveCoverageConfidenceAlpha = false,
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
      ? clampByte(coverageConfidence * 255)
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

async function applyOverlayRasters(
  base: ImageData,
  coverage: Uint8Array,
  overlays: OverlayRaster[],
) {
  for (const { imageData, quality: qualityMap } of overlays) {
    for (
      let pixelIndex = 0, offset = 0;
      offset < imageData.data.length;
      pixelIndex += 1, offset += 4
    ) {
      if (pixelIndex > 0 && pixelIndex % BAKE_PIXELS_PER_YIELD === 0) {
        await yieldToBakeUi();
      }
      const layerCoverage = imageData.data[offset + 3] / 255;
      if (layerCoverage <= COVERAGE_THRESHOLD) continue;
      const qualityFade = smoothstep(
        0,
        0.15,
        Math.max(qualityMap[pixelIndex], layerCoverage * 0.25),
      );
      const alpha = Math.max(0, Math.min(1, layerCoverage * (0.75 + 0.25 * qualityFade)));
      if (alpha <= 0.0001) continue;

      const baseAlpha = base.data[offset + 3] / 255;
      const outputAlpha = alpha + baseAlpha * (1 - alpha);
      if (outputAlpha <= 0.0001) continue;
      const baseRed = srgbByteToLinear(base.data[offset]);
      const baseGreen = srgbByteToLinear(base.data[offset + 1]);
      const baseBlue = srgbByteToLinear(base.data[offset + 2]);
      const layerRed = srgbByteToLinear(imageData.data[offset]);
      const layerGreen = srgbByteToLinear(imageData.data[offset + 1]);
      const layerBlue = srgbByteToLinear(imageData.data[offset + 2]);

      // Keep straight-alpha RGB when an overlay is baked onto a transparent UV
      // target. Blending the edge against transparent black and then forcing it
      // opaque produced the thin dark outline around local repaint patches.
      const retainedBaseAlpha = baseAlpha * (1 - alpha);
      base.data[offset] = linearToSrgbByte(
        (baseRed * retainedBaseAlpha + layerRed * alpha) / outputAlpha,
      );
      base.data[offset + 1] = linearToSrgbByte(
        (baseGreen * retainedBaseAlpha + layerGreen * alpha) / outputAlpha,
      );
      base.data[offset + 2] = linearToSrgbByte(
        (baseBlue * retainedBaseAlpha + layerBlue * alpha) / outputAlpha,
      );
      base.data[offset + 3] = Math.round(outputAlpha * 255);
      coverage[pixelIndex] = 1;
    }
  }
}

function downsampleCoverage(
  coverage: Uint8Array,
  sourceResolution: number,
  targetResolution: number,
) {
  const downsampled = new Uint8Array(targetResolution * targetResolution);
  const targetBySource = new Int32Array(sourceResolution);
  for (let index = 0; index < sourceResolution; index += 1) {
    targetBySource[index] = Math.min(
      targetResolution - 1,
      Math.floor((index / sourceResolution) * targetResolution),
    );
  }
  for (let y = 0; y < sourceResolution; y += 1) {
    const sourceRowOffset = y * sourceResolution;
    const targetRowOffset = targetBySource[y] * targetResolution;
    for (let x = 0; x < sourceResolution; x += 1) {
      if (!coverage[sourceRowOffset + x]) continue;
      downsampled[targetRowOffset + targetBySource[x]] = 1;
    }
  }
  return downsampled;
}

function compareCoverage(candidate: Uint8Array, reference: Uint8Array) {
  let candidateCount = 0;
  let referenceCount = 0;
  let intersection = 0;
  let union = 0;
  for (let index = 0; index < reference.length; index += 1) {
    const hasCandidate = candidate[index] > 0;
    const hasReference = reference[index] > 0;
    if (hasCandidate) candidateCount += 1;
    if (hasReference) referenceCount += 1;
    if (hasCandidate && hasReference) intersection += 1;
    if (hasCandidate || hasReference) union += 1;
  }
  return {
    candidateCount,
    referenceCount,
    iou: union > 0 ? intersection / union : 1,
    coverageRatio: referenceCount > 0 ? candidateCount / referenceCount : 1,
  };
}

async function validateGpuBakeCoverage(input: {
  group: THREE.Group;
  layers: Layer[];
  objectId: string;
  gpuCanvas: HTMLCanvasElement;
  gpuCoverage: Uint8Array;
  gpuResolution: UvBakeResolution;
  enableBackfaceCulling: boolean;
  enableDilation: boolean;
  dilationPixels: number;
  outputAlpha: 'opaque-viewport' | 'transparent';
}) {
  const referenceComposite = new ImageData(
    GPU_COVERAGE_VALIDATION_RESOLUTION,
    GPU_COVERAGE_VALIDATION_RESOLUTION,
  );
  const qualityBlendComposite = createQualityBlendStackComposite(
    GPU_COVERAGE_VALIDATION_RESOLUTION,
  );
  const overlayRasters: OverlayRaster[] = [];

  for (const layer of input.layers) {
    const [projectedImage, maskImage, depthImage] = await Promise.all([
      loadImageData(layer.imageUrl, GPU_COVERAGE_VALIDATION_RESOLUTION, `${layer.name} image`),
      layer.maskUrl
        ? loadImageData(layer.maskUrl, GPU_COVERAGE_VALIDATION_RESOLUTION, `${layer.name} mask`)
        : Promise.resolve(undefined),
      layer.depthUrl
        ? loadImageData(layer.depthUrl, GPU_COVERAGE_VALIDATION_RESOLUTION, `${layer.name} depth`)
        : Promise.resolve(undefined),
    ]);
    const rasterized = await rasterizeProjectedLayerToUv({
      group: input.group,
      layer,
      projectedImage,
      maskImage,
      depthImage,
      bakeInput: {
        objectId: input.objectId,
        layerId: layer.id,
        resolution: GPU_COVERAGE_VALIDATION_RESOLUTION,
        opacity: layer.opacity,
        enableBackfaceCulling: input.enableBackfaceCulling,
        enableDilation: false,
        dilationPixels: 0,
      },
    });
    const layerContext = rasterized.canvas.getContext('2d', { willReadFrequently: true });
    if (!layerContext) throw new Error('Could not read CPU GPU-validation layer canvas.');
    const layerImageData = layerContext.getImageData(
      0,
      0,
      GPU_COVERAGE_VALIDATION_RESOLUTION,
      GPU_COVERAGE_VALIDATION_RESOLUTION,
    );
    if (layer.blendMode === 'overlay') {
      overlayRasters.push({ layer, imageData: layerImageData, quality: rasterized.quality });
    } else {
      await accumulateQualityBlendLayer(
        qualityBlendComposite,
        layerImageData,
        rasterized.quality,
        layer.id,
      );
    }
  }
  await writeQualityBlendStackComposite(qualityBlendComposite, referenceComposite);
  await applyOverlayRasters(referenceComposite, qualityBlendComposite.coverage, overlayRasters);
  if (input.enableDilation) {
    dilateImageData(referenceComposite, qualityBlendComposite.coverage, input.dilationPixels);
  }
  if (input.outputAlpha !== 'transparent') {
    await fillTransparentTexelsForViewport(referenceComposite);
  } else {
    await clearWeakTransparentTexels(referenceComposite);
  }

  const gpuCoverage = downsampleCoverage(
    input.gpuCoverage,
    input.gpuResolution,
    GPU_COVERAGE_VALIDATION_RESOLUTION,
  );
  const comparison = compareCoverage(gpuCoverage, qualityBlendComposite.coverage);
  if (comparison.referenceCount === 0) return comparison;
  if (
    comparison.iou < MIN_GPU_CPU_COVERAGE_IOU ||
    comparison.coverageRatio < MIN_GPU_CPU_COVERAGE_RATIO
  ) {
    throw new Error(
      `GPU bake coverage diverged from CPU validation (IoU ${comparison.iou.toFixed(2)}, coverage ratio ${comparison.coverageRatio.toFixed(2)}).`,
    );
  }

  const gpuCanvas = document.createElement('canvas');
  gpuCanvas.width = GPU_COVERAGE_VALIDATION_RESOLUTION;
  gpuCanvas.height = GPU_COVERAGE_VALIDATION_RESOLUTION;
  const gpuContext = gpuCanvas.getContext('2d', { willReadFrequently: true });
  if (!gpuContext) throw new Error('Could not create GPU validation canvas.');
  gpuContext.imageSmoothingEnabled = true;
  gpuContext.imageSmoothingQuality = 'high';
  gpuContext.drawImage(
    input.gpuCanvas,
    0,
    0,
    GPU_COVERAGE_VALIDATION_RESOLUTION,
    GPU_COVERAGE_VALIDATION_RESOLUTION,
  );
  const gpuImage = gpuContext.getImageData(
    0,
    0,
    GPU_COVERAGE_VALIDATION_RESOLUTION,
    GPU_COVERAGE_VALIDATION_RESOLUTION,
  );

  let comparedPixels = 0;
  let totalColorError = 0;
  for (let offset = 0; offset < referenceComposite.data.length; offset += 4) {
    if (referenceComposite.data[offset + 3] <= MIN_TRANSPARENT_OUTPUT_ALPHA) continue;
    if (gpuImage.data[offset + 3] <= MIN_TRANSPARENT_OUTPUT_ALPHA) continue;
    comparedPixels += 1;
    totalColorError +=
      Math.abs(referenceComposite.data[offset] - gpuImage.data[offset]) +
      Math.abs(referenceComposite.data[offset + 1] - gpuImage.data[offset + 1]) +
      Math.abs(referenceComposite.data[offset + 2] - gpuImage.data[offset + 2]);
  }
  const meanColorError = comparedPixels > 0 ? totalColorError / (comparedPixels * 3 * 255) : 0;
  if (comparedPixels > 0 && meanColorError > MAX_GPU_CPU_COLOR_MEAN_ERROR) {
    throw new Error(
      `GPU bake color diverged from CPU validation (mean RGB error ${meanColorError.toFixed(2)}).`,
    );
  }
  return { ...comparison, meanColorError };
}

export async function bakeVisibleProjectedLayersToTexture(
  input: BakeVisibleProjectedLayersInput,
): Promise<BakeProjectedLayerResult> {
  const startedAt = performance.now();
  const importedModel = useSceneStore.getState().importedModel;
  if (!importedModel || importedModel.objectId !== input.objectId) {
    throw new Error('Please import a model first.');
  }
  if (!importedModel.uvSets.includes('UV0')) throw new Error('This model has no UVs.');

  const requestedLayerIdSet = input.layerIds ? new Set(input.layerIds) : undefined;
  const sourceLayers = input.transientLayers
    ? input.transientLayers.filter(
        (layer) =>
          layer.type === 'projected' &&
          layer.imageUrl &&
          layer.camera &&
          (!layer.objectId || layer.objectId === input.objectId),
      )
    : requestedLayerIdSet
      ? useLayerStore
          .getState()
          .layers.filter(
            (layer) =>
              requestedLayerIdSet.has(layer.id) &&
              layer.type === 'projected' &&
              layer.imageUrl &&
              layer.camera &&
              (!layer.objectId || layer.objectId === input.objectId),
          )
          .sort((a, b) => b.order - a.order)
      : getVisibleProjectedLayerStack(useLayerStore.getState().layers, input.objectId);
  let layers = sourceLayers.map((layer) => ({
    ...layer,
    maskUrl: input.debugIgnoreMask ? undefined : layer.maskUrl,
    depthUrl: input.debugIgnoreDepth ? undefined : layer.depthUrl,
    normalUrl: input.debugIgnoreDepth ? undefined : layer.normalUrl,
  }));

  if (layers.length === 0) throw new Error('No visible projected layers to bake.');
  const performanceBreakdown: Record<string, number> = {};
  let uvGutterTopologyPromise:
    | Promise<WebGpuUvTopologyRasterResult | undefined>
    | undefined;
  const getUvGutterTopology = () => {
    if ((input.uvIslandGutterPixels ?? 0) <= 0) return Promise.resolve(undefined);
    uvGutterTopologyPromise ??= rasterizeUvTopologyMaskWithWebGpu(
      importedModel.group,
      input.resolution,
      input.resolution,
    )
      .then((result) => {
        performanceBreakdown.uvTopologySerializeMs = result.serializeMs;
        performanceBreakdown.uvTopologyGpuMs = result.gpuMs;
        performanceBreakdown.uvTopologyCpuGoldMs = result.cpuGoldMs;
        performanceBreakdown.uvTopologyWorkerTotalMs = result.totalMs;
        performanceBreakdown.uvTopologyGpuAccepted = result.gpuAccepted ? 1 : 0;
        performanceBreakdown.uvTopologyGpuMismatchedPixels = result.mismatchedPixels;
        performanceBreakdown.uvTopologyGpuCalibrationPixels =
          result.rawMismatchedPixels;
        performanceBreakdown.uvTopologyGpuMaximumDifference = result.maximumDifference;
        if (typeof document !== 'undefined') {
          document.body.dataset.perfUvTopologyBackend = result.backend;
          document.body.dataset.perfUvTopologyGpuAccepted = result.gpuAccepted ? '1' : '0';
          document.body.dataset.perfUvTopologyGpuMismatches = String(
            result.mismatchedPixels,
          );
          document.body.dataset.perfUvTopologyGpuCalibrationPixels = String(
            result.rawMismatchedPixels,
          );
          document.body.dataset.perfUvTopologyTotalMs = result.totalMs.toFixed(1);
        }
        return result;
      })
      .catch((error) => {
        performanceBreakdown.uvTopologyGpuAccepted = 0;
        console.warn(
          '[Liclick 3D Texture] Worker WebGPU UV topology unavailable; using the compatibility raster.',
          error,
        );
        if (typeof document !== 'undefined') {
          document.body.dataset.perfUvTopologyBackend = 'compatibility-main-thread';
          document.body.dataset.perfUvTopologyGpuAccepted = '0';
        }
        return undefined;
      });
    return uvGutterTopologyPromise;
  };
  const dilationPixels = getUvDilationPixels(input.resolution, input.dilationPixels);
  input.onProgress?.({
    phase: 'loading-assets',
    progress: 0.02,
    layerIndex: 0,
    layerCount: layers.length,
  });

  const gpuFallbackWarnings: string[] = [];
  const renderer = useSceneStore.getState().viewport?.gl;
  // The live viewport builds visibility from the current model pose. Rebuild
  // that same depth + geometric-normal capture immediately before UV baking so
  // merge/export cannot fall back to stale capture depth or extrapolate onto
  // surfaces that were not visible in the projected preview.
  const runtimeDepthStartedAt = performance.now();
  markUvBakePerformancePhase('runtime-depth');
  if (renderer && !input.debugIgnoreDepth) {
    const currentProject = useProjectStore.getState().getCurrentProject();
    const captureById = new Map(
      currentProject?.captures.map((capture) => [capture.id, capture] as const) ?? [],
    );
    importedModel.group.updateMatrixWorld(true);
    const currentObjectMatrixWorld = importedModel.group.matrixWorld.toArray();
    const matrixMatches = (captured?: number[]) =>
      captured?.length === 16 &&
      captured.every(
        (value, index) => Math.abs(value - currentObjectMatrixWorld[index]) <= 1e-6,
      );
    let reusedVisibilityLayerCount = 0;
    let regeneratedVisibilityLayerCount = 0;
    layers = await Promise.all(
      layers.map(async (layer) => {
        if (
          layer.depthUrl &&
          layer.normalUrl &&
          layer.depthEncoding === 'linear-view' &&
          matrixMatches(layer.objectMatrixWorld)
        ) {
          reusedVisibilityLayerCount += 1;
          return layer;
        }
        regeneratedVisibilityLayerCount += 1;
        const capture = layer.captureId ? captureById.get(layer.captureId) : undefined;
        const visibility = await createRuntimeProjectionDepth({
          renderer,
          group: importedModel.group,
          camera: layer.camera!,
          captureObjectMatrixWorld: layer.objectMatrixWorld,
          width: Math.max(1, Math.min(2048, capture?.width ?? 1024)),
          height: Math.max(1, Math.min(2048, capture?.height ?? 1024)),
        });
        return {
          ...layer,
          depthUrl: visibility.depthUrl,
          depthEncoding: 'linear-view' as const,
          normalUrl: visibility.normalUrl,
        };
      }),
    );
    performanceBreakdown.runtimeDepthReusedLayers = reusedVisibilityLayerCount;
    performanceBreakdown.runtimeDepthRegeneratedLayers = regeneratedVisibilityLayerCount;
  }
  performanceBreakdown.runtimeDepthMs = performance.now() - runtimeDepthStartedAt;
  const bakeMethod = input.method ?? getDebugUvBakeMethod('gpu');
  if (bakeMethod !== 'cpu' && renderer) {
    try {
      const gpuCompositeMode = input.gpuCompositeMode ?? 'cpu-parity';
      const gpuProjectedImageUvFlipY =
        input.gpuProjectedImageUvFlipY ?? getDebugGpuProjectedImageUvFlipY(true);
      if (gpuCompositeMode === 'cpu-parity') {
        const gpuRasterStartedAt = performance.now();
        markUvBakePerformancePhase('gpu-raster-readback');
        const gpuBake = await bakeProjectedLayerRastersWithGpu({
          renderer,
          group: importedModel.group,
          layers,
          resolution: input.resolution,
          enableBackfaceCulling: input.enableBackfaceCulling,
          enableDilation: false,
          dilationPixels: 0,
          outputAlpha: input.outputAlpha ?? 'opaque-viewport',
          inputTextureFlipY: input.gpuInputTextureFlipY ?? true,
          projectedImageUvFlipY: gpuProjectedImageUvFlipY,
          compositeMode: gpuCompositeMode,
          strictDepthCheck: input.strictDepthCheck,
          maximumDepthError: input.maximumDepthError,
          minimumOutputCoverage: input.minimumOutputCoverage,
          constrainDilationToInteriorHoles: input.constrainDilationToInteriorHoles,
          onProgress: (progress) =>
            input.onProgress?.({
              ...progress,
              progress: 0.04 + clampProgress(progress.progress) * 0.84,
            }),
        });
        performanceBreakdown.gpuRasterAndReadbackMs = performance.now() - gpuRasterStartedAt;

        input.onProgress?.({
          phase: 'compositing',
          progress: 0.9,
          layerIndex: layers.length - 1,
          layerCount: layers.length,
        });
        const canvas = document.createElement('canvas');
        canvas.width = input.resolution;
        canvas.height = input.resolution;
        const context = canvas.getContext('2d', { willReadFrequently: true });
        if (!context) throw new Error('Could not create GPU parity UV bake canvas.');
        const overlayRasters: OverlayRaster[] = [];
        const normalRasters: Array<{ color: Uint8ClampedArray; quality: Float32Array }> = [];
        const warnings = [...gpuBake.warnings];
        if (layers.length > 1) {
          warnings.push(
            layers.some((layer) => layer.blendMode === 'overlay')
              ? 'GPU sampled layers used CPU parity loose coverage with strict quality blend and order-sensitive overlay layers.'
              : 'GPU sampled layers used CPU parity order-independent loose coverage with strict quality blend.',
          );
        }

        let writtenTexels = 0;
        markUvBakePerformancePhase('quality-accumulate');
        for (const raster of gpuBake.rasters) {
          const layerImageData = raster.imageData;
          if (raster.layer.blendMode === 'overlay') {
            overlayRasters.push({
              layer: raster.layer,
              imageData: layerImageData,
              quality: raster.quality,
            });
          } else {
            normalRasters.push({ color: layerImageData.data, quality: raster.quality });
          }
        }
        const qualityBlend = await blendProjectedRastersInWorker(
          normalRasters,
          input.resolution,
          input.preserveCoverageConfidenceAlpha ?? false,
          overlayRasters.map((raster) => ({
            color: raster.imageData.data,
            quality: raster.quality,
          })),
        );
        const composite = qualityBlend.imageData;
        const qualityCoverage = qualityBlend.coverage;
        writtenTexels = qualityBlend.writtenTexels;
        performanceBreakdown.qualityAccumulateMs = qualityBlend.accumulateMs;
        performanceBreakdown.qualityResolveMs = qualityBlend.resolveMs;
        performanceBreakdown.qualityOverlayMs = qualityBlend.overlayMs;
        performanceBreakdown.qualityWorkerTotalMs = qualityBlend.totalMs;
        if (qualityBlend.verification) {
          performanceBreakdown.qualityGpuByteMismatches =
            qualityBlend.verification.byteMismatches;
          performanceBreakdown.qualityGpuMaximumByteDelta =
            qualityBlend.verification.maximumByteDelta;
          performanceBreakdown.qualityGpuAlphaByteMismatches =
            qualityBlend.verification.alphaByteMismatches;
        }
        warnings.push(
          qualityBlend.backend === 'webgpu-worker'
            ? qualityBlend.verification?.usedCpuOutput
              ? `WebGPU quality blend parity rejected ${qualityBlend.verification.byteMismatches} differing bytes; exact Worker CPU output was used.`
              : qualityBlend.verification?.acceptedGpuOutput
                ? qualityBlend.verification.byteMismatches === 0
                  ? 'WebGPU quality blend passed exact Worker CPU byte parity and was published.'
                  : `WebGPU quality blend calibration accepted ${qualityBlend.verification.byteMismatches} RGB byte differences at maximum delta ${qualityBlend.verification.maximumByteDelta}; alpha was exact and the GPU result was published.`
                : 'WebGPU quality blend used the adapter-calibrated GPU path.'
            : 'WebGPU quality blend unavailable; exact Worker CPU output was used.',
        );

        const qualityResolveStartedAt = performance.now();
        markUvBakePerformancePhase('quality-resolve');
        if (input.outputAlpha === 'transparent') {
          await clearWeakTransparentTexels(composite, qualityCoverage);
        }
        if (input.outputAlpha !== 'transparent') {
          await sharpenCoveredTexels(composite, qualityCoverage);
        }
        performanceBreakdown.qualityPostprocessMs = performance.now() - qualityResolveStartedAt;
        const seamStartedAt = performance.now();
        markUvBakePerformancePhase('seam-reconcile');
        if (input.outputAlpha !== 'transparent' || input.repairMissingUvSeams) {
          const seamResult = reconcileUvSeams(
            composite,
            importedModel.group,
            qualityCoverage,
            {
              repairMissingCoverage: input.repairMissingUvSeams,
              bandPixels: input.uvSeamRepairPixels,
            },
          );
          if (seamResult.adjustedPixels > 0) {
            warnings.push(
              `Geometry-aware UV seam reconciliation adjusted ${seamResult.adjustedPixels} edge texels across ${seamResult.seamPairs} seam pairs.`,
            );
          }
        }
        performanceBreakdown.seamReconcileMs = performance.now() - seamStartedAt;
        const coverageRepairStartedAt = performance.now();
        markUvBakePerformancePhase('coverage-repair');
        if ((input.uvCoverageGapPixels ?? 0) > 0) {
          const filledPixels = dilateUvCoverageWithinTopology(
            composite,
            qualityCoverage,
            importedModel.group,
            Math.ceil((input.uvCoverageGapPixels ?? 0) / 2),
          );
          if (filledPixels > 0) {
            warnings.push(`UV-topology coverage repair filled ${filledPixels} texels.`);
          }
        }
        if ((input.uvInteriorHolePixels ?? 0) > 0) {
          const filledPixels = await fillUvInteriorGapsWithIslandOwnership(
            composite,
            qualityCoverage,
            importedModel.group,
            input.uvInteriorHolePixels ?? 0,
          );
          if (filledPixels > 0) {
            warnings.push(`Safe enclosed UV-gap repair filled ${filledPixels} texels.`);
          }
        }
        performanceBreakdown.coverageRepairMs = performance.now() - coverageRepairStartedAt;
        if (input.enableDilation && !input.constrainDilationToInteriorHoles) {
          dilateImageData(composite, qualityCoverage, dilationPixels);
        }
        const gutterStartedAt = performance.now();
        markUvBakePerformancePhase('gutter');
        if ((input.uvIslandGutterPixels ?? 0) > 0) {
          const topology = await getUvGutterTopology();
          const paddedPixels = topology
            ? padUvIslandGuttersWithTopology(
                composite,
                qualityCoverage,
                topology.mask,
                input.uvIslandGutterPixels ?? 0,
                input.outputAlpha === 'transparent',
              )
            : padUvIslandGutters(
                composite,
                qualityCoverage,
                importedModel.group,
                input.uvIslandGutterPixels ?? 0,
                input.outputAlpha === 'transparent',
              );
          if (paddedPixels > 0) {
            warnings.push(`UV-island gutter padding added ${paddedPixels} filter-only texels.`);
          }
        }
        performanceBreakdown.gutterMs = performance.now() - gutterStartedAt;
        const finalizeStartedAt = performance.now();
        markUvBakePerformancePhase('finalize-canvas');
        if (input.outputAlpha !== 'transparent') await fillTransparentTexelsForViewport(composite);
        else {
          // Keep the exact cleanup in-place and yield every bounded chunk. A
          // worker round-trip transferred ~84 MiB (RGBA + coverage) back to the
          // UI and made the delivery of that message a 550ms browser frame.
          // In-place chunking preserves every byte while avoiding the second
          // full-size allocation, transfer, ImageData wrap, and following GC.
          await clearWeakTransparentTexels(composite, qualityCoverage);
        }
        // Merge callers already consume straight RGBA. Avoid a synchronous
        // 4K ImageData -> Canvas write followed by an immediate Canvas ->
        // ImageData readback when encoding is intentionally deferred.
        if (!input.skipCanvasUpload) context.putImageData(composite, 0, 0);
        performanceBreakdown.finalizeCanvasMs = performance.now() - finalizeStartedAt;

        input.onProgress?.({
          phase: 'encoding',
          progress: 0.96,
          layerIndex: layers.length - 1,
          layerCount: layers.length,
        });
        const { imageBlob, imageUrl } = await encodeVisibleBakeCanvas(canvas, input, composite);
        const coverageRatio = validateBakeCoverage(
          writtenTexels,
          input.resolution,
          input.minimumCoverageRatio,
        );
        const report = createBakeReport({
          startedAt,
          objectId: input.objectId,
          layerId: layers[0].id,
          width: input.resolution,
          height: input.resolution,
          totalTriangles: gpuBake.totalTriangles,
          processedTriangles: gpuBake.processedTriangles,
          coveredPixels: gpuBake.coveredPixels,
          skippedPixels: gpuBake.skippedPixels,
          totalTexels: input.resolution * input.resolution,
          inFrustumTexels: gpuBake.coveredPixels,
          maskRejectedTexels: 0,
          depthRejectedTexels: 0,
          backfaceRejectedTexels: 0,
          writtenTexels,
          coverageRatio,
          warnings,
          performanceBreakdown,
        });

        const bakedTexture: BakedTexture = {
          id: createId('baked-texture'),
          objectId: input.objectId,
          sourceLayerId: layers[0].id,
          sourceLayerIds: layers.map((layer) => layer.id),
          cacheKey: input.cacheKey,
          imageUrl,
          width: input.resolution,
          height: input.resolution,
          format: 'png',
          createdAt: new Date().toISOString(),
          coverageRatio,
          report,
        };

        if (input.commitToProject !== false) {
          useProjectStore.getState().addBakedTexture(bakedTexture);
        }
        if (input.markSourceLayersBaked !== false) {
          useLayerStore.getState().markLayersBaked(
            layers.map((layer) => layer.id),
            bakedTexture.id,
            bakedTexture.createdAt,
          );
        }
        console.info('[Liclick 3D Texture] GPU CPU-parity UV bake report:', report);
        logTransparentBakeSizeDiagnostics(input, canvas, bakedTexture, gpuBake.sourceSizes);

        return {
          bakedTexture,
          canvas,
          imageData: composite,
          imageBlob,
          imageUrl,
          report,
        };
      }

      // Interactive transparent overlays can run the same hole-fill/padding
      // passes entirely on the GPU, then skip the expensive full-canvas CPU
      // seam scan. This keeps local repaint responsive while still closing the
      // small uncovered texels that appear inside UV islands.
      const useGpuDilation = Boolean(input.skipCpuPostprocess && input.enableDilation);
      const gpuBake = await bakeProjectedLayerStackWithGpu({
        renderer,
        group: importedModel.group,
        layers,
        resolution: input.resolution,
        enableBackfaceCulling: input.enableBackfaceCulling,
        enableDilation: useGpuDilation,
        dilationPixels: useGpuDilation ? dilationPixels : 0,
        outputAlpha: input.outputAlpha ?? 'opaque-viewport',
        inputTextureFlipY: input.gpuInputTextureFlipY ?? true,
        projectedImageUvFlipY: gpuProjectedImageUvFlipY,
        compositeMode: gpuCompositeMode,
        strictDepthCheck: input.strictDepthCheck,
        maximumDepthError: input.maximumDepthError,
        minimumOutputCoverage: input.minimumOutputCoverage,
        constrainDilationToInteriorHoles: input.constrainDilationToInteriorHoles,
        repairMissingUvSeams: input.skipCpuPostprocess
          ? input.repairMissingUvSeams
          : false,
        uvSeamRepairPixels: input.uvSeamRepairPixels,
        onProgress: (progress) =>
          input.onProgress?.({
            ...progress,
            progress: 0.04 + clampProgress(progress.progress) * 0.84,
          }),
      });
      input.onProgress?.({
        phase: 'compositing',
        progress: 0.9,
        layerIndex: layers.length - 1,
        layerCount: layers.length,
      });
      const wantsTransparentOutput = input.outputAlpha === 'transparent';
      const needsCpuSharpen = !gpuBake.postProcessedOnGpu && !wantsTransparentOutput;
      const needsCpuViewportFill = !gpuBake.opaqueBaseColorReady && !wantsTransparentOutput;
      const canSkipCpuPostprocess =
        input.skipCpuPostprocess &&
        wantsTransparentOutput &&
        (input.uvCoverageGapPixels ?? 0) <= 0 &&
        (input.uvInteriorHolePixels ?? 0) <= 0 &&
        (input.uvIslandGutterPixels ?? 0) <= 0 &&
        !needsCpuSharpen &&
        !needsCpuViewportFill &&
        (!input.enableDilation || useGpuDilation);
      let straightRgbaImageData: ImageData | undefined;
      if (!canSkipCpuPostprocess) {
        const gpuContext = gpuBake.canvas.getContext('2d', { willReadFrequently: true });
        if (!gpuContext) throw new Error('Could not read GPU UV bake canvas.');
        const gpuImage = gpuContext.getImageData(0, 0, input.resolution, input.resolution);
        if (wantsTransparentOutput) {
          await clearWeakTransparentTexels(gpuImage, gpuBake.coverage);
        }
        if (needsCpuSharpen) await sharpenCoveredTexels(gpuImage, gpuBake.coverage);
        if (!wantsTransparentOutput || input.repairMissingUvSeams) {
          const seamResult = reconcileUvSeams(
            gpuImage,
            importedModel.group,
            gpuBake.coverage,
            {
              repairMissingCoverage: input.repairMissingUvSeams,
              bandPixels: input.uvSeamRepairPixels,
            },
          );
          if (seamResult.adjustedPixels > 0) {
            gpuBake.warnings.push(
              `Geometry-aware UV seam reconciliation adjusted ${seamResult.adjustedPixels} edge texels across ${seamResult.seamPairs} seam pairs.`,
            );
          }
        }
        if ((input.uvCoverageGapPixels ?? 0) > 0) {
          const filledPixels = dilateUvCoverageWithinTopology(
            gpuImage,
            gpuBake.coverage,
            importedModel.group,
            Math.ceil((input.uvCoverageGapPixels ?? 0) / 2),
          );
          if (filledPixels > 0) {
            gpuBake.warnings.push(
              `UV-topology coverage repair filled ${filledPixels} texels.`,
            );
          }
        }
        if ((input.uvInteriorHolePixels ?? 0) > 0) {
          const filledPixels = await fillUvInteriorGapsWithIslandOwnership(
            gpuImage,
            gpuBake.coverage,
            importedModel.group,
            input.uvInteriorHolePixels ?? 0,
          );
          if (filledPixels > 0) {
            gpuBake.warnings.push(
              `Safe enclosed UV-gap repair filled ${filledPixels} texels.`,
            );
          }
        }
        if (input.enableDilation && !input.constrainDilationToInteriorHoles)
          dilateImageData(gpuImage, gpuBake.coverage, dilationPixels);
        if ((input.uvIslandGutterPixels ?? 0) > 0) {
          const topology = await getUvGutterTopology();
          const paddedPixels = topology
            ? padUvIslandGuttersWithTopology(
                gpuImage,
                gpuBake.coverage,
                topology.mask,
                input.uvIslandGutterPixels ?? 0,
                wantsTransparentOutput,
              )
            : padUvIslandGutters(
                gpuImage,
                gpuBake.coverage,
                importedModel.group,
                input.uvIslandGutterPixels ?? 0,
                wantsTransparentOutput,
              );
          if (paddedPixels > 0) {
            gpuBake.warnings.push(
              `UV-island gutter padding added ${paddedPixels} filter-only texels.`,
            );
          }
        }
        if (needsCpuViewportFill) await fillTransparentTexelsForViewport(gpuImage);
        else if (wantsTransparentOutput) await clearWeakTransparentTexels(gpuImage, gpuBake.coverage);
        gpuContext.putImageData(gpuImage, 0, 0);
        straightRgbaImageData = gpuImage;
      }
      if (
        !input.skipGpuValidation &&
        (shouldValidateGpuBakeCoverage() || input.outputAlpha === 'transparent')
      ) {
        await validateGpuBakeCoverage({
          group: importedModel.group,
          layers,
          objectId: input.objectId,
          gpuCanvas: gpuBake.canvas,
          gpuCoverage: gpuBake.coverage,
          gpuResolution: input.resolution,
          enableBackfaceCulling: input.enableBackfaceCulling,
          enableDilation: input.enableDilation,
          dilationPixels,
          outputAlpha: input.outputAlpha ?? 'opaque-viewport',
        });
      }
      input.onProgress?.({
        phase: 'encoding',
        progress: 0.96,
        layerIndex: layers.length - 1,
        layerCount: layers.length,
      });
      const { imageBlob, imageUrl } = await encodeVisibleBakeCanvas(
        gpuBake.canvas,
        input,
        straightRgbaImageData,
      );
      const coverageRatio = validateBakeCoverage(
        gpuBake.coveredPixels,
        input.resolution,
        input.minimumCoverageRatio,
      );
      const report = createBakeReport({
        startedAt,
        objectId: input.objectId,
        layerId: layers[0].id,
        width: input.resolution,
        height: input.resolution,
        totalTriangles: gpuBake.totalTriangles,
        processedTriangles: gpuBake.processedTriangles,
        coveredPixels: gpuBake.coveredPixels,
        skippedPixels: gpuBake.skippedPixels,
        totalTexels: input.resolution * input.resolution,
        inFrustumTexels: gpuBake.inFrustumPixels,
        maskRejectedTexels: gpuBake.maskRejectedPixels,
        depthRejectedTexels: gpuBake.depthRejectedPixels,
        backfaceRejectedTexels: gpuBake.backfaceRejectedPixels,
        writtenTexels: gpuBake.coveredPixels,
        coverageRatio,
        warnings: gpuBake.warnings,
      });

      const bakedTexture: BakedTexture = {
        id: createId('baked-texture'),
        objectId: input.objectId,
        sourceLayerId: layers[0].id,
        sourceLayerIds: layers.map((layer) => layer.id),
        cacheKey: input.cacheKey,
        imageUrl,
        width: input.resolution,
        height: input.resolution,
        format: 'png',
        createdAt: new Date().toISOString(),
        coverageRatio,
        report,
      };

      if (input.commitToProject !== false) {
        useProjectStore.getState().addBakedTexture(bakedTexture);
      }
      if (input.markSourceLayersBaked !== false) {
        useLayerStore.getState().markLayersBaked(
          layers.map((layer) => layer.id),
          bakedTexture.id,
          bakedTexture.createdAt,
        );
      }
      console.info('[Liclick 3D Texture] GPU stacked UV bake report:', report);
      logTransparentBakeSizeDiagnostics(input, gpuBake.canvas, bakedTexture, gpuBake.sourceSizes);

      return {
        bakedTexture,
        canvas: gpuBake.canvas,
        imageBlob,
        imageUrl,
        report,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (input.disableGpuFallback) {
        throw new Error(`GPU bake failed with debug fallback disabled. ${message}`);
      }
      gpuFallbackWarnings.push(
        `GPU bake failed; used CPU fallback at the same resolution. ${message}`,
      );
      console.warn('[Liclick 3D Texture] GPU UV bake failed; falling back to CPU bake.', error);
    }
  }

  const canvas = document.createElement('canvas');
  canvas.width = input.resolution;
  canvas.height = input.resolution;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('Could not create stacked UV bake canvas.');
  const composite = new ImageData(input.resolution, input.resolution);
  const qualityBlendComposite = createQualityBlendStackComposite(input.resolution);
  const overlayRasters: OverlayRaster[] = [];
  const readableLayers: Layer[] = [];
  const sourceSizes: CpuLayerSourceSize[] = [];

  let totalTriangles = 0;
  let processedTriangles = 0;
  let coveredPixels = 0;
  let skippedPixels = 0;
  let inFrustumTexels = 0;
  let maskRejectedTexels = 0;
  let depthRejectedTexels = 0;
  let backfaceRejectedTexels = 0;
  const warnings: string[] = [...gpuFallbackWarnings];
  if (layers.length > 1) {
    warnings.push(
      layers.some((layer) => layer.blendMode === 'overlay')
        ? 'Multiple projected layers used loose coverage with strict quality blend and order-sensitive overlay layers.'
        : 'Multiple projected layers used order-independent loose coverage with strict quality blend.',
    );
  }

  for (const [layerIndex, layer] of layers.entries()) {
    const layerStart = 0.04 + (layerIndex / layers.length) * 0.82;
    const layerSpan = 0.82 / layers.length;
    input.onProgress?.({
      phase: 'loading-assets',
      progress: layerStart,
      layerName: layer.name,
      layerIndex,
      layerCount: layers.length,
    });
    let projectedImage: ImageData;
    let maskImage: ImageData | undefined;
    let depthImage: ImageData | undefined;
    try {
      projectedImage = await loadImageData(layer.imageUrl, input.resolution, `${layer.name} image`);
      [maskImage, depthImage] = await Promise.all([
        loadOptionalBakeImage(layer.maskUrl, input.resolution, `${layer.name} mask`, warnings),
        loadOptionalBakeImage(layer.depthUrl, input.resolution, `${layer.name} depth`, warnings),
      ]);
      sourceSizes.push({
        layerId: layer.id,
        layerName: layer.name,
        projectedImage: `${projectedImage.width}x${projectedImage.height}`,
        maskImage: maskImage ? `${maskImage.width}x${maskImage.height}` : undefined,
        depthImage: depthImage ? `${depthImage.width}x${depthImage.height}` : undefined,
      });
      readableLayers.push(layer);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      warnings.push(`${layer.name}: skipped unreadable projected layer. ${message}`);
      console.warn(
        '[Liclick 3D Texture] Skipping unreadable projected layer during UV bake:',
        layer,
        error,
      );
      continue;
    }
    const rasterized = await rasterizeProjectedLayerToUv({
      group: importedModel.group,
      layer,
      projectedImage,
      maskImage,
      depthImage,
      bakeInput: {
        objectId: input.objectId,
        layerId: layer.id,
        resolution: input.resolution,
        opacity: layer.opacity,
        enableBackfaceCulling: input.enableBackfaceCulling,
        enableDilation: false,
        dilationPixels: 0,
        onProgress: (progress) =>
          input.onProgress?.({
            ...progress,
            progress: layerStart + clampProgress(progress.progress) * layerSpan,
            layerName: progress.layerName ?? layer.name,
            layerIndex,
            layerCount: layers.length,
          }),
      },
    });
    const layerContext = rasterized.canvas.getContext('2d', { willReadFrequently: true });
    if (!layerContext) throw new Error('Could not read layer bake canvas.');
    const layerImageData = layerContext.getImageData(0, 0, input.resolution, input.resolution);
    if (layer.blendMode === 'overlay') {
      overlayRasters.push({ layer, imageData: layerImageData, quality: rasterized.quality });
    } else {
      await accumulateQualityBlendLayer(
        qualityBlendComposite,
        layerImageData,
        rasterized.quality,
        layer.id,
      );
    }
    totalTriangles += rasterized.totalTriangles;
    processedTriangles += rasterized.processedTriangles;
    coveredPixels += rasterized.coveredPixels;
    skippedPixels += rasterized.skippedPixels;
    inFrustumTexels += rasterized.inFrustumPixels;
    maskRejectedTexels += rasterized.maskRejectedPixels;
    depthRejectedTexels += rasterized.depthRejectedPixels;
    backfaceRejectedTexels += rasterized.backfaceRejectedPixels;
    warnings.push(...rasterized.warnings.map((warning) => `${layer.name}: ${warning}`));
  }

  input.onProgress?.({
    phase: 'compositing',
    progress: 0.9,
    layerIndex: layers.length - 1,
    layerCount: layers.length,
  });
  if (readableLayers.length === 0) {
    throw new Error(
      'No readable projected layers could be baked. Regenerate or re-add the projected layers whose images are missing.',
    );
  }
  const blendWrittenTexels = await writeQualityBlendStackComposite(
    qualityBlendComposite,
    composite,
    input.preserveCoverageConfidenceAlpha,
  );
  await applyOverlayRasters(composite, qualityBlendComposite.coverage, overlayRasters);
  if (input.outputAlpha === 'transparent') {
    await clearWeakTransparentTexels(composite, qualityBlendComposite.coverage);
  }
  let writtenTexels = 0;
  for (let index = 0; index < qualityBlendComposite.coverage.length; index += 1) {
    if (qualityBlendComposite.coverage[index]) writtenTexels += 1;
  }
  if (writtenTexels === 0) writtenTexels = blendWrittenTexels;
  if (input.outputAlpha !== 'transparent') {
    await sharpenCoveredTexels(composite, qualityBlendComposite.coverage);
  }
  if (input.outputAlpha !== 'transparent' || input.repairMissingUvSeams) {
    const seamResult = reconcileUvSeams(
      composite,
      importedModel.group,
      qualityBlendComposite.coverage,
      {
        repairMissingCoverage: input.repairMissingUvSeams,
        bandPixels: input.uvSeamRepairPixels,
      },
    );
    if (seamResult.adjustedPixels > 0) {
      warnings.push(
        `Geometry-aware UV seam reconciliation adjusted ${seamResult.adjustedPixels} edge texels across ${seamResult.seamPairs} seam pairs.`,
      );
    }
  }
  if ((input.uvCoverageGapPixels ?? 0) > 0) {
    const filledPixels = dilateUvCoverageWithinTopology(
      composite,
      qualityBlendComposite.coverage,
      importedModel.group,
      Math.ceil((input.uvCoverageGapPixels ?? 0) / 2),
    );
    if (filledPixels > 0) {
      warnings.push(`UV-topology coverage repair filled ${filledPixels} texels.`);
    }
  }
  if ((input.uvInteriorHolePixels ?? 0) > 0) {
    const filledPixels = await fillUvInteriorGapsWithIslandOwnership(
      composite,
      qualityBlendComposite.coverage,
      importedModel.group,
      input.uvInteriorHolePixels ?? 0,
    );
    if (filledPixels > 0) {
      warnings.push(`Safe enclosed UV-gap repair filled ${filledPixels} texels.`);
    }
  }
  if (input.enableDilation && !input.constrainDilationToInteriorHoles) {
    dilateImageData(composite, qualityBlendComposite.coverage, dilationPixels);
  }
  if ((input.uvIslandGutterPixels ?? 0) > 0) {
    const topology = await getUvGutterTopology();
    const paddedPixels = topology
      ? padUvIslandGuttersWithTopology(
          composite,
          qualityBlendComposite.coverage,
          topology.mask,
          input.uvIslandGutterPixels ?? 0,
          input.outputAlpha === 'transparent',
        )
      : padUvIslandGutters(
          composite,
          qualityBlendComposite.coverage,
          importedModel.group,
          input.uvIslandGutterPixels ?? 0,
          input.outputAlpha === 'transparent',
        );
    if (paddedPixels > 0) {
      warnings.push(`UV-island gutter padding added ${paddedPixels} filter-only texels.`);
    }
  }
  if (input.outputAlpha !== 'transparent') {
    await fillTransparentTexelsForViewport(composite);
  } else {
    await clearWeakTransparentTexels(composite, qualityBlendComposite.coverage);
  }
  context.putImageData(composite, 0, 0);
  input.onProgress?.({
    phase: 'encoding',
    progress: 0.96,
    layerIndex: layers.length - 1,
    layerCount: layers.length,
  });
  const { imageBlob, imageUrl } = await encodeVisibleBakeCanvas(canvas, input, composite);
  const coverageRatio = validateBakeCoverage(
    writtenTexels,
    input.resolution,
    input.minimumCoverageRatio,
  );
  const report = createBakeReport({
    startedAt,
    objectId: input.objectId,
    layerId: readableLayers[0].id,
    width: input.resolution,
    height: input.resolution,
    totalTriangles,
    processedTriangles,
    coveredPixels,
    skippedPixels,
    totalTexels: input.resolution * input.resolution,
    inFrustumTexels,
    maskRejectedTexels,
    depthRejectedTexels,
    backfaceRejectedTexels,
    writtenTexels,
    coverageRatio,
    warnings,
  });

  const bakedTexture: BakedTexture = {
    id: createId('baked-texture'),
    objectId: input.objectId,
    sourceLayerId: readableLayers[0].id,
    sourceLayerIds: layers.map((layer) => layer.id),
    cacheKey: input.cacheKey,
    imageUrl,
    width: input.resolution,
    height: input.resolution,
    format: 'png',
    createdAt: new Date().toISOString(),
    coverageRatio,
    report,
  };

  if (input.commitToProject !== false) {
    useProjectStore.getState().addBakedTexture(bakedTexture);
  }
  if (input.markSourceLayersBaked !== false) {
    useLayerStore.getState().markLayersBaked(
      layers.map((layer) => layer.id),
      bakedTexture.id,
      bakedTexture.createdAt,
    );
  }
  console.info('[Liclick 3D Texture] Stacked UV bake report:', report);
  logTransparentBakeSizeDiagnostics(input, canvas, bakedTexture, sourceSizes);

  return {
    bakedTexture,
    canvas,
    imageBlob,
    imageUrl,
    report,
  };
}
