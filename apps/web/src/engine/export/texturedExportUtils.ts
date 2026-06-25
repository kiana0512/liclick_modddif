import * as THREE from 'three';
import { bakeVisibleProjectedLayersToTexture } from '@/engine/bake/bakeProjectedLayerToTexture';
import { findExactLayerStackTexture, getVisibleProjectedLayerStack, canUseLayerStackCache } from '@/engine/bake/layerStackCache';
import { useLayerStore } from '@/stores/layerStore';
import { useSettingsStore } from '@/stores/settingsStore';
import type { BakedTexture, UvBakeResolution } from '@/engine/bake/uvBakeTypes';
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

export type PreparedTexturedExport = {
  root: THREE.Object3D;
  bakedTexture?: BakedTexture;
  texture?: THREE.Texture;
  textureBlob?: Blob;
  textureFilename?: string;
  averageColor?: [number, number, number];
};

async function blobFromUrl(url: string) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not read baked texture: ${response.statusText}`);
  return response.blob();
}

async function loadExportTexture(imageUrl: string) {
  const texture = await new THREE.TextureLoader().loadAsync(imageUrl);
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
  context.translate(0, canvas.height);
  context.scale(1, -1);
  context.drawImage(bitmap, 0, 0);
  context.setTransform(1, 0, 0, 1, 0, 0);
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

function findCurrentBakedTexture(input: ModelExportInput) {
  const visibleLayers = getVisibleProjectedLayerStack(useLayerStore.getState().layers, input.importedModel.objectId);
  const exactTexture = findExactLayerStackTexture(input.project, visibleLayers);
  if (canUseLayerStackCache(visibleLayers, exactTexture)) return exactTexture;
  return undefined;
}

async function bakeCurrentVisibleTextureForExport(input: ModelExportInput) {
  const visibleLayers = getVisibleProjectedLayerStack(useLayerStore.getState().layers, input.importedModel.objectId);
  if (visibleLayers.length === 0) return undefined;

  const resolution = exportResolutionToSize[useSettingsStore.getState().resolution] ?? 2048;
  const result = await bakeVisibleProjectedLayersToTexture({
    objectId: input.importedModel.objectId,
    resolution,
    enableBackfaceCulling: true,
    enableDilation: true,
    dilationPixels: 4,
    preferBlobOutput: true,
  });
  return result.bakedTexture;
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

  const bakedTexture = findCurrentBakedTexture(input) ?? await bakeCurrentVisibleTextureForExport(input);
  if (!bakedTexture?.imageUrl) return { root };

  const sourceBlob = await blobFromUrl(bakedTexture.imageUrl);
  const textureBlob = await makeTransparentBaseColorForExport(sourceBlob);
  const textureUrl = URL.createObjectURL(textureBlob);
  const texture = await loadExportTexture(textureUrl);
  URL.revokeObjectURL(textureUrl);
  const averageColor = await getAverageTextureColor(textureBlob);
  applyTextureMaterial(root, texture);

  return {
    root,
    bakedTexture,
    texture,
    textureBlob,
    textureFilename: `${slugifyExportName(input.project.name)}_basecolor_${bakedTexture.id.replace(/[^a-zA-Z0-9-]+/g, '-')}.png`,
    averageColor,
  };
}
