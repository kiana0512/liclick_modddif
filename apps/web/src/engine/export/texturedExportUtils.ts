import * as THREE from 'three';
import { bakeVisibleProjectedLayersToTexture } from '@/engine/bake/bakeProjectedLayerToTexture';
import { resolveImageAssetUrl } from '@/engine/bake/imageSampler';
import { getLiveProjectedCanvasState } from '@/engine/projection/liveProjectedCanvasTextureRegistry';
import { createProjectionMaskedImage } from '@/engine/projection/createMaskedProjectedImage';
import {
  findExactLayerStackTexture,
  getLayerStackBakeInFlight,
  getProjectedLayerStackSignature,
  getVisibleProjectedLayerStack,
  registerLayerStackBakeInFlight,
  canUseLayerStackCache,
} from '@/engine/bake/layerStackCache';
import {
  getVisibleUvLayerStack,
  isLocalRepaintUvOverlayLayer,
} from '@/engine/layers/uvLayerComposition';
import { useLayerStore } from '@/stores/layerStore';
import { useProjectStore } from '@/stores/projectStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { saveBlobAsset, saveDataUrlAsset } from '@/services/workspaceApiClient';
import { getRegisteredObjectUrlBlob } from '@/utils/blobUrlRegistry';
import type { BakedTexture, UvBakeResolution } from '@/engine/bake/uvBakeTypes';
import type { BakeProjectedLayerResult } from '@/engine/bake/uvBakeTypes';
import type { ModelExportInput } from './exportTypes';
import { getExportRoot, slugifyExportName } from './exportUtils';

export const EXPORT_BASECOLOR_MATERIAL_NAME = 'Liclick_BaseColor';
const LEGACY_BAKE_FILL: [number, number, number] = [244, 245, 242];
const exportResolutionToSize: Record<string, UvBakeResolution> = {
  '1K': 1024,
  '2K': 2048,
  '4K': 4096,
  '8K': 8192,
};
const EXPORT_BASECOLOR_CACHE_SCOPE = 'export-basecolor-v2';
type ExportTextureOutputAlpha = 'opaque-viewport' | 'transparent';

type TexturedModelExportOptions = {
  outputAlpha?: ExportTextureOutputAlpha;
};

export type PreparedTexturedExport = {
  root: THREE.Object3D;
  bakedTexture?: BakedTexture;
  texture?: THREE.Texture;
  textureBlob?: Blob;
  textureFilename?: string;
  averageColor?: [number, number, number];
};

function getTexturedExportObjectId(input: ModelExportInput) {
  return input.selectedObjectId && input.selectedObjectId === input.importedModel.objectId
    ? input.selectedObjectId
    : input.importedModel.objectId;
}

async function canvasToPngBlob(canvas: HTMLCanvasElement) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('Could not encode the in-memory export texture.'));
    }, 'image/png');
  });
}

export async function blobFromImageAssetUrl(url: string) {
  const liveCanvas = getLiveProjectedCanvasState(url)?.canvas;
  if (liveCanvas) return canvasToPngBlob(liveCanvas);

  const registeredBlob = getRegisteredObjectUrlBlob(url);
  if (registeredBlob) return registeredBlob;

  const resolvedUrl = resolveImageAssetUrl(url);
  let response: Response;
  try {
    response = await fetch(resolvedUrl);
  } catch (error) {
    throw new Error(
      `Could not read export texture (${url.startsWith('blob:') ? 'expired temporary image' : 'unavailable image asset'}).`,
      { cause: error },
    );
  }
  if (!response.ok) {
    throw new Error(`Could not read export texture: HTTP ${response.status}.`);
  }
  return response.blob();
}

const blobFromUrl = blobFromImageAssetUrl;

async function loadExportTexture(imageUrl: string) {
  const texture = await new THREE.TextureLoader().loadAsync(resolveImageAssetUrl(imageUrl));
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.flipY = false;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = 8;
  texture.needsUpdate = true;
  return texture;
}

