import * as THREE from 'three';
import { registerRuntimeLayerAssetSource } from '@/services/runtimeLayerAssetPersistence';

const LIVE_PROJECTED_CANVAS_PREFIX = 'liclick-live-projected-canvas:';

type LiveCanvasEntry = {
  canvas: HTMLCanvasElement;
  texture: THREE.CanvasTexture;
  revision: number;
  flipY: boolean;
  width: number;
  height: number;
  encodedPng?: EncodedPng;
};

type LiveImageEntry = {
  image: HTMLImageElement | ImageBitmap;
  texture: THREE.Texture;
  revision: number;
  flipY: boolean;
  encodedPng?: EncodedPng;
};

type EncodedPng = {
  revision: number;
  promise: Promise<Blob>;
};

const liveCanvasTextures = new Map<string, LiveCanvasEntry>();
const liveImageTextures = new Map<string, LiveImageEntry>();
const liveUvTargets = new Map<string, THREE.Texture>();
const pendingUvCommits = new Set<Promise<unknown>>();
const failedUvCommits = new Map<string, unknown>();

/** GPU-owned sRGB pixels with a committed CPU mirror for assets/export. */
export function registerLiveUvRenderTarget(id: string, canvas: HTMLCanvasElement, texture: THREE.Texture) {
  const url = registerLiveProjectedCanvasTexture(id, canvas, THREE.SRGBColorSpace, { flipY: true });
  liveUvTargets.set(url, texture);
  failedUvCommits.delete(url);
  return url;
}

export function unregisterLiveUvRenderTarget(url: string, texture: THREE.Texture) {
  if (liveUvTargets.get(url) !== texture) return;
  liveUvTargets.delete(url);
  failedUvCommits.delete(url);
  // Persisted/history consumers can still resolve the committed CPU image.
  const entry = liveCanvasTextures.get(url);
  if (entry) entry.texture.needsUpdate = true;
}

export function trackLiveUvCommit(work: Promise<unknown>, url?: string) {
  pendingUvCommits.add(work);
  const owner = url ? liveUvTargets.get(url) : undefined;
  void work.catch((error) => {
    if (url && liveUvTargets.get(url) === owner) failedUvCommits.set(url, error);
  });
  void work.finally(() => pendingUvCommits.delete(work)).catch(() => undefined);
}

export async function flushLiveUvCommits() {
  while (pendingUvCommits.size) await Promise.all([...pendingUvCommits]);
  if (failedUvCommits.size) throw new Error('UV 笔画读回失败，请重新载入后重试；未导出或保存不完整贴图。');
}

// WebGL2 allocates immutable storage on the first upload. Resizing the canvas
// (notably the eraser's 1px bootstrap -> full UV mask) cannot be uploaded into
// that old allocation with needsUpdate alone. Release GPU storage, not the
// shared Texture/Source identity: every resident uniform must keep this object.
function refreshCanvasStorage(entry: LiveCanvasEntry) {
  const { width, height } = entry.canvas;
  if (entry.width === width && entry.height === height) return false;
  entry.texture.dispose();
  entry.width = width;
  entry.height = height;
  entry.encodedPng = undefined;
  return true;
}

function configureTexture(
  texture: THREE.Texture,
  colorSpace: THREE.ColorSpace,
  flipY: boolean,
  publish = false,
) {
  // Resolving a resident binding is not a pixel write. Re-dirtying it here
  // schedules unchanged source/mask uploads on overlay and stack rebinds.
  if (
    !publish &&
    texture.colorSpace === colorSpace &&
    texture.flipY === flipY &&
    texture.wrapS === THREE.ClampToEdgeWrapping &&
    texture.wrapT === THREE.ClampToEdgeWrapping &&
    texture.minFilter === THREE.LinearFilter &&
    texture.magFilter === THREE.LinearFilter &&
    !texture.generateMipmaps
  ) return;
  texture.colorSpace = colorSpace;
  texture.flipY = flipY;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
}

