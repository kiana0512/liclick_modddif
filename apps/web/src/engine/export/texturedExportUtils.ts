import * as THREE from 'three';
import { bakeVisibleProjectedLayersToTexture } from '@/engine/bake/bakeProjectedLayerToTexture';
import { resolveImageAssetUrl } from '@/engine/bake/imageSampler';
import {
  findExactLayerStackTexture,
  getLayerStackBakeInFlight,
  getProjectedLayerStackSignature,
  getVisibleProjectedLayerStack,
  registerLayerStackBakeInFlight,
  canUseLayerStackCache,
} from '@/engine/bake/layerStackCache';
import { useLayerStore } from '@/stores/layerStore';
import { useProjectStore } from '@/stores/projectStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { saveBlobAsset, saveDataUrlAsset } from '@/services/workspaceApiClient';
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
const EXPORT_TRANSPARENT_UV_CACHE_SCOPE = 'export-transparent-uv-v3';

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

async function blobFromUrl(url: string) {
  const response = await fetch(resolveImageAssetUrl(url));
  if (!response.ok) throw new Error(`Could not read baked texture: ${response.statusText}`);
  return response.blob();
}

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

function findVisibleUvLayers(objectId: string) {
  return useLayerStore
    .getState()
    .layers.filter(
      (layer) =>
        layer.type === 'uv' &&
        layer.visible &&
        layer.imageUrl &&
        (!layer.objectId || layer.objectId === objectId),
    )
    .sort((a, b) => b.order - a.order);
}

async function composeUvLayersOverBase(baseBlob: Blob | undefined, uvLayers: ReturnType<typeof findVisibleUvLayers>) {
  if (!baseBlob && uvLayers.length === 0) return undefined;
  const layerBlobs = await Promise.all(uvLayers.map((layer) => blobFromUrl(layer.imageUrl)));
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

  context.clearRect(0, 0, width, height);
  if (baseBlob) await drawBlobToCanvas(context, baseBlob, width, height);
  for (let index = 0; index < uvLayers.length; index += 1) {
    await drawBlobToCanvas(context, layerBlobs[index], width, height, Math.max(0, Math.min(1, uvLayers[index].opacity)));
  }
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

function getLayerStackCacheKey(input: ModelExportInput, objectId: string, resolution: number, visibleLayers: LayerStackLayers) {
  const project = getLatestProject(input);
  return getProjectedLayerStackSignature(project.id, objectId, `${EXPORT_TRANSPARENT_UV_CACHE_SCOPE}:${resolution}`, visibleLayers);
}

type LayerStackLayers = ReturnType<typeof getVisibleProjectedLayerStack>;

function findCurrentBakedTexture(input: ModelExportInput, objectId: string, expectedResolution?: number) {
  const project = getLatestProject(input);
  const visibleLayers = getVisibleProjectedLayerStack(useLayerStore.getState().layers, objectId);
  const cacheKey = expectedResolution === undefined ? undefined : getLayerStackCacheKey(input, objectId, expectedResolution, visibleLayers);
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

async function bakeCurrentVisibleTextureForExport(input: ModelExportInput, objectId: string) {
  const visibleLayers = getVisibleProjectedLayerStack(useLayerStore.getState().layers, objectId);
  if (visibleLayers.length === 0) return undefined;

  const resolution = exportResolutionToSize[useSettingsStore.getState().resolution] ?? 2048;
  const cachedTexture = findCurrentBakedTexture(input, objectId, resolution);
  if (cachedTexture) return cachedTexture;

  const stackSignature = getLayerStackCacheKey(input, objectId, resolution, visibleLayers);
  const inFlightBake = getLayerStackBakeInFlight(stackSignature);
  if (inFlightBake) {
    const bakedTexture = await inFlightBake;
    const latestVisibleLayers = getVisibleProjectedLayerStack(useLayerStore.getState().layers, objectId);
    if (bakedTexture && canUseLayerStackCache(latestVisibleLayers, bakedTexture, resolution, objectId, stackSignature)) return bakedTexture;
  }

  const bakePromise = bakeVisibleProjectedLayersToTexture({
    objectId,
    resolution,
    cacheKey: stackSignature,
    enableBackfaceCulling: true,
    enableDilation: true,
    dilationPixels: 4,
    outputAlpha: 'transparent',
    preferBlobOutput: true,
    commitToProject: false,
    markSourceLayersBaked: false,
    onProgress: input.onProgress,
  }).then((result) => commitExportBakedTexture(input, result));
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

export async function prepareTexturedModelExport(input: ModelExportInput): Promise<PreparedTexturedExport> {
  const root = getExportRoot(input).clone(true);
  root.updateMatrixWorld(true);

  const resolution = exportResolutionToSize[useSettingsStore.getState().resolution] ?? 2048;
  const objectId = getTexturedExportObjectId(input);
  const bakedTexture = findCurrentBakedTexture(input, objectId, resolution) ?? await bakeCurrentVisibleTextureForExport(input, objectId);
  const uvLayers = findVisibleUvLayers(objectId);
  if (!bakedTexture?.imageUrl && uvLayers.length === 0) return { root };

  const textureBaseBlob = bakedTexture?.imageUrl ? await blobFromUrl(bakedTexture.imageUrl) : undefined;
  const textureBlob = await composeUvLayersOverBase(textureBaseBlob, uvLayers);
  if (!textureBlob) return { root };
  const textureUrl = URL.createObjectURL(textureBlob);
  const texture = await loadExportTexture(textureUrl);
  URL.revokeObjectURL(textureUrl);
  const averageColor = await getAverageTextureColor(textureBlob);
  applyTextureMaterial(root, texture);
  const textureId = bakedTexture?.id ?? (uvLayers.map((layer) => layer.id).join('-') || 'uv-stack');

  return {
    root,
    bakedTexture,
    texture,
    textureBlob,
    textureFilename: `${slugifyExportName(input.project.name)}_basecolor_${textureId.replace(/[^a-zA-Z0-9-]+/g, '-')}.png`,
    averageColor,
  };
}