function isExportBackgroundPixel(data: Uint8ClampedArray, offset: number) {
  const alpha = data[offset + 3];
  if (alpha < 250) return true;
  const red = data[offset];
  const green = data[offset + 1];
  const blue = data[offset + 2];
  const distanceToLegacyFill =
    Math.abs(red - LEGACY_BAKE_FILL[0]) + Math.abs(green - LEGACY_BAKE_FILL[1]) + Math.abs(blue - LEGACY_BAKE_FILL[2]);
  const nearWhite = red >= 220 && green >= 220 && blue >= 220 && Math.max(red, green, blue) - Math.min(red, green, blue) <= 26;
  return distanceToLegacyFill <= 72 || nearWhite;
}

async function encodeCanvasPng(canvas: HTMLCanvasElement) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('Could not encode export texture PNG.'));
    }, 'image/png');
  });
}

async function drawBlobToCanvas(context: CanvasRenderingContext2D, blob: Blob, width: number, height: number, opacity = 1) {
  const bitmap = await createImageBitmap(blob);
  context.save();
  context.globalAlpha = opacity;
  context.globalCompositeOperation = 'source-over';
  context.drawImage(bitmap, 0, 0, width, height);
  context.restore();
  bitmap.close();
}

function isRenderedColorUvLayer(layer: ReturnType<typeof findVisibleUvLayers>[number]) {
  return Boolean(
    isLocalRepaintUvOverlayLayer(layer) ||
    layer.renderedColor ||
    layer.id.startsWith('local-repaint-') ||
    layer.id.startsWith('content-aware-projected-repair') ||
    layer.generationId === 'texture-map-content-aware-repair' ||
    layer.imageUrl.includes('surface-edit:local-repaint'),
  );
}

function sampleCorrectionMap(
  correctionMap: Float32Array,
  probeWidth: number,
  probeHeight: number,
  x: number,
  y: number,
  width: number,
  height: number,
) {
  const probeX = width <= 1 ? 0 : (x / (width - 1)) * (probeWidth - 1);
  const probeY = height <= 1 ? 0 : (y / (height - 1)) * (probeHeight - 1);
  const x0 = Math.floor(probeX);
  const y0 = Math.floor(probeY);
  const x1 = Math.min(probeWidth - 1, x0 + 1);
  const y1 = Math.min(probeHeight - 1, y0 + 1);
  const tx = probeX - x0;
  const ty = probeY - y0;
  const top = THREE.MathUtils.lerp(
    correctionMap[y0 * probeWidth + x0],
    correctionMap[y0 * probeWidth + x1],
    tx,
  );
  const bottom = THREE.MathUtils.lerp(
    correctionMap[y1 * probeWidth + x0],
    correctionMap[y1 * probeWidth + x1],
    tx,
  );
  return THREE.MathUtils.lerp(top, bottom, ty);
}

function pixelLuminance(data: Uint8ClampedArray, offset: number) {
  return data[offset] * 0.2126 + data[offset + 1] * 0.7152 + data[offset + 2] * 0.0722;
}

