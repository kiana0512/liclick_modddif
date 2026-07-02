import type * as THREE from 'three';
import { createBakeReport } from './bakeReport';
import { dilateImageData } from './dilation';
import { bakeProjectedLayerStackWithGpu } from './gpuUvBakeRenderer';
import { loadImageData } from './imageSampler';
import { getVisibleProjectedLayerStack } from './layerStackCache';
import { rasterizeProjectedLayerToUv } from './uvRasterizer';
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
import type { Layer } from '@/types/layer';
import { createRegisteredObjectUrl } from '@/utils/blobUrlRegistry';
import { createId } from '@/utils/id';

const CLAY_TEXTURE_FILL: [number, number, number] = [244, 245, 242];
const MIN_VALID_COVERAGE_RATIO = 0.001;
const SHARPEN_AMOUNT = 0.24;
const SHARPEN_DETAIL_THRESHOLD = 5;
const MAX_CPU_SHARPEN_RESOLUTION = 4096;
const TOP_K_BLEND_LAYERS = 3;
const BLEND_POWER = 4;
const RESIDUAL_MIX = 0.05;
const COLOR_CONSISTENCY_SIGMA = 0.22;
const COVERAGE_THRESHOLD = 0.02;
const QUALITY_FLOOR_FROM_COVERAGE = 0.08;
const GPU_COVERAGE_VALIDATION_RESOLUTION = 512 as UvBakeResolution;
const MIN_GPU_CPU_COVERAGE_IOU = 0.45;
const MIN_GPU_CPU_COVERAGE_RATIO = 0.55;

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

function usesSourceAlphaMask(layer: { generationId?: string }) {
  return typeof layer.generationId === 'string' && layer.generationId.startsWith('texture-map');
}

function validateBakeCoverage(coveredPixels: number, resolution: number) {
  const coverageRatio = coveredPixels / (resolution * resolution);
  if (coverageRatio < MIN_VALID_COVERAGE_RATIO) {
    throw new Error('UV bake produced almost no valid texels; keeping the projected layer unbaked.');
  }
  return coverageRatio;
}

function clampProgress(progress: number) {
  return Math.max(0, Math.min(1, progress));
}

function fillTransparentTexelsForViewport(imageData: ImageData) {
  for (let offset = 0; offset < imageData.data.length; offset += 4) {
    if (imageData.data[offset + 3] !== 0) continue;
    imageData.data[offset] = CLAY_TEXTURE_FILL[0];
    imageData.data[offset + 1] = CLAY_TEXTURE_FILL[1];
    imageData.data[offset + 2] = CLAY_TEXTURE_FILL[2];
    imageData.data[offset + 3] = 255;
  }
}

