import type { Material, Mesh, Object3D, Texture } from 'three';
import type { ModelLoadResult } from '@/engine/loaders/modelImportTypes';
import type { Project } from '@/types/project';
import { downloadBlob, getExportFilename } from './exportUtils';
import { makeTransparentBaseColorForExport } from './texturedExportUtils';

async function blobFromUrl(url: string) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not read texture: ${response.statusText}`);
  return response.blob();
}

function isCanvas(value: unknown): value is HTMLCanvasElement | OffscreenCanvas {
  return (
    value instanceof HTMLCanvasElement ||
    (typeof OffscreenCanvas !== 'undefined' && value instanceof OffscreenCanvas)
  );
}

function getTextureImage(texture: Texture) {
  return texture.image as HTMLImageElement | HTMLCanvasElement | OffscreenCanvas | ImageBitmap | undefined;
}

async function blobFromTexture(texture: Texture) {
  const image = getTextureImage(texture);
  if (!image) throw new Error('Normal texture has no image data.');
  if (image instanceof HTMLImageElement && image.src) return blobFromUrl(image.src);
  if (isCanvas(image)) {
    if (image instanceof HTMLCanvasElement) {
      return new Promise<Blob>((resolve, reject) => {
        image.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Could not encode texture canvas.'))), 'image/png');
      });
    }
    return image.convertToBlob({ type: 'image/png' });
  }
  if (typeof ImageBitmap !== 'undefined' && image instanceof ImageBitmap) {
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    canvas.getContext('2d')?.drawImage(image, 0, 0);
    return new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Could not encode texture bitmap.'))), 'image/png');
    });
  }
  throw new Error('Unsupported texture image type.');
}

function materialList(material: Material | Material[]) {
  return Array.isArray(material) ? material : [material];
}

export function findNormalMapTexture(model?: ModelLoadResult) {
  let normalMap: Texture | undefined;
  model?.group.traverse((object: Object3D) => {
    if (normalMap || !(object as Mesh).isMesh) return;
    const mesh = object as Mesh;
    for (const material of materialList(mesh.material)) {
      const candidate = (material as Material & { normalMap?: Texture }).normalMap;
      if (candidate) {
        normalMap = candidate;
        return;
      }
    }
  });
  return normalMap;
}

export async function exportTextureUrl(project: Project, imageUrl: string, suffix: string) {
  const blob = await blobFromUrl(imageUrl);
  const shouldExportBaseColor =
    suffix.toLowerCase().includes('color') || suffix.toLowerCase().includes('basecolor') || suffix.toLowerCase().includes('base-color');
  const outputBlob = shouldExportBaseColor ? await makeTransparentBaseColorForExport(blob) : blob;
  downloadBlob(outputBlob, getExportFilename(project.name, suffix, 'png'));
}

export async function exportNormalTexture(project: Project, texture: Texture) {
  const blob = await blobFromTexture(texture);
  downloadBlob(blob, getExportFilename(project.name, 'normal', 'png'));
}