async function drawRenderedColorLayerAsBaseColor(
  targetContext: CanvasRenderingContext2D,
  blob: Blob,
  width: number,
  height: number,
  opacity: number,
) {
  const bitmap = await createImageBitmap(blob);
  const sourceCanvas = document.createElement('canvas');
  sourceCanvas.width = width;
  sourceCanvas.height = height;
  const sourceContext = sourceCanvas.getContext('2d', { willReadFrequently: true });
  if (!sourceContext) {
    bitmap.close();
    await drawBlobToCanvas(targetContext, blob, width, height, opacity);
    return;
  }
  sourceContext.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  // Estimate only the low-frequency illumination difference. The generated
  // repaint is a viewport render, while the canvas below it is the albedo stack
  // that Blender will light. A small probe removes the baked light gradient
  // without blurring or replacing the high-frequency generated details.
  const probeWidth = Math.max(16, Math.min(96, Math.round(64 * (width / Math.max(height, 1)))));
  const probeHeight = Math.max(16, Math.min(96, Math.round(64 * (height / Math.max(width, 1)))));
  const sourceProbe = document.createElement('canvas');
  sourceProbe.width = probeWidth;
  sourceProbe.height = probeHeight;
  const sourceProbeContext = sourceProbe.getContext('2d', { willReadFrequently: true });
  const baseProbe = document.createElement('canvas');
  baseProbe.width = probeWidth;
  baseProbe.height = probeHeight;
  const baseProbeContext = baseProbe.getContext('2d', { willReadFrequently: true });
  if (!sourceProbeContext || !baseProbeContext) {
    targetContext.save();
    targetContext.globalAlpha = opacity;
    targetContext.drawImage(sourceCanvas, 0, 0);
    targetContext.restore();
    return;
  }
  sourceProbeContext.drawImage(sourceCanvas, 0, 0, probeWidth, probeHeight);
  baseProbeContext.drawImage(targetContext.canvas, 0, 0, probeWidth, probeHeight);
  const sourceProbeData = sourceProbeContext.getImageData(0, 0, probeWidth, probeHeight).data;
  const baseProbeData = baseProbeContext.getImageData(0, 0, probeWidth, probeHeight).data;

  const findProbeOffset = (probeX: number, probeY: number) => {
    const centerOffset = (probeY * probeWidth + probeX) * 4;
    if (sourceProbeData[centerOffset + 3] > 12) return centerOffset;
    for (let radius = 1; radius <= 3; radius += 1) {
      for (let dy = -radius; dy <= radius; dy += 1) {
        for (let dx = -radius; dx <= radius; dx += 1) {
          const x = Math.max(0, Math.min(probeWidth - 1, probeX + dx));
          const y = Math.max(0, Math.min(probeHeight - 1, probeY + dy));
          const offset = (y * probeWidth + x) * 4;
          if (sourceProbeData[offset + 3] > 12) return offset;
        }
      }
    }
    return undefined;
  };

  const correctionMap = new Float32Array(probeWidth * probeHeight);
  correctionMap.fill(1);
  for (let probeY = 0; probeY < probeHeight; probeY += 1) {
    for (let probeX = 0; probeX < probeWidth; probeX += 1) {
      const mapIndex = probeY * probeWidth + probeX;
      const probeOffset = findProbeOffset(probeX, probeY);
      if (probeOffset === undefined) continue;
      const renderedLuminance = pixelLuminance(sourceProbeData, probeOffset);
      const baseLuminance = pixelLuminance(baseProbeData, probeOffset);
      if (renderedLuminance <= 4 || baseLuminance <= 4) continue;
      const illuminationScale = THREE.MathUtils.clamp(
        baseLuminance / renderedLuminance,
        0.55,
        1.8,
      );
      correctionMap[mapIndex] = Math.pow(illuminationScale, 0.88);
    }
  }

  // Work in strips to keep 8K export memory bounded.
  const stripHeight = 256;
  for (let stripY = 0; stripY < height; stripY += stripHeight) {
    const currentHeight = Math.min(stripHeight, height - stripY);
    const imageData = sourceContext.getImageData(0, stripY, width, currentHeight);
    for (let localY = 0; localY < currentHeight; localY += 1) {
      const y = stripY + localY;
      for (let x = 0; x < width; x += 1) {
        const offset = (localY * width + x) * 4;
        if (imageData.data[offset + 3] <= 2) continue;
        // Leave a small part of the generated lighting intact so deliberately
        // painted highlights remain natural instead of becoming flat patches.
        // Bilinear sampling is important here: nearest-probe sampling showed up
        // as rectangular/grid cells after Blender lit the exported base color.
        const correction = sampleCorrectionMap(
          correctionMap,
          probeWidth,
          probeHeight,
          x,
          y,
          width,
          height,
        );
        imageData.data[offset] = Math.min(255, Math.round(imageData.data[offset] * correction));
        imageData.data[offset + 1] = Math.min(
          255,
          Math.round(imageData.data[offset + 1] * correction),
        );
        imageData.data[offset + 2] = Math.min(
          255,
          Math.round(imageData.data[offset + 2] * correction),
        );
      }
    }
    sourceContext.putImageData(imageData, 0, stripY);
  }

  targetContext.save();
  targetContext.globalAlpha = opacity;
  targetContext.globalCompositeOperation = 'source-over';
  targetContext.drawImage(sourceCanvas, 0, 0);
  targetContext.restore();
}

function findVisibleUvLayers(objectId: string) {
  return getVisibleUvLayerStack(useLayerStore.getState().layers, objectId, 'bottom-to-top');
}