function clampByte(value: number) {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function smoothstep(edge0: number, edge1: number, value: number) {
  const t = Math.max(0, Math.min(1, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function isSharpenTarget(imageData: ImageData, coverage: Uint8Array | undefined, pixelIndex: number) {
  const alpha = imageData.data[pixelIndex * 4 + 3];
  if (alpha === 0) return false;
  return coverage ? coverage[pixelIndex] === 1 : true;
}

function sharpenCoveredTexels(imageData: ImageData, coverage?: Uint8Array) {
  if (imageData.width > MAX_CPU_SHARPEN_RESOLUTION || imageData.height > MAX_CPU_SHARPEN_RESOLUTION) return;

  const { width, height, data } = imageData;
  const source = new Uint8ClampedArray(data);
  const kernel = [
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

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const pixelIndex = y * width + x;
      if (!isSharpenTarget(imageData, coverage, pixelIndex)) continue;

      const offset = pixelIndex * 4;
      for (let channel = 0; channel < 3; channel += 1) {
        let weightedSum = 0;
        let totalWeight = 0;

        for (const sample of kernel) {
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
          Math.abs(detail) < SHARPEN_DETAIL_THRESHOLD ? original : clampByte(original + detail * SHARPEN_AMOUNT);
      }
    }
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
  if (layer.type !== 'projected') throw new Error('Only projected layers can be baked in this MVP.');
  if (!layer.camera) throw new Error('Projected layer has no capture camera.');
  if (!importedModel.uvSets.includes('UV0')) throw new Error('This model has no UVs.');

  input.onProgress?.({ phase: 'loading-assets', progress: 0.04, layerName: layer.name, layerIndex: 0, layerCount: 1 });
  const [projectedImage, maskImage, depthImage] = await Promise.all([
    loadImageData(layer.imageUrl, input.resolution),
    layer.maskUrl && !usesSourceAlphaMask(layer) ? loadImageData(layer.maskUrl, input.resolution) : Promise.resolve(undefined),
    layer.depthUrl && !usesSourceAlphaMask(layer) ? loadImageData(layer.depthUrl, input.resolution) : Promise.resolve(undefined),
  ]);
  const rasterized = await rasterizeProjectedLayerToUv({
    group: importedModel.group,
    layer,
    projectedImage,
    maskImage,
    depthImage,
    bakeInput: {
      ...input,
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
  sharpenCoveredTexels(rasterImage, rasterized.coverage);
  input.onProgress?.({ phase: 'compositing', progress: 0.9, layerName: layer.name, layerIndex: 0, layerCount: 1 });
  fillTransparentTexelsForViewport(rasterImage);
  rasterContext.putImageData(rasterImage, 0, 0);
  input.onProgress?.({ phase: 'encoding', progress: 0.96, layerName: layer.name, layerIndex: 0, layerCount: 1 });
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
    warnings: rasterized.warnings,
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

  for (let slot = TOP_K_BLEND_LAYERS - 1; slot > insertAt; slot -= 1) {
    composite.coverages[slot][pixelIndex] = composite.coverages[slot - 1][pixelIndex];
    composite.qualities[slot][pixelIndex] = composite.qualities[slot - 1][pixelIndex];
    const targetColorOffset = pixelIndex * 3;
    composite.colors[slot][targetColorOffset] = composite.colors[slot - 1][targetColorOffset];
    composite.colors[slot][targetColorOffset + 1] = composite.colors[slot - 1][targetColorOffset + 1];
    composite.colors[slot][targetColorOffset + 2] = composite.colors[slot - 1][targetColorOffset + 2];
  }

  const colorOffset = pixelIndex * 3;
  composite.coverages[insertAt][pixelIndex] = coverage;
  composite.qualities[insertAt][pixelIndex] = quality;
  composite.colors[insertAt][colorOffset] = layerImage.data[offset];
  composite.colors[insertAt][colorOffset + 1] = layerImage.data[offset + 1];
  composite.colors[insertAt][colorOffset + 2] = layerImage.data[offset + 2];
  composite.coverage[pixelIndex] = 1;
  if (insertAt === 0) composite.winnerLayerIds[pixelIndex] = layerId;
}

function accumulateQualityBlendLayer(
  composite: QualityBlendStackComposite,
  layer: ImageData,
  qualityMap: Float32Array,
  layerId: string,
) {
  for (let pixelIndex = 0, offset = 0; offset < layer.data.length; pixelIndex += 1, offset += 4) {
    const coverage = layer.data[offset + 3] / 255;
    if (coverage <= COVERAGE_THRESHOLD) continue;
    const quality = Math.max(qualityMap[pixelIndex], coverage * QUALITY_FLOOR_FROM_COVERAGE);
    insertBlendCandidate(composite, pixelIndex, offset, coverage, quality, layer, layerId);
  }
}

function srgbByteToLinear(value: number) {
  const color = value / 255;
  return color <= 0.04045 ? color / 12.92 : ((color + 0.055) / 1.055) ** 2.4;
}

function linearToSrgbByte(value: number) {
  const color = Math.max(0, Math.min(1, value));
  const srgb = color <= 0.0031308 ? color * 12.92 : 1.055 * color ** (1 / 2.4) - 0.055;
  return clampByte(srgb * 255);
}

function applyColorConsistency(qualities: number[], colors: number[][]) {
  let totalQuality = 0;
  const base = [0, 0, 0];
  for (let index = 0; index < qualities.length; index += 1) {
    const quality = qualities[index];
    if (quality <= 0) continue;
    totalQuality += quality;
    base[0] += colors[index][0] * quality;
    base[1] += colors[index][1] * quality;
    base[2] += colors[index][2] * quality;
  }
  if (totalQuality <= 0) return;
  base[0] /= totalQuality;
  base[1] /= totalQuality;
  base[2] /= totalQuality;

  for (let index = 0; index < qualities.length; index += 1) {
    if (qualities[index] <= 0) continue;
    const color = colors[index];
    const diff = Math.hypot(color[0] - base[0], color[1] - base[1], color[2] - base[2]);
    const consistency = Math.exp(-(diff * diff) / (COLOR_CONSISTENCY_SIGMA * COLOR_CONSISTENCY_SIGMA));
    qualities[index] *= 0.35 + 0.65 * consistency;
  }
}

function writeQualityBlendStackComposite(composite: QualityBlendStackComposite, output: ImageData) {
  let writtenTexels = 0;
  const colors = Array.from({ length: TOP_K_BLEND_LAYERS }, () => [0, 0, 0]);
  const coverages = new Array<number>(TOP_K_BLEND_LAYERS).fill(0);
  const qualities = new Array<number>(TOP_K_BLEND_LAYERS).fill(0);

  for (let pixelIndex = 0, offset = 0; pixelIndex < composite.coverage.length; pixelIndex += 1, offset += 4) {
    if (!composite.coverage[pixelIndex]) continue;
    const colorOffset = pixelIndex * 3;
    let candidateCount = 0;
    for (let slot = 0; slot < TOP_K_BLEND_LAYERS; slot += 1) {
      coverages[slot] = composite.coverages[slot][pixelIndex];
      qualities[slot] = composite.qualities[slot][pixelIndex];
      if (coverages[slot] > COVERAGE_THRESHOLD) candidateCount += 1;
      colors[slot][0] = srgbByteToLinear(composite.colors[slot][colorOffset]);
      colors[slot][1] = srgbByteToLinear(composite.colors[slot][colorOffset + 1]);
      colors[slot][2] = srgbByteToLinear(composite.colors[slot][colorOffset + 2]);
    }

    if (candidateCount === 1) {
      output.data[offset] = composite.colors[0][colorOffset];
      output.data[offset + 1] = composite.colors[0][colorOffset + 1];
      output.data[offset + 2] = composite.colors[0][colorOffset + 2];
      output.data[offset + 3] = 255;
      writtenTexels += 1;
      continue;
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

    const final = [0, 0, 0];
    for (let slot = 0; slot < TOP_K_BLEND_LAYERS; slot += 1) {
      const quality = Math.max(0, qualities[slot]);
      const coverage = Math.max(0, coverages[slot]);
      if (coverage <= 0) continue;
      const strongWeight = quality ** BLEND_POWER / Math.max(sumStrong, 0.000001);
      const softWeight = coverage / sumSoft;
      const weight = strongWeight * (1 - RESIDUAL_MIX) + softWeight * RESIDUAL_MIX;
      final[0] += colors[slot][0] * weight;
      final[1] += colors[slot][1] * weight;
      final[2] += colors[slot][2] * weight;
    }

    output.data[offset] = linearToSrgbByte(final[0]);
    output.data[offset + 1] = linearToSrgbByte(final[1]);
    output.data[offset + 2] = linearToSrgbByte(final[2]);
    output.data[offset + 3] = 255;
    writtenTexels += 1;
  }
  return writtenTexels;
}

function applyOverlayRasters(base: ImageData, coverage: Uint8Array, overlays: OverlayRaster[]) {
  for (const { imageData, quality: qualityMap } of overlays) {
    for (let pixelIndex = 0, offset = 0; offset < imageData.data.length; pixelIndex += 1, offset += 4) {
      const layerCoverage = imageData.data[offset + 3] / 255;
      if (layerCoverage <= COVERAGE_THRESHOLD) continue;
      const qualityFade = smoothstep(0, 0.15, Math.max(qualityMap[pixelIndex], layerCoverage * 0.25));
      const alpha = Math.max(0, Math.min(1, layerCoverage * (0.75 + 0.25 * qualityFade)));
      if (alpha <= 0.0001) continue;

      const baseRed = srgbByteToLinear(base.data[offset]);
      const baseGreen = srgbByteToLinear(base.data[offset + 1]);
      const baseBlue = srgbByteToLinear(base.data[offset + 2]);
      const layerRed = srgbByteToLinear(imageData.data[offset]);
      const layerGreen = srgbByteToLinear(imageData.data[offset + 1]);
      const layerBlue = srgbByteToLinear(imageData.data[offset + 2]);

      base.data[offset] = linearToSrgbByte(baseRed * (1 - alpha) + layerRed * alpha);
      base.data[offset + 1] = linearToSrgbByte(baseGreen * (1 - alpha) + layerGreen * alpha);
      base.data[offset + 2] = linearToSrgbByte(baseBlue * (1 - alpha) + layerBlue * alpha);
      base.data[offset + 3] = 255;
      coverage[pixelIndex] = 1;
    }
  }
}

function downsampleCoverage(coverage: Uint8Array, sourceResolution: number, targetResolution: number) {
  const downsampled = new Uint8Array(targetResolution * targetResolution);
  for (let y = 0; y < sourceResolution; y += 1) {
    for (let x = 0; x < sourceResolution; x += 1) {
      if (!coverage[y * sourceResolution + x]) continue;
      const targetX = Math.min(targetResolution - 1, Math.floor((x / sourceResolution) * targetResolution));
      const targetY = Math.min(targetResolution - 1, Math.floor((y / sourceResolution) * targetResolution));
      downsampled[targetY * targetResolution + targetX] = 1;
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
  gpuCoverage: Uint8Array;
  gpuResolution: UvBakeResolution;
  enableBackfaceCulling: boolean;
}) {
  const referenceCoverage = new Uint8Array(GPU_COVERAGE_VALIDATION_RESOLUTION * GPU_COVERAGE_VALIDATION_RESOLUTION);

  for (const layer of input.layers) {
    const [projectedImage, maskImage, depthImage] = await Promise.all([
      loadImageData(layer.imageUrl, GPU_COVERAGE_VALIDATION_RESOLUTION),
      layer.maskUrl && !usesSourceAlphaMask(layer)
        ? loadImageData(layer.maskUrl, GPU_COVERAGE_VALIDATION_RESOLUTION)
        : Promise.resolve(undefined),
      layer.depthUrl && !usesSourceAlphaMask(layer)
        ? loadImageData(layer.depthUrl, GPU_COVERAGE_VALIDATION_RESOLUTION)
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
    for (let index = 0; index < rasterized.coverage.length; index += 1) {
      if (rasterized.coverage[index]) referenceCoverage[index] = 1;
    }
  }

  const gpuCoverage = downsampleCoverage(
    input.gpuCoverage,
    input.gpuResolution,
    GPU_COVERAGE_VALIDATION_RESOLUTION,
  );
  const comparison = compareCoverage(gpuCoverage, referenceCoverage);
  if (comparison.referenceCount === 0) return comparison;
  if (comparison.iou < MIN_GPU_CPU_COVERAGE_IOU || comparison.coverageRatio < MIN_GPU_CPU_COVERAGE_RATIO) {
    throw new Error(
      `GPU bake coverage diverged from CPU validation (IoU ${comparison.iou.toFixed(2)}, coverage ratio ${comparison.coverageRatio.toFixed(2)}).`,
    );
  }
  return comparison;
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
  const layers = requestedLayerIdSet
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

  if (layers.length === 0) throw new Error('No visible projected layers to bake.');
  input.onProgress?.({ phase: 'loading-assets', progress: 0.02, layerIndex: 0, layerCount: layers.length });

  const gpuFallbackWarnings: string[] = [];
  const renderer = useSceneStore.getState().viewport?.gl;
  if (input.method !== 'cpu' && renderer && input.outputAlpha !== 'transparent') {
    try {
      const gpuBake = await bakeProjectedLayerStackWithGpu({
        renderer,
        group: importedModel.group,
        layers,
        resolution: input.resolution,
        enableBackfaceCulling: input.enableBackfaceCulling,
        enableDilation: input.enableDilation,
        dilationPixels: input.dilationPixels,
        onProgress: (progress) =>
          input.onProgress?.({
            ...progress,
            progress: 0.04 + clampProgress(progress.progress) * 0.84,
          }),
      });
      const gpuContext = gpuBake.canvas.getContext('2d', { willReadFrequently: true });
      if (!gpuContext) throw new Error('Could not read GPU UV bake canvas.');
      await validateGpuBakeCoverage({
        group: importedModel.group,
        layers,
        objectId: input.objectId,
        gpuCoverage: gpuBake.coverage,
        gpuResolution: input.resolution,
        enableBackfaceCulling: input.enableBackfaceCulling,
      });
      input.onProgress?.({ phase: 'compositing', progress: 0.9, layerIndex: layers.length - 1, layerCount: layers.length });
      if (!gpuBake.postProcessedOnGpu || !gpuBake.opaqueBaseColorReady) {
        const gpuImage = gpuContext.getImageData(0, 0, input.resolution, input.resolution);
        if (!gpuBake.postProcessedOnGpu) {
          sharpenCoveredTexels(gpuImage, gpuBake.coverage);
        }
        if (!gpuBake.opaqueBaseColorReady) {
          fillTransparentTexelsForViewport(gpuImage);
        }
        gpuContext.putImageData(gpuImage, 0, 0);
      }
      input.onProgress?.({ phase: 'encoding', progress: 0.96, layerIndex: layers.length - 1, layerCount: layers.length });
      const { imageBlob, imageUrl } = await encodeBakeCanvas(gpuBake.canvas, input.preferBlobOutput);
      const coverageRatio = validateBakeCoverage(gpuBake.coveredPixels, input.resolution);
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

      return {
        bakedTexture,
        canvas: gpuBake.canvas,
        imageBlob,
        imageUrl,
        report,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      gpuFallbackWarnings.push(`GPU bake failed; used CPU fallback at the same resolution. ${message}`);
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
    const [projectedImage, maskImage, depthImage] = await Promise.all([
      loadImageData(layer.imageUrl, input.resolution),
      layer.maskUrl && !usesSourceAlphaMask(layer) ? loadImageData(layer.maskUrl, input.resolution) : Promise.resolve(undefined),
      layer.depthUrl && !usesSourceAlphaMask(layer) ? loadImageData(layer.depthUrl, input.resolution) : Promise.resolve(undefined),
    ]);
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
        enableDilation: input.enableDilation,
        dilationPixels: input.dilationPixels,
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
      accumulateQualityBlendLayer(qualityBlendComposite, layerImageData, rasterized.quality, layer.id);
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

  input.onProgress?.({ phase: 'compositing', progress: 0.9, layerIndex: layers.length - 1, layerCount: layers.length });
  const blendWrittenTexels = writeQualityBlendStackComposite(qualityBlendComposite, composite);
  applyOverlayRasters(composite, qualityBlendComposite.coverage, overlayRasters);
  let writtenTexels = 0;
  for (let index = 0; index < qualityBlendComposite.coverage.length; index += 1) {
    if (qualityBlendComposite.coverage[index]) writtenTexels += 1;
  }
  if (writtenTexels === 0) writtenTexels = blendWrittenTexels;
  if (input.enableDilation) {
    dilateImageData(composite, qualityBlendComposite.coverage, input.dilationPixels);
  }
  sharpenCoveredTexels(composite, qualityBlendComposite.coverage);
  if (input.outputAlpha !== 'transparent') {
    fillTransparentTexelsForViewport(composite);
  }
  context.putImageData(composite, 0, 0);
  input.onProgress?.({ phase: 'encoding', progress: 0.96, layerIndex: layers.length - 1, layerCount: layers.length });
  const { imageBlob, imageUrl } = await encodeBakeCanvas(canvas, input.preferBlobOutput);
  const coverageRatio = validateBakeCoverage(writtenTexels, input.resolution);
  const report = createBakeReport({
    startedAt,
    objectId: input.objectId,
    layerId: layers[0].id,
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
    sourceLayerId: layers[0].id,
    sourceLayerIds: layers.map((layer) => layer.id),
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

  return {
    bakedTexture,
    canvas,
    imageBlob,
    imageUrl,
    report,
  };
}
