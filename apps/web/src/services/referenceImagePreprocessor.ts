import type { ReferenceImage } from '@/types/project';

// Atlas receives call-tool files as Base64 inside a JSON-RPC body. The observed
// gateway boundary is 4 MiB, so keep 512 KiB for the JSON-RPC envelope and
// headers added by the Atlas CLI.
export const ATLAS_REFERENCE_REQUEST_LIMIT_BYTES = 4 * 1024 * 1024;
export const ATLAS_REFERENCE_PAYLOAD_RESERVE_BYTES = 512 * 1024;
export const ATLAS_REFERENCE_SAFE_DATA_URL_LENGTH =
  ATLAS_REFERENCE_REQUEST_LIMIT_BYTES - ATLAS_REFERENCE_PAYLOAD_RESERVE_BYTES;

// Keep 4K detail whenever the byte budget permits. A small encoded WebP does
// not by itself mean low quality: simple renders and transparent backgrounds
// can compress very efficiently even at full resolution and quality 1.0.
const maxReferenceDimension = 4096;
const preferredQualitySteps = [1, 0.98, 0.95, 0.92, 0.88, 0.84] as const;
const fallbackQualitySteps = [0.78, 0.7, 0.62] as const;
const scaleSteps = [1, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4] as const;
const maxCacheEntries = 16;

export type ReferencePreprocessingResult = {
  id: string;
  name: string;
  originalBytes: number;
  processedBytes: number;
  originalWidth: number;
  originalHeight: number;
  processedWidth: number;
  processedHeight: number;
  outputType: string;
  outputQuality: number;
};

export type PreparedReference = {
  id: string;
  name: string;
  url: string;
  preprocessing?: ReferencePreprocessingResult;
};

type CacheEntry = {
  sourceUrl: string;
  promise: Promise<PreparedReference>;
};

const preparationCache = new Map<string, CacheEntry>();

function blobToDataUrl(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('无法读取参考图。'));
    reader.readAsDataURL(blob);
  });
}

async function referenceUrlToBlob(url: string) {
  let response: Response;
  try {
    response = await fetch(url, { credentials: 'omit' });
  } catch {
    throw new Error('无法读取参考图，请确认图片仍然存在后重试。');
  }
  if (!response.ok) throw new Error('无法读取参考图，请重新导入后重试。');
  return response.blob();
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality: number) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new Error('浏览器无法压缩这张参考图。'));
      },
      type,
      quality,
    );
  });
}

async function compressReference(
  reference: ReferenceImage,
  sourceBlob: Blob,
): Promise<PreparedReference> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(sourceBlob);
  } catch {
    throw new Error('参考图格式无法识别，请转换为 JPG、PNG 或 WebP 后重试。');
  }

  try {
    const longestSide = Math.max(bitmap.width, bitmap.height);
    const initialScale = Math.min(1, maxReferenceDimension / Math.max(1, longestSide));
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    if (!context) throw new Error('浏览器无法创建参考图处理画布。');
    const canvasContext = context;

    async function tryQualityBand(qualitySteps: readonly number[]) {
      for (const scaleStep of scaleSteps) {
        const scale = initialScale * scaleStep;
        const width = Math.max(1, Math.round(bitmap.width * scale));
        const height = Math.max(1, Math.round(bitmap.height * scale));
        canvas.width = width;
        canvas.height = height;
        canvasContext.imageSmoothingEnabled = true;
        canvasContext.imageSmoothingQuality = 'high';
        canvasContext.clearRect(0, 0, width, height);
        canvasContext.drawImage(bitmap, 0, 0, width, height);

        for (const quality of qualitySteps) {
          const blob = await canvasToBlob(canvas, 'image/webp', quality);
          if (blob.type !== 'image/webp') {
            throw new Error('当前浏览器不支持参考图自动压缩，请将图片转换为 WebP 后重试。');
          }
          const dataUrl = await blobToDataUrl(blob);
          if (dataUrl.length <= ATLAS_REFERENCE_SAFE_DATA_URL_LENGTH) {
            return {
              id: reference.id,
              name: reference.name,
              url: dataUrl,
              preprocessing: {
                id: reference.id,
                name: reference.name,
                originalBytes: sourceBlob.size,
                processedBytes: blob.size,
                originalWidth: bitmap.width,
                originalHeight: bitmap.height,
                processedWidth: width,
                processedHeight: height,
                outputType: blob.type,
                outputQuality: quality,
              },
            } satisfies PreparedReference;
          }
        }
      }
      return undefined;
    }

    // Prefer high encoding quality across progressively smaller dimensions.
    // Only use the lower-quality band when no high-quality candidate fits.
    const preferredCandidate = await tryQualityBand(preferredQualitySteps);
    if (preferredCandidate) return preferredCandidate;
    const fallbackCandidate = await tryQualityBand(fallbackQualitySteps);
    if (fallbackCandidate) return fallbackCandidate;

    throw new Error('参考图自动处理后仍然过大，请裁剪图片或降低分辨率后重试。');
  } finally {
    bitmap.close();
  }
}

async function prepareReferenceUncached(reference: ReferenceImage): Promise<PreparedReference> {
  const sourceBlob = await referenceUrlToBlob(reference.url);
  const sourceDataUrl = reference.url.startsWith('data:')
    ? reference.url
    : await blobToDataUrl(sourceBlob);
  if (sourceDataUrl.length <= ATLAS_REFERENCE_SAFE_DATA_URL_LENGTH) {
    return {
      id: reference.id,
      name: reference.name,
      url: sourceDataUrl,
    };
  }
  return compressReference(reference, sourceBlob);
}

export function prepareReferenceForAtlas(reference: ReferenceImage) {
  const existing = preparationCache.get(reference.id);
  if (existing?.sourceUrl === reference.url) return existing.promise;

  const promise = prepareReferenceUncached(reference).catch((error) => {
    const cached = preparationCache.get(reference.id);
    if (cached?.promise === promise) preparationCache.delete(reference.id);
    throw error;
  });
  preparationCache.set(reference.id, { sourceUrl: reference.url, promise });
  while (preparationCache.size > maxCacheEntries) {
    const oldestKey = preparationCache.keys().next().value as string | undefined;
    if (!oldestKey) break;
    preparationCache.delete(oldestKey);
  }
  return promise;
}