export function createLiveProjectedCanvasUrl(id: string) {
  return `${LIVE_PROJECTED_CANVAS_PREFIX}${id}`;
}

export function isLiveProjectedCanvasUrl(url: unknown) {
  return typeof url === 'string' && url.startsWith(LIVE_PROJECTED_CANVAS_PREFIX);
}

export function registerLiveProjectedCanvasTexture(
  id: string,
  canvas: HTMLCanvasElement,
  colorSpace: THREE.ColorSpace = THREE.NoColorSpace,
  options: { flipY?: boolean } = {},
) {
  const url = createLiveProjectedCanvasUrl(id);
  liveUvTargets.delete(url);
  const existing = liveCanvasTextures.get(url);
  if (existing) {
    // A live URL is a stable material binding, not just a cache key. Reopening
    // a local-repaint row creates a new backing canvas with the same layer id.
    // Replacing the CanvasTexture object here leaves every resident projected
    // material holding the disposed previous texture until a structural rebuild
    // (selecting the row happens to trigger one). Keep the texture identity and
    // swap only its source so eye/preview toggles immediately sample the same
    // erased mask as the interactive overlay.
    if (existing.canvas !== canvas) {
      existing.canvas = canvas;
      existing.texture.image = canvas;
      existing.revision += 1;
      existing.encodedPng = undefined;
    }
    existing.flipY = options.flipY ?? existing.flipY;
    refreshCanvasStorage(existing);
    configureTexture(existing.texture, colorSpace, existing.flipY, true);
    return url;
  }
  liveImageTextures.get(url)?.texture.dispose();
  liveImageTextures.delete(url);
  const texture = new THREE.CanvasTexture(canvas);
  const flipY = options.flipY ?? false;
  configureTexture(texture, colorSpace, flipY, true);
  liveCanvasTextures.set(url, {
    canvas,
    texture,
    revision: 0,
    flipY,
    width: canvas.width,
    height: canvas.height,
  });
  return url;
}

export function registerLiveProjectedImageTexture(
  id: string,
  image: HTMLImageElement | ImageBitmap,
  colorSpace: THREE.ColorSpace = THREE.NoColorSpace,
  options: { flipY?: boolean } = {},
) {
  const url = createLiveProjectedCanvasUrl(id);
  const existing = liveImageTextures.get(url);
  if (existing?.image === image) return url;
  existing?.texture.dispose();
  liveCanvasTextures.get(url)?.texture.dispose();
  liveCanvasTextures.delete(url);
  const texture = new THREE.Texture(image);
  const flipY = options.flipY ?? false;
  configureTexture(texture, colorSpace, flipY, true);
  liveImageTextures.set(url, {
    image,
    texture,
    revision: (existing?.revision ?? -1) + 1,
    flipY,
  });
  return url;
}

export function getLiveProjectedCanvasTexture(
  url: string,
  colorSpace: THREE.ColorSpace = THREE.NoColorSpace,
  options: { flipY?: boolean } = {},
) {
  return liveCanvasTextures.has(url)
    ? (getLiveProjectedTexture(url, colorSpace, options) as THREE.CanvasTexture)
    : undefined;
}

export function getLiveProjectedTexture(
  url: string,
  colorSpace: THREE.ColorSpace = THREE.NoColorSpace,
  options: { flipY?: boolean } = {},
) {
  const uvTarget = liveUvTargets.get(url);
  if (uvTarget) return uvTarget;
  const entry = liveCanvasTextures.get(url) ?? liveImageTextures.get(url);
  if (!entry) return undefined;
  entry.flipY = options.flipY ?? entry.flipY;
  configureTexture(
    entry.texture,
    colorSpace,
    entry.flipY,
    'canvas' in entry && refreshCanvasStorage(entry),
  );
  return entry.texture;
}

