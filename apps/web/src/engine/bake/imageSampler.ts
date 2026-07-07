import { getWorkspaceApiBase } from '@/services/workspaceApiBase';
import { useProjectStore } from '@/stores/projectStore';

export type ImageSample = [number, number, number, number];
const COLOR_ALPHA_REJECT_THRESHOLD = 3;
const MAX_CACHED_IMAGE_DATA_BYTES = 192 * 1024 * 1024;
const workspaceApiBase = getWorkspaceApiBase(import.meta.env.VITE_LICLICK_WORKSPACE_API);
const imageDataCache = new Map<string, { imageData: ImageData; bytes: number; usedAt: number }>();
let cachedImageDataBytes = 0;

function getWorkspaceProjectAssetBase() {
  const project = useProjectStore.getState().getCurrentProject();
  const workspaceName = project?.workspaceName;
  if (!project || !workspaceName) return undefined;
  const urls: Array<string | undefined> = [
    project.thumbnail,
    ...project.objects.map((object) => object.sourcePath),
    ...project.references.map((reference) => reference.url),
    ...project.captures.flatMap((capture) => [capture.colorUrl, capture.maskUrl, capture.depthUrl, capture.normalUrl]),
    ...project.generations.map((generation) => generation.resultUrl),
    ...project.layers.flatMap((layer) => [layer.imageUrl, layer.maskUrl, layer.depthUrl]),
    ...project.bakedTextures.map((texture) => texture.imageUrl),
  ];
  for (const value of urls) {
    if (!value) continue;
    try {
      const url = new URL(value, window.location.href);
      const marker = `/workspace/users/`;
      const projectMarker = `/projects/${workspaceName}/`;
      const markerIndex = url.pathname.indexOf(marker);
      const projectIndex = url.pathname.indexOf(projectMarker);
      if (markerIndex < 0 || projectIndex < 0) continue;
      return `${url.origin}${url.pathname.slice(0, projectIndex + projectMarker.length)}`;
    } catch {
      // Keep scanning; many layer URLs are data/blob URLs.
    }
  }
  return undefined;
}

export function resolveImageAssetUrl(url: string) {
  const trimmed = url.trim();
  if (!trimmed) return trimmed;
  if (/^(data:|blob:|https?:)/i.test(trimmed)) return trimmed;
  if (trimmed.startsWith('/workspace/')) return `${workspaceApiBase}${trimmed}`;
  if (trimmed.startsWith('workspace/')) return `${workspaceApiBase}/${trimmed}`;
  if (trimmed.startsWith('users/')) return `${workspaceApiBase}/workspace/${trimmed}`;
  if (trimmed.startsWith('assets/')) {
    const projectAssetBase = getWorkspaceProjectAssetBase();
    if (projectAssetBase) return `${projectAssetBase}${trimmed}`;
  }
  return trimmed;
}

function getImageDataCacheKey(url: string, resolvedUrl: string, maxDimension: number) {
  return `${url}\n${resolvedUrl}\n${Number.isFinite(maxDimension) ? maxDimension : 'full'}`;
}

function rememberImageData(cacheKey: string, imageData: ImageData) {
  const bytes = imageData.data.byteLength;
  if (bytes > MAX_CACHED_IMAGE_DATA_BYTES / 2) return;
  const existing = imageDataCache.get(cacheKey);
  if (existing) {
    cachedImageDataBytes -= existing.bytes;
    imageDataCache.delete(cacheKey);
  }
  imageDataCache.set(cacheKey, { imageData, bytes, usedAt: performance.now() });
  cachedImageDataBytes += bytes;

  while (cachedImageDataBytes > MAX_CACHED_IMAGE_DATA_BYTES) {
    let oldestKey: string | undefined;
    let oldestUsedAt = Number.POSITIVE_INFINITY;
    for (const [key, entry] of imageDataCache) {
      if (entry.usedAt < oldestUsedAt) {
        oldestUsedAt = entry.usedAt;
        oldestKey = key;
      }
    }
    if (!oldestKey) break;
    const oldest = imageDataCache.get(oldestKey);
    if (oldest) cachedImageDataBytes -= oldest.bytes;
    imageDataCache.delete(oldestKey);
  }
}