function getExportMaterialBaseColor(root: THREE.Object3D): [number, number, number] {
  let result: [number, number, number] | undefined;
  root.traverse((child) => {
    if (result || !(child instanceof THREE.Mesh)) return;
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    for (const material of materials) {
      if (!('color' in material) || !(material.color instanceof THREE.Color)) continue;
      result = [
        Math.round(THREE.MathUtils.clamp(material.color.r, 0, 1) * 255),
        Math.round(THREE.MathUtils.clamp(material.color.g, 0, 1) * 255),
        Math.round(THREE.MathUtils.clamp(material.color.b, 0, 1) * 255),
      ];
      break;
    }
  });
  return result ?? [128, 128, 128];
}

async function flattenVisibleLayersToBaseColor(
  baseBlob: Blob | undefined,
  uvLayers: ReturnType<typeof findVisibleUvLayers>,
  fallbackColor: [number, number, number],
) {
  if (!baseBlob && uvLayers.length === 0) return undefined;
  // Export uses the same two-stage stack as the editor: first build the ordinary
  // projected/UV base, then source-over every local-repaint UV patch in authored
  // order. This prevents a repaint from being flattened into the base and then
  // applied a second time.
  const baseUvLayers = uvLayers.filter((layer) => !isLocalRepaintUvOverlayLayer(layer));
  const localRepaintUvLayers = uvLayers.filter((layer) => isLocalRepaintUvOverlayLayer(layer));
  const orderedUvLayers = [...baseUvLayers, ...localRepaintUvLayers];
  const layerBlobs = await Promise.all(
    orderedUvLayers.map((layer) => blobFromUrl(layer.imageUrl)),
  );
  const probeBlob = baseBlob ?? layerBlobs[0];
  if (!probeBlob) return undefined;
  const probeBitmap = await createImageBitmap(probeBlob);
  const width = Math.max(1, probeBitmap.width);
  const height = Math.max(1, probeBitmap.height);
  probeBitmap.close();

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return baseBlob;

  // FBX receives one self-contained Base Color texture. Start with the imported
  // material color so even a stack made only from sparse UV patches has no
  // transparent holes for Blender to reinterpret.
  context.fillStyle = `rgb(${fallbackColor[0]}, ${fallbackColor[1]}, ${fallbackColor[2]})`;
  context.fillRect(0, 0, width, height);
  if (baseBlob) await drawBlobToCanvas(context, baseBlob, width, height);
  for (let index = 0; index < orderedUvLayers.length; index += 1) {
    const layer = orderedUvLayers[index];
    const opacity = Math.max(0, Math.min(1, layer.opacity));
    if (isRenderedColorUvLayer(layer)) {
      await drawRenderedColorLayerAsBaseColor(context, layerBlobs[index], width, height, opacity);
    } else {
      await drawBlobToCanvas(context, layerBlobs[index], width, height, opacity);
    }
  }
  // The canvas started opaque, and source-over compositing preserves that alpha.
  // Avoid a full-canvas readback here so 8K exports do not allocate another
  // quarter-gigabyte ImageData merely to rewrite alpha bytes to 255.
  return encodeCanvasPng(canvas);
}

export async function makeTransparentBaseColorForExport(blob: Blob) {
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) {
    bitmap.close();
    return blob;
  }
  context.drawImage(bitmap, 0, 0);
  bitmap.close();

  const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
  const { data } = imageData;
  for (let offset = 0; offset < data.length; offset += 4) {
    if (isExportBackgroundPixel(data, offset)) {
      data[offset] = 0;
      data[offset + 1] = 0;
      data[offset + 2] = 0;
      data[offset + 3] = 0;
    } else {
      data[offset + 3] = 255;
    }
  }

  context.putImageData(imageData, 0, 0);
  return encodeCanvasPng(canvas);
}

async function getAverageTextureColor(blob: Blob): Promise<[number, number, number]> {
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  const sampleSize = 64;
  canvas.width = sampleSize;
  canvas.height = sampleSize;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return [1, 1, 1];
  context.drawImage(bitmap, 0, 0, sampleSize, sampleSize);
  bitmap.close();
  const imageData = context.getImageData(0, 0, sampleSize, sampleSize);
  let r = 0;
  let g = 0;
  let b = 0;
  let weight = 0;
  for (let offset = 0; offset < imageData.data.length; offset += 4) {
    const alpha = imageData.data[offset + 3] / 255;
    if (alpha <= 0.02) continue;
    r += (imageData.data[offset] / 255) * alpha;
    g += (imageData.data[offset + 1] / 255) * alpha;
    b += (imageData.data[offset + 2] / 255) * alpha;
    weight += alpha;
  }
  if (weight <= 0) return [1, 1, 1];
  return [r / weight, g / weight, b / weight];
}

