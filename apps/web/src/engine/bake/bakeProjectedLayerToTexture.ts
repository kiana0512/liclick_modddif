import { createBakeReport } from './bakeReport';
import { loadImageData } from './imageSampler';
import { rasterizeProjectedLayerToUv } from './uvRasterizer';
import type {
  BakeProjectedLayerInput,
  BakeProjectedLayerResult,
  BakeVisibleProjectedLayersInput,
  BakedTexture,
} from './uvBakeTypes';
import { useLayerStore } from '@/stores/layerStore';
import { useProjectStore } from '@/stores/projectStore';
import { useSceneStore } from '@/stores/sceneStore';
import { createId } from '@/utils/id';

const CLAY_TEXTURE_FILL: [number, number, number] = [244, 245, 242];

function fillTransparentTexelsForViewport(imageData: ImageData) {
  for (let offset = 0; offset < imageData.data.length; offset += 4) {
    if (imageData.data[offset + 3] !== 0) continue;
    imageData.data[offset] = CLAY_TEXTURE_FILL[0];
    imageData.data[offset + 1] = CLAY_TEXTURE_FILL[1];
    imageData.data[offset + 2] = CLAY_TEXTURE_FILL[2];
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

  const [projectedImage, maskImage, depthImage] = await Promise.all([
    loadImageData(layer.imageUrl),
    layer.maskUrl ? loadImageData(layer.maskUrl) : Promise.resolve(undefined),
    layer.depthUrl ? loadImageData(layer.depthUrl) : Promise.resolve(undefined),
  ]);
  const rasterized = await rasterizeProjectedLayerToUv({
    group: importedModel.group,
    layer,
    projectedImage,
    maskImage,
    depthImage,
    bakeInput: input,
  });
  const rasterContext = rasterized.canvas.getContext('2d', { willReadFrequently: true });
  if (!rasterContext) throw new Error('Could not read UV bake canvas.');
  const rasterImage = rasterContext.getImageData(0, 0, input.resolution, input.resolution);
  fillTransparentTexelsForViewport(rasterImage);
  rasterContext.putImageData(rasterImage, 0, 0);
  const imageUrl = rasterized.canvas.toDataURL('image/png');
  const coverageRatio = rasterized.coveredPixels / (input.resolution * input.resolution);
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
    imageUrl,
    report,
  };
}

function compositeCanvas(base: ImageData, layer: ImageData) {
  for (let offset = 0; offset < base.data.length; offset += 4) {
    const sourceAlpha = layer.data[offset + 3] / 255;
    if (sourceAlpha <= 0) continue;
    const targetAlpha = base.data[offset + 3] / 255;
    const outputAlpha = sourceAlpha + targetAlpha * (1 - sourceAlpha);
    if (outputAlpha <= 0) continue;
    base.data[offset] = Math.round(
      (layer.data[offset] * sourceAlpha + base.data[offset] * targetAlpha * (1 - sourceAlpha)) / outputAlpha,
    );
    base.data[offset + 1] = Math.round(
      (layer.data[offset + 1] * sourceAlpha + base.data[offset + 1] * targetAlpha * (1 - sourceAlpha)) / outputAlpha,
    );
    base.data[offset + 2] = Math.round(
      (layer.data[offset + 2] * sourceAlpha + base.data[offset + 2] * targetAlpha * (1 - sourceAlpha)) / outputAlpha,
    );
    base.data[offset + 3] = Math.round(outputAlpha * 255);
  }
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

  const layers = useLayerStore
    .getState()
    .layers.filter(
      (layer) =>
        layer.type === 'projected' &&
        layer.visible &&
        layer.imageUrl &&
        layer.camera &&
        (!layer.objectId || layer.objectId === input.objectId),
    )
    .sort((a, b) => b.order - a.order);

  if (layers.length === 0) throw new Error('No visible projected layers to bake.');

  const canvas = document.createElement('canvas');
  canvas.width = input.resolution;
  canvas.height = input.resolution;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('Could not create stacked UV bake canvas.');
  const composite = new ImageData(input.resolution, input.resolution);

  let totalTriangles = 0;
  let processedTriangles = 0;
  let coveredPixels = 0;
  let skippedPixels = 0;
  let inFrustumTexels = 0;
  let maskRejectedTexels = 0;
  let depthRejectedTexels = 0;
  let backfaceRejectedTexels = 0;
  const warnings: string[] = [];

  for (const layer of layers) {
    const [projectedImage, maskImage, depthImage] = await Promise.all([
      loadImageData(layer.imageUrl),
      layer.maskUrl ? loadImageData(layer.maskUrl) : Promise.resolve(undefined),
      layer.depthUrl ? loadImageData(layer.depthUrl) : Promise.resolve(undefined),
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
      },
    });
    const layerContext = rasterized.canvas.getContext('2d', { willReadFrequently: true });
    if (!layerContext) throw new Error('Could not read layer bake canvas.');
    compositeCanvas(composite, layerContext.getImageData(0, 0, input.resolution, input.resolution));
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

  let writtenTexels = 0;
  for (let offset = 3; offset < composite.data.length; offset += 4) {
    if (composite.data[offset] > 0) writtenTexels += 1;
  }
  fillTransparentTexelsForViewport(composite);
  context.putImageData(composite, 0, 0);
  const imageUrl = canvas.toDataURL('image/png');
  const coverageRatio = writtenTexels / (input.resolution * input.resolution);
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

  useProjectStore.getState().addBakedTexture(bakedTexture);
  for (const layer of layers) {
    useLayerStore.getState().markLayerBaked(layer.id, bakedTexture.id, bakedTexture.createdAt);
  }
  console.info('[Liclick 3D Texture] Stacked UV bake report:', report);

  return {
    bakedTexture,
    canvas,
    imageUrl,
    report,
  };
}