function describeUrlKind(url: string) {
  if (!url) return 'empty URL';
  if (url.startsWith('blob:')) return 'temporary blob URL';
  if (url.startsWith('data:')) return 'embedded data URL';
  if (url.startsWith('http')) return 'HTTP URL';
  if (url.startsWith('/workspace/') || url.startsWith('workspace/') || url.startsWith('users/') || url.startsWith('assets/')) {
    return 'workspace asset URL';
  }
  return 'relative URL';
}

export async function loadImageData(
  url: string,
  maxDimension = Number.POSITIVE_INFINITY,
  label = 'projected layer image',
): Promise<ImageData> {
  const resolvedUrl = resolveImageAssetUrl(url);
  if (!resolvedUrl) throw new Error(`Could not load ${label}: image URL is empty.`);
  const cacheKey = getImageDataCacheKey(url, resolvedUrl, maxDimension);
  const cached = imageDataCache.get(cacheKey);
  if (cached) {
    cached.usedAt = performance.now();
    return cached.imageData;
  }
  const image = new Image();
  image.crossOrigin = 'anonymous';
  image.decoding = 'async';
  image.src = resolvedUrl;

  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () =>
      reject(
        new Error(
          `Could not load ${label} for baking (${describeUrlKind(url)}). ` +
            (url.startsWith('blob:')
              ? 'The temporary blob URL is no longer available; regenerate or re-add this layer.'
              : 'Check that the workspace asset exists and the workspace server is running.'),
        ),
      );
  });

  const sourceWidth = image.naturalWidth || image.width;
  const sourceHeight = image.naturalHeight || image.height;
  const scale = Math.min(1, maxDimension / Math.max(sourceWidth, sourceHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(sourceWidth * scale));
  canvas.height = Math.max(1, Math.round(sourceHeight * scale));
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('Could not create image sampling canvas.');
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
  rememberImageData(cacheKey, imageData);
  return imageData;
}

export function sampleImageNearest(image: ImageData, u: number, v: number): ImageSample {
  const clampedU = Math.min(1, Math.max(0, u));
  const clampedV = Math.min(1, Math.max(0, v));
  const x = Math.min(image.width - 1, Math.max(0, Math.round(clampedU * (image.width - 1))));
  const y = Math.min(image.height - 1, Math.max(0, Math.round(clampedV * (image.height - 1))));
  const offset = (y * image.width + x) * 4;
  return [
    image.data[offset],
    image.data[offset + 1],
    image.data[offset + 2],
    image.data[offset + 3],
  ];
}

function getPixel(image: ImageData, x: number, y: number): ImageSample {
  const offset = (y * image.width + x) * 4;
  return [
    image.data[offset],
    image.data[offset + 1],
    image.data[offset + 2],
    image.data[offset + 3],
  ];
}

export function sampleImageBilinear(image: ImageData, u: number, v: number): ImageSample {
  const clampedU = Math.min(1, Math.max(0, u));
  const clampedV = Math.min(1, Math.max(0, v));
  const sourceX = clampedU * (image.width - 1);
  const sourceY = clampedV * (image.height - 1);
  const x0 = Math.max(0, Math.min(image.width - 1, Math.floor(sourceX)));
  const y0 = Math.max(0, Math.min(image.height - 1, Math.floor(sourceY)));
  const x1 = Math.max(0, Math.min(image.width - 1, x0 + 1));
  const y1 = Math.max(0, Math.min(image.height - 1, y0 + 1));
  const tx = sourceX - x0;
  const ty = sourceY - y0;
  const data = image.data;
  const offset00 = (y0 * image.width + x0) * 4;
  const offset10 = (y0 * image.width + x1) * 4;
  const offset01 = (y1 * image.width + x0) * 4;
  const offset11 = (y1 * image.width + x1) * 4;
  const weight00 = (1 - tx) * (1 - ty);
  const weight10 = tx * (1 - ty);
  const weight01 = (1 - tx) * ty;
  const weight11 = tx * ty;
  const alpha00 = (data[offset00 + 3] / 255) * weight00;
  const alpha10 = (data[offset10 + 3] / 255) * weight10;
  const alpha01 = (data[offset01 + 3] / 255) * weight01;
  const alpha11 = (data[offset11 + 3] / 255) * weight11;
  let red = 0;
  let green = 0;
  let blue = 0;
  const alpha = alpha00 + alpha10 + alpha01 + alpha11;

  if (alpha <= 0.00001) return [0, 0, 0, 0];

  red += data[offset00] * alpha00 + data[offset10] * alpha10 + data[offset01] * alpha01 + data[offset11] * alpha11;
  green += data[offset00 + 1] * alpha00 + data[offset10 + 1] * alpha10 + data[offset01 + 1] * alpha01 + data[offset11 + 1] * alpha11;
  blue += data[offset00 + 2] * alpha00 + data[offset10 + 2] * alpha10 + data[offset01 + 2] * alpha01 + data[offset11 + 2] * alpha11;

  return [
    Math.round(red / alpha),
    Math.round(green / alpha),
    Math.round(blue / alpha),
    Math.round(alpha * 255),
  ];
}