function getLatestProject(input: ModelExportInput) {
  return useProjectStore.getState().getCurrentProject() ?? input.project;
}

function getLayerStackCacheKey(
  input: ModelExportInput,
  objectId: string,
  resolution: number,
  visibleLayers: LayerStackLayers,
  options: TexturedModelExportOptions = {},
) {
  const project = getLatestProject(input);
  const outputAlpha = options.outputAlpha ?? 'opaque-viewport';
  return getProjectedLayerStackSignature(project.id, objectId, `${EXPORT_BASECOLOR_CACHE_SCOPE}:${resolution}`, visibleLayers, {
    outputAlpha,
    enableDilation: true,
    dilationPixels: 4,
  });
}

type LayerStackLayers = ReturnType<typeof getVisibleProjectedLayerStack>;

function isLocalRepaintProjectionLayer(layer: LayerStackLayers[number]) {
  return (
    layer.id.startsWith('local-repaint-projection') ||
    layer.id.startsWith('local-repaint-brush-projection')
  );
}

async function prepareProjectedLayersForExport(layers: LayerStackLayers) {
  // Match the proven "merge projected layers to UV" path. Local repaint masks
  // can be backed by live canvases and contain soft coverage. Flatten that mask
  // into the source image alpha before rasterization instead of sampling two
  // textures independently in the export bake; the latter exposed tiny rejected
  // texels as the stripe-shaped speckles visible in Blender.
  return Promise.all(
    layers.map(async (layer) =>
      isLocalRepaintProjectionLayer(layer) && layer.maskUrl
        ? {
            ...layer,
            imageUrl: await createProjectionMaskedImage(layer.imageUrl, layer.maskUrl),
            maskUrl: undefined,
          }
        : layer,
    ),
  );
}

function findCurrentBakedTexture(
  input: ModelExportInput,
  objectId: string,
  expectedResolution?: number,
  options: TexturedModelExportOptions = {},
) {
  const project = getLatestProject(input);
  const visibleLayers = getVisibleProjectedLayerStack(useLayerStore.getState().layers, objectId);
  const cacheKey =
    expectedResolution === undefined
      ? undefined
      : getLayerStackCacheKey(input, objectId, expectedResolution, visibleLayers, options);
  const exactTexture = findExactLayerStackTexture(project, visibleLayers, expectedResolution, objectId, cacheKey);
  if (canUseLayerStackCache(visibleLayers, exactTexture, expectedResolution, objectId, cacheKey)) return exactTexture;
  return undefined;
}

async function blobFromBakeResult(result: BakeProjectedLayerResult) {
  if (result.imageBlob) return result.imageBlob;
  if (result.imageUrl.startsWith('blob:')) return fetch(result.imageUrl).then((response) => response.blob());
  return undefined;
}

async function commitExportBakedTexture(input: ModelExportInput, result: BakeProjectedLayerResult) {
  const project = getLatestProject(input);
  let imageUrl = result.imageUrl;
  if (project.workspaceMode === 'local-server') {
    const filename = `${result.bakedTexture.id}.png`;
    const blob = await blobFromBakeResult(result);
    if (blob) {
      imageUrl = (await saveBlobAsset({ projectId: project.id, category: 'baked', blob, filename })).asset.relativePath;
    } else if (result.imageUrl.startsWith('data:')) {
      imageUrl = (
        await saveDataUrlAsset({
          projectId: project.id,
          category: 'baked',
          dataUrl: result.imageUrl,
          filename,
        })
      ).asset.relativePath;
    }
  }
  const bakedTexture = { ...result.bakedTexture, imageUrl };
  useProjectStore.getState().addBakedTexture(bakedTexture);
  useLayerStore.getState().markLayersBaked(
    bakedTexture.sourceLayerIds ?? [bakedTexture.sourceLayerId],
    bakedTexture.id,
    bakedTexture.createdAt,
  );
  return bakedTexture;
}