export function markLiveProjectedCanvasTextureUpdated(
  url: string,
  options: { upload?: boolean } = {},
) {
  const entry = liveCanvasTextures.get(url);
  if (entry) {
    entry.revision += 1;
    // Callers that already published the final CanvasTexture revision during
    // the interactive frame only need to invalidate the encoded-asset cache at
    // pointer-up. Scheduling the same full canvas upload again on release made
    // every short dot pay an avoidable presentation stall.
    const resized = refreshCanvasStorage(entry);
    if (options.upload !== false || resized) entry.texture.needsUpdate = true;
  }
}

export function getLiveProjectedCanvasState(url: string) {
  const entry = liveCanvasTextures.get(url);
  return entry ? { canvas: entry.canvas, revision: entry.revision } : undefined;
}

/** Only the exact transient canvas owner may release a renderer-only binding. */
export function releaseLiveProjectedCanvasTexture(url: string, canvas: HTMLCanvasElement) {
  const entry = liveCanvasTextures.get(url);
  if (!entry || entry.canvas !== canvas || liveUvTargets.has(url)) return;
  entry.texture.dispose();
  liveCanvasTextures.delete(url);
}

function canvasToPngBlob(canvas: HTMLCanvasElement) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('Could not encode the live projected canvas as PNG.'));
    }, 'image/png');
  });
}

function imageToPngBlob(image: HTMLImageElement | ImageBitmap) {
  const width = image instanceof HTMLImageElement ? image.naturalWidth || image.width : image.width;
  const height = image instanceof HTMLImageElement ? image.naturalHeight || image.height : image.height;
  if (!width || !height) return Promise.reject(new Error('The live projected image is empty.'));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) return Promise.reject(new Error('Could not encode the live projected image.'));
  context.drawImage(image, 0, 0, width, height);
  return canvasToPngBlob(canvas);
}

function getEncodedPng(
  entry: { revision: number; encodedPng?: EncodedPng },
  encode: () => Promise<Blob>,
) {
  if (entry.encodedPng?.revision === entry.revision) return entry.encodedPng.promise;
  const revision = entry.revision;
  const promise = encode().catch((error) => {
    if (entry.encodedPng?.promise === promise) entry.encodedPng = undefined;
    throw error;
  });
  entry.encodedPng = { revision, promise };
  return promise;
}

export function getLiveProjectedCanvasBlob(url: string) {
  const entry = liveCanvasTextures.get(url);
  if (!entry) return undefined;
  if (liveUvTargets.has(url))
    return flushLiveUvCommits().then(() => getEncodedPng(entry, () => canvasToPngBlob(entry.canvas)));
  return getEncodedPng(entry, () => canvasToPngBlob(entry.canvas));
}

export function getLiveProjectedTextureBlob(url: string) {
  const canvasEntry = liveCanvasTextures.get(url);
  if (canvasEntry && liveUvTargets.has(url))
    return flushLiveUvCommits().then(() => getEncodedPng(canvasEntry, () => canvasToPngBlob(canvasEntry.canvas)));
  if (canvasEntry) return getEncodedPng(canvasEntry, () => canvasToPngBlob(canvasEntry.canvas));
  const imageEntry = liveImageTextures.get(url);
  return imageEntry
    ? getEncodedPng(imageEntry, () => imageToPngBlob(imageEntry.image))
    : undefined;
}

export function getLiveProjectedTextureSourceState(url: string) {
  const canvasEntry = liveCanvasTextures.get(url);
  if (canvasEntry) return { source: canvasEntry.canvas, revision: canvasEntry.revision };
  const imageEntry = liveImageTextures.get(url);
  return imageEntry ? { source: imageEntry.image, revision: imageEntry.revision } : undefined;
}

registerRuntimeLayerAssetSource({
  flush: flushLiveUvCommits,
  blob: getLiveProjectedTextureBlob,
  state: getLiveProjectedTextureSourceState,
});