export function sampleImageBilinearCleanColor(image: ImageData, u: number, v: number): ImageSample {
  const clampedU = Math.min(1, Math.max(0, u));
  const clampedV = Math.min(1, Math.max(0, v));
  const sourceX = clampedU * (image.width - 1);
  const sourceY = clampedV * (image.height - 1);
  const x0 = Math.max(0, Math.min(image.width - 1, Math.floor(sourceX)));
  const y0 = Math.max(0, Math.min(image.height - 1, Math.floor(sourceY)));
  const x1 = Math.max(0, Math.min(image.width - 1, x0 + 1));
  const y1 = Math.max(0, Math.min(image.height - 1, y0 + 1));
  const tx = sourceX - x0;
  const ty = sourceY - y0;
  const data = image.data;
  const offset00 = (y0 * image.width + x0) * 4;
  const offset10 = (y0 * image.width + x1) * 4;
  const offset01 = (y1 * image.width + x0) * 4;
  const offset11 = (y1 * image.width + x1) * 4;
  const weight00 = (1 - tx) * (1 - ty);
  const weight10 = tx * (1 - ty);
  const weight01 = (1 - tx) * ty;
  const weight11 = tx * ty;
  let red = 0;
  let green = 0;
  let blue = 0;
  let totalWeight = 0;
  let maxAlpha = 0;

  if (weight00 > 0 && data[offset00 + 3] >= COLOR_ALPHA_REJECT_THRESHOLD) {
    red += data[offset00] * weight00;
    green += data[offset00 + 1] * weight00;
    blue += data[offset00 + 2] * weight00;
    totalWeight += weight00;
    maxAlpha = Math.max(maxAlpha, data[offset00 + 3]);
  }
  if (weight10 > 0 && data[offset10 + 3] >= COLOR_ALPHA_REJECT_THRESHOLD) {
    red += data[offset10] * weight10;
    green += data[offset10 + 1] * weight10;
    blue += data[offset10 + 2] * weight10;
    totalWeight += weight10;
    maxAlpha = Math.max(maxAlpha, data[offset10 + 3]);
  }
  if (weight01 > 0 && data[offset01 + 3] >= COLOR_ALPHA_REJECT_THRESHOLD) {
    red += data[offset01] * weight01;
    green += data[offset01 + 1] * weight01;
    blue += data[offset01 + 2] * weight01;
    totalWeight += weight01;
    maxAlpha = Math.max(maxAlpha, data[offset01 + 3]);
  }
  if (weight11 > 0 && data[offset11 + 3] >= COLOR_ALPHA_REJECT_THRESHOLD) {
    red += data[offset11] * weight11;
    green += data[offset11 + 1] * weight11;
    blue += data[offset11 + 2] * weight11;
    totalWeight += weight11;
    maxAlpha = Math.max(maxAlpha, data[offset11 + 3]);
  }

  if (totalWeight <= 0.00001) return [0, 0, 0, 0];
  return [
    Math.round(red / totalWeight),
    Math.round(green / totalWeight),
    Math.round(blue / totalWeight),
    maxAlpha,
  ];
}