async function bakeCurrentVisibleTextureForExport(
  input: ModelExportInput,
  objectId: string,
  options: TexturedModelExportOptions = {},
) {
  const visibleLayers = getVisibleProjectedLayerStack(useLayerStore.getState().layers, objectId);
  if (visibleLayers.length === 0) return undefined;

  const resolution = exportResolutionToSize[useSettingsStore.getState().resolution] ?? 2048;
  const outputAlpha = options.outputAlpha ?? 'opaque-viewport';
  const cachedTexture = findCurrentBakedTexture(input, objectId, resolution, options);
  if (cachedTexture) return cachedTexture;

  const stackSignature = getLayerStackCacheKey(input, objectId, resolution, visibleLayers, options);
  const inFlightBake = getLayerStackBakeInFlight(stackSignature);
  if (inFlightBake) {
    const bakedTexture = await inFlightBake;
    const latestVisibleLayers = getVisibleProjectedLayerStack(useLayerStore.getState().layers, objectId);
    if (bakedTexture && canUseLayerStackCache(latestVisibleLayers, bakedTexture, resolution, objectId, stackSignature)) return bakedTexture;
  }

  const bakePromise = prepareProjectedLayersForExport(visibleLayers)
    .then((exportLayers) =>
      bakeVisibleProjectedLayersToTexture({
        objectId,
        transientLayers: exportLayers,
        resolution,
        cacheKey: stackSignature,
        enableBackfaceCulling: true,
        enableDilation: true,
        dilationPixels: 4,
        outputAlpha,
        preferBlobOutput: true,
        commitToProject: false,
        markSourceLayersBaked: false,
        onProgress: input.onProgress,
      }),
    )
    .then((result) => commitExportBakedTexture(input, result));
  return registerLayerStackBakeInFlight(stackSignature, bakePromise);
}

function makeBaseColorMaterial(texture: THREE.Texture) {
  const material = new THREE.MeshStandardMaterial({
    name: EXPORT_BASECOLOR_MATERIAL_NAME,
    color: new THREE.Color(1, 1, 1),
    map: texture,
    roughness: 0.68,
    metalness: 0,
  });
  material.needsUpdate = true;
  return material;
}

function applyTextureMaterial(root: THREE.Object3D, texture: THREE.Texture) {
  root.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    child.material = makeBaseColorMaterial(texture);
    child.castShadow = false;
    child.receiveShadow = false;
  });
}

export async function prepareTexturedModelExport(
  input: ModelExportInput,
  options: TexturedModelExportOptions = {},
): Promise<PreparedTexturedExport> {
  const root = getExportRoot(input).clone(true);
  root.updateMatrixWorld(true);

  const resolution = exportResolutionToSize[useSettingsStore.getState().resolution] ?? 2048;
  const objectId = getTexturedExportObjectId(input);
  const bakedTexture =
    findCurrentBakedTexture(input, objectId, resolution, options) ??
    await bakeCurrentVisibleTextureForExport(input, objectId, options);
  const uvLayers = findVisibleUvLayers(objectId);
  if (!bakedTexture?.imageUrl && uvLayers.length === 0) return { root };

  const textureBaseBlob = bakedTexture?.imageUrl ? await blobFromUrl(bakedTexture.imageUrl) : undefined;
  const textureBlob = await flattenVisibleLayersToBaseColor(
    textureBaseBlob,
    uvLayers,
    getExportMaterialBaseColor(root),
  );
  if (!textureBlob) return { root };
  const textureUrl = URL.createObjectURL(textureBlob);
  const texture = await loadExportTexture(textureUrl);
  URL.revokeObjectURL(textureUrl);
  const averageColor = await getAverageTextureColor(textureBlob);
  applyTextureMaterial(root, texture);
  const textureId =
    [bakedTexture?.id, ...uvLayers.map((layer) => layer.id)].filter(Boolean).join('-') ||
    'flattened-basecolor';

  return {
    root,
    bakedTexture,
    texture,
    textureBlob,
    textureFilename: `${slugifyExportName(input.project.name)}_basecolor_${textureId.replace(/[^a-zA-Z0-9-]+/g, '-')}.png`,
    averageColor,
  };
}
