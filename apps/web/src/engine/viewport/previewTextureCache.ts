import * as THREE from 'three';
import {
  createTextureUploadBudget,
  INITIAL_TEXTURE_UPLOAD_PIXELS,
  startFrameIntervalMonitor,
  updateTextureUploadBudget,
} from '@/engine/performance/frameBudgetGovernor';
import { waitForBrowserPaint, yieldToBrowserTask } from '@/utils/browserScheduling';
import {
  isViewportInteractionBusy,
  waitForViewportInteractionIdle as waitForSharedViewportInteractionIdle,
} from './viewportInteractionState';

// Enough for a nine-model scene to retain one 512px proxy and one upgrading
// exact texture per model, plus the selected object's bounded six-layer eye
// toggle working set. The former 18-entry limit evicted worker bitmaps while
// those selected-layer uploads were still requesting stripes, which made some
// repaint/UV rows disappear after a multi-layer restore.
const MAX_PREVIEW_TEXTURE_CACHE_SIZE = 24;
const bakedTextureCache = new Map<string, Promise<THREE.Texture>>();
export const residentPreviewTextureCache = new Map<string, THREE.Texture>();
// Bulk prewarm callers await decode as a group and only then start striped GPU
// uploads. Keep those cache entries pinned for the whole transaction: evicting
// an early-resolved worker bitmap while a later sibling is still decoding made
// the subsequent upload fail with "no longer resident" in nine-model restores.
const pinnedPreviewTextureCacheKeys = new Map<string, number>();
const previewTextureUploadPromises = new WeakMap<
  THREE.Texture,
  WeakMap<THREE.WebGLRenderer, Promise<void>>
>();
const previewTextureReadyRenderers = new WeakMap<THREE.Texture, WeakSet<THREE.WebGLRenderer>>();
const activePreviewTextureUploads = new WeakMap<THREE.WebGLRenderer, number>();
// Detached contexts stay at roughly 0.5MB. Larger detached submissions did
// not improve S9 wall time and increased long frames on NVIDIA/Windows. The
// visible renderer instead uses the frame-budget governor below.
const DETACHED_PREVIEW_TEXTURE_UPLOAD_PIXELS_PER_FRAME = INITIAL_TEXTURE_UPLOAD_PIXELS;
// Flush visible uploads every four stripes without polling a WebGL fence:
// timeout-zero clientWaitSync still blocked the UI thread for 134-150ms on
// NVIDIA under load. Both renderer paths rely on exact same-context ordering.
const PREVIEW_TEXTURE_UPLOAD_STRIPES_PER_FLUSH = 4;
const PREVIEW_BITMAP_DECODE_TIMEOUT_MS = 15_000;
const PREVIEW_BITMAP_STRIPE_TIMEOUT_MS = 15_000;
const PREVIEW_TEXTURE_FALLBACK_TIMEOUT_MS = 20_000;
let registeredPreviewRenderer: THREE.WebGLRenderer | undefined;

function markPreviewTextureUploadStarted(renderer: THREE.WebGLRenderer) {
  activePreviewTextureUploads.set(renderer, (activePreviewTextureUploads.get(renderer) ?? 0) + 1);
}

function markPreviewTextureUploadFinished(renderer: THREE.WebGLRenderer) {
  const remaining = Math.max(0, (activePreviewTextureUploads.get(renderer) ?? 1) - 1);
  if (remaining === 0) activePreviewTextureUploads.delete(renderer);
  else activePreviewTextureUploads.set(renderer, remaining);
}

/**
 * Shader linking and 4K texSubImage work share the same ANGLE command stream.
 * Let critical program compilation wait until every already-started preview
 * upload has released that renderer; this changes scheduling only, never the
 * texture or shader result.
 */
export async function waitForPreviewTextureUploadsIdle(
  renderer: THREE.WebGLRenderer,
  shouldCancel?: () => boolean,
) {
  while ((activePreviewTextureUploads.get(renderer) ?? 0) > 0) {
    if (shouldCancel?.()) throw new DOMException('Texture upload wait superseded.', 'AbortError');
    await waitForBrowserPaint();
  }
}

/**
 * A decoded preview enters the resident cache before its striped GPU upload
 * finishes. Rendering that texture early exposes an allocated-but-incomplete
 * sampler and can leave a restored UV/content-aware layer invisible until a
 * later eye toggle invalidates the material. Only publish cache entries after
 * the exact upload has completed.
 */
export type PreviewTextureLoadOptions = { maxSize?: number };

function getPreviewTextureCacheKey(imageUrl: string, options?: PreviewTextureLoadOptions) {
  return options?.maxSize ? `${imageUrl}::li3d-proxy-${options.maxSize}` : imageUrl;
}

export function getReadyResidentPreviewTexture(
  imageUrl?: string,
  renderer?: THREE.WebGLRenderer,
  options?: PreviewTextureLoadOptions,
) {
  if (!imageUrl) return undefined;
  const texture = residentPreviewTextureCache.get(getPreviewTextureCacheKey(imageUrl, options));
  if (!texture) return undefined;
  if (renderer) {
    return previewTextureReadyRenderers.get(texture)?.has(renderer) ? texture : undefined;
  }
  return texture.userData.liclickPreviewStripedUploadReady === true ? texture : undefined;
}
type BitmapWorkerResponse =
  | { type: 'ready'; id: number; width: number; height: number }
  | { type: 'stripe'; requestId: number; bitmap: ImageBitmap }
  | { type: 'error'; id?: number; requestId?: number; message: string };
let bitmapWorker: Worker | undefined;
let nextBitmapId = 1;
let nextStripeRequestId = 1;
const pendingBitmapMetadata = new Map<
  number,
  {
    resolve: (value: { id: number; width: number; height: number }) => void;
    reject: (error: Error) => void;
  }
>();
const pendingBitmapStripes = new Map<
  number,
  { resolve: (bitmap: ImageBitmap) => void; reject: (error: Error) => void }
>();

function resetBitmapWorker(error: Error) {
  for (const request of pendingBitmapMetadata.values()) request.reject(error);
  for (const request of pendingBitmapStripes.values()) request.reject(error);
  pendingBitmapMetadata.clear();
  pendingBitmapStripes.clear();
  bitmapWorker?.terminate();
  bitmapWorker = undefined;
}

function getBitmapWorker() {
  if (bitmapWorker) return bitmapWorker;
  const worker = new Worker(
    new URL('../../workers/previewImageBitmap.worker.ts', import.meta.url),
    { type: 'module' },
  );
  worker.onmessage = (event: MessageEvent<BitmapWorkerResponse>) => {
    const message = event.data;
    if (message.type === 'ready') {
      const request = pendingBitmapMetadata.get(message.id);
      if (!request) return;
      pendingBitmapMetadata.delete(message.id);
      request.resolve({ id: message.id, width: message.width, height: message.height });
      return;
    }
    if (message.type === 'stripe') {
      const request = pendingBitmapStripes.get(message.requestId);
      if (!request) {
        message.bitmap.close();
        return;
      }
      pendingBitmapStripes.delete(message.requestId);
      request.resolve(message.bitmap);
      return;
    }
    if (message.requestId !== undefined) {
      const request = pendingBitmapStripes.get(message.requestId);
      pendingBitmapStripes.delete(message.requestId);
      request?.reject(new Error(message.message));
    } else if (message.id !== undefined) {
      const request = pendingBitmapMetadata.get(message.id);
      pendingBitmapMetadata.delete(message.id);
      request?.reject(new Error(message.message));
    }
  };
  worker.onerror = (event) =>
    resetBitmapWorker(new Error(event.message || 'Bitmap worker failed.'));
  bitmapWorker = worker;
  return worker;
}

function decodePreviewBitmapInWorker(imageUrl: string, maxSize?: number) {
  const id = nextBitmapId++;
  return new Promise<{ id: number; width: number; height: number }>((resolve, reject) => {
    const timeoutId = window.setTimeout(() => {
      if (!pendingBitmapMetadata.has(id)) return;
      resetBitmapWorker(new Error('Preview texture decode timed out.'));
    }, PREVIEW_BITMAP_DECODE_TIMEOUT_MS);
    pendingBitmapMetadata.set(id, {
      resolve: (value) => {
        window.clearTimeout(timeoutId);
        resolve(value);
      },
      reject: (error) => {
        window.clearTimeout(timeoutId);
        reject(error);
      },
    });
    getBitmapWorker().postMessage({
      type: 'decode',
      id,
      url: new URL(imageUrl, window.location.href).href,
      ...(maxSize ? { maxSize } : {}),
    });
  });
}

function adoptPreviewBitmapInWorker(bitmap: ImageBitmap) {
  const id = nextBitmapId++;
  return new Promise<{ id: number; width: number; height: number }>((resolve, reject) => {
    const timeoutId = window.setTimeout(() => {
      if (!pendingBitmapMetadata.has(id)) return;
      resetBitmapWorker(new Error('Preview texture adoption timed out.'));
    }, PREVIEW_BITMAP_DECODE_TIMEOUT_MS);
    pendingBitmapMetadata.set(id, {
      resolve: (value) => {
        window.clearTimeout(timeoutId);
        resolve(value);
      },
      reject: (error) => {
        window.clearTimeout(timeoutId);
        reject(error);
      },
    });
    getBitmapWorker().postMessage({ type: 'adopt', id, bitmap }, [bitmap]);
  });
}

function requestPreviewBitmapStripe(id: number, y: number, height: number) {
  const requestId = nextStripeRequestId++;
  return new Promise<ImageBitmap>((resolve, reject) => {
    const timeoutId = window.setTimeout(() => {
      if (!pendingBitmapStripes.has(requestId)) return;
      resetBitmapWorker(new Error('Preview texture upload stripe timed out.'));
    }, PREVIEW_BITMAP_STRIPE_TIMEOUT_MS);
    pendingBitmapStripes.set(requestId, {
      resolve: (bitmap) => {
        window.clearTimeout(timeoutId);
        resolve(bitmap);
      },
      reject: (error) => {
        window.clearTimeout(timeoutId);
        reject(error);
      },
    });
    getBitmapWorker().postMessage({ type: 'stripe', id, requestId, y, height });
  });
}

function loadPreviewTextureFallback(imageUrl: string) {
  return new Promise<THREE.Texture>((resolve, reject) => {
    let settled = false;
    const loader = new THREE.TextureLoader();
    const texture = loader.load(
      imageUrl,
      (loadedTexture) => {
        if (settled) {
          loadedTexture.dispose();
          return;
        }
        settled = true;
        window.clearTimeout(timeoutId);
        resolve(loadedTexture);
      },
      undefined,
      (error) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeoutId);
        reject(error instanceof Error ? error : new Error('Preview texture load failed.'));
      },
    );
    const timeoutId = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      texture.dispose();
      reject(new Error('Preview texture fallback load timed out.'));
    }, PREVIEW_TEXTURE_FALLBACK_TIMEOUT_MS);
  });
}

function releaseWorkerBitmap(id: number | undefined) {
  if (id === undefined || !bitmapWorker) return;
  bitmapWorker.postMessage({ type: 'release', id });
}

function getWorkerBitmapId(texture: THREE.Texture) {
  const value = texture.userData.liclickPreviewWorkerBitmapId;
  return typeof value === 'number' ? value : undefined;
}

/** Derived UV buffers can be recomputed after context loss. Once uploaded, keep
 * only their GPU allocation instead of duplicating every cached state in a Worker.
 * Authored/global cached previews must retain their upload source.
 */
export function releaseTransientPreviewUploadSource(renderer: THREE.WebGLRenderer, texture: THREE.Texture) {
  const id = getWorkerBitmapId(texture);
  if (id === undefined) return;
  if (texture.userData.liclickPreviewCacheKey || !previewTextureReadyRenderers.get(texture)?.has(renderer))
    throw new Error('Only uploaded, exclusively owned transient previews may release their source.');
  releaseWorkerBitmap(id);
  delete texture.userData.liclickPreviewWorkerBitmapId;
}

function markPreviewUploadStep(step: string) {
  if (
    document.body.dataset.perfSimulatedViewportInteraction === '1' ||
    new URLSearchParams(window.location.search).get('perfLab') === '1'
  ) {
    document.body.dataset.perfUvBakePhase = step;
  }
}

function waitForViewportInteractionIdle() {
  return waitForSharedViewportInteractionIdle(240);
}

function previewUploadGovernorEnabled() {
  if (typeof window === 'undefined') return true;
  const params = new URLSearchParams(window.location.search);
  // Kept only as a perf-lab A/B switch. Production always defaults to the
  // adaptive path and ordinary users never carry this query parameter.
  return !(params.get('perfLab') === '1' && params.get('previewUploadGovernor') === '0');
}

export function registerPreviewTextureRenderer(renderer: THREE.WebGLRenderer | undefined) {
  registeredPreviewRenderer = renderer;
}

/** Move an exclusively owned, fully uploaded temporary preview after asset save.
 * No alias: disposal under the temporary URL must never free the published map.
 */
export function promotePreparedPreviewTexture(sourceUrl: string, assetUrl: string) {
  const renderer = registeredPreviewRenderer;
  const texture = residentPreviewTextureCache.get(sourceUrl);
  const promise = bakedTextureCache.get(sourceUrl);
  if (!sourceUrl.startsWith('blob:') || !assetUrl || sourceUrl === assetUrl ||
    !renderer || renderer.getContext().isContextLost() || !texture || !promise ||
    !previewTextureReadyRenderers.get(texture)?.has(renderer) ||
    !(renderer.properties.get(texture) as {__webglTexture?:WebGLTexture}).__webglTexture ||
    pinnedPreviewTextureCacheKeys.get(sourceUrl) !== 1 ||
    bakedTextureCache.has(assetUrl) || residentPreviewTextureCache.has(assetUrl)) return false;
  bakedTextureCache.delete(sourceUrl);
  residentPreviewTextureCache.delete(sourceUrl);
  bakedTextureCache.set(assetUrl, promise);
  residentPreviewTextureCache.set(assetUrl, texture);
  texture.userData.liclickPreviewSourceUrl = assetUrl;
  texture.userData.liclickPreviewCacheKey = assetUrl;
  return true;
}

/** Hold a cache entry from before decode until its consumer finishes upload. */
export function retainPreviewTexture(imageUrl: string, options?: PreviewTextureLoadOptions) {
  const cacheKey = getPreviewTextureCacheKey(imageUrl, options);
  pinnedPreviewTextureCacheKeys.set(
    cacheKey,
    (pinnedPreviewTextureCacheKeys.get(cacheKey) ?? 0) + 1,
  );
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const remaining = (pinnedPreviewTextureCacheKeys.get(cacheKey) ?? 1) - 1;
    if (remaining === 0) pinnedPreviewTextureCacheKeys.delete(cacheKey);
    else pinnedPreviewTextureCacheKeys.set(cacheKey, remaining);
    trimBakedTextureCache();
  };
}

function trimBakedTextureCache() {
  while (bakedTextureCache.size > MAX_PREVIEW_TEXTURE_CACHE_SIZE) {
    const oldestKey = [...bakedTextureCache.keys()].find(
      (key) => (pinnedPreviewTextureCacheKeys.get(key) ?? 0) === 0,
    );
    // A temporary over-cap cache is safer than invalidating an in-flight
    // exact texture. The prewarm transaction trims again after unpinning.
    if (!oldestKey) break;
    const texturePromise = bakedTextureCache.get(oldestKey);
    bakedTextureCache.delete(oldestKey);
    residentPreviewTextureCache.delete(oldestKey);
    void texturePromise
      ?.then((texture) => {
        releaseWorkerBitmap(getWorkerBitmapId(texture));
        texture.dispose();
      })
      .catch(() => undefined);
  }
}

function configurePreviewTexture(texture: THREE.Texture) {
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  texture.anisotropy = 8;
  texture.needsUpdate = true;
  return texture;
}

/**
 * Transfers a freshly composited full-resolution bitmap back to the resident
 * bitmap worker. The UI thread keeps only a dimension-only DataTexture and
 * later receives bounded upload stripes, avoiding a full 4K crop on the main
 * thread while preserving the exact bitmap pixels.
 */
export async function createWorkerBackedPreviewTexture(bitmap: ImageBitmap) {
  const result = await adoptPreviewBitmapInWorker(bitmap);
  const texture = new THREE.DataTexture(
    null,
    result.width,
    result.height,
    THREE.RGBAFormat,
    THREE.UnsignedByteType,
  );
  texture.userData.liclickPreviewWorkerBitmapId = result.id;
  texture.source.dataReady = false;
  texture.flipY = false;
  const release = () => {
    releaseWorkerBitmap(result.id);
    texture.removeEventListener('dispose', release);
  };
  texture.addEventListener('dispose', release);
  return configurePreviewTexture(texture);
}

function invalidatePreviewTextureAfterUploadFailure(texture: THREE.Texture) {
  const cacheKey = texture.userData.liclickPreviewCacheKey;
  if (typeof cacheKey !== 'string') return;
  if (residentPreviewTextureCache.get(cacheKey) !== texture) return;
  bakedTextureCache.delete(cacheKey);
  residentPreviewTextureCache.delete(cacheKey);
  releaseWorkerBitmap(getWorkerBitmapId(texture));
  texture.dispose();
}

export function loadPreviewTexture(imageUrl: string, options?: PreviewTextureLoadOptions) {
  const cacheKey = getPreviewTextureCacheKey(imageUrl, options);
  const cached = bakedTextureCache.get(cacheKey);
  if (cached) {
    bakedTextureCache.delete(cacheKey);
    bakedTextureCache.set(cacheKey, cached);
    return cached;
  }
  const loadStartedAt = performance.now();
  document.body.dataset.previewTextureLoadStartedUnixMs = String(Date.now());
  const texturePromise = (async () => {
    let texture: THREE.Texture;
    try {
      // Decode and retain the full image in a worker. The UI thread receives
      // only metadata here and 1MB bitmap stripes during upload; transferring a
      // complete 2K/4K ImageBitmap caused a repeatable 134-150ms task.
      const result = await decodePreviewBitmapInWorker(imageUrl, options?.maxSize);
      texture = new THREE.DataTexture(
        null,
        result.width,
        result.height,
        THREE.RGBAFormat,
        THREE.UnsignedByteType,
      );
      texture.userData.liclickPreviewWorkerBitmapId = result.id;
      texture.source.dataReady = false;
      texture.flipY = false;
      document.body.dataset.previewTextureSourceSize = `${result.width}x${result.height}`;
      document.body.dataset.previewTextureGpuSize = `${result.width}x${result.height}`;
    } catch {
      // Compatibility path for non-fetchable/CORS assets. TextureLoader keeps
      // the previous behavior and the same retry/cache semantics.
      texture = await loadPreviewTextureFallback(imageUrl);
      texture.flipY = true;
    }
    texture.userData.liclickPreviewSourceUrl = imageUrl;
    texture.userData.liclickPreviewCacheKey = cacheKey;
    texture.userData.liclickPreviewMaxSize = options?.maxSize;
    configurePreviewTexture(texture);
    residentPreviewTextureCache.set(cacheKey, texture);
    document.body.dataset.previewTextureLoadReadyUnixMs = String(Date.now());
    document.body.dataset.previewTextureLoadDurationMs = (
      performance.now() - loadStartedAt
    ).toFixed(1);
    document.body.dataset.previewTextureFirstReadyMs ??= performance.now().toFixed(1);
    return texture;
  })().catch((error) => {
    if (bakedTextureCache.get(cacheKey) === texturePromise) {
      bakedTextureCache.delete(cacheKey);
      residentPreviewTextureCache.delete(cacheKey);
    }
    throw error;
  });
  bakedTextureCache.set(cacheKey, texturePromise);
  trimBakedTextureCache();
  return texturePromise;
}

export async function prewarmPreviewTextures(
  imageUrls: string[],
  options?: { allowWhileInteracting?: boolean; maxSize?: number; shouldCancel?: () => boolean },
) {
  const uniqueUrls = [...new Set(imageUrls.filter(Boolean))];
  const releases = uniqueUrls.map((url) => retainPreviewTexture(url, options));
  const startedAt = performance.now();
  try {
    const results = await Promise.allSettled(
      uniqueUrls.map((url) => loadPreviewTexture(url, { maxSize: options?.maxSize })),
    );
    const renderer = registeredPreviewRenderer;
    if (renderer) {
      for (const result of results) {
        if (result.status !== 'fulfilled') continue;
        await uploadPreviewTextureInStripes(renderer, result.value, options);
      }
    }
    document.body.dataset.previewTextureEarlyPrewarmMs = (performance.now() - startedAt).toFixed(1);
    document.body.dataset.previewTextureEarlyPrewarmReadyCount = String(
      results.filter((result) => result.status === 'fulfilled').length,
    );
    return results;
  } finally {
    releases.forEach((release) => release());
  }
}

export function releasePreviewTexture(imageUrl: string) {
  const texturePromise = bakedTextureCache.get(imageUrl);
  bakedTextureCache.delete(imageUrl);
  residentPreviewTextureCache.delete(imageUrl);
  void texturePromise
    ?.then((texture) => {
      if (typeof ImageBitmap !== 'undefined' && texture.image instanceof ImageBitmap) {
        texture.image.close();
      }
      releaseWorkerBitmap(getWorkerBitmapId(texture));
      texture.dispose();
    })
    .catch(() => undefined);
}

export function uploadPreviewTextureInStripes(
  renderer: THREE.WebGLRenderer,
  texture: THREE.Texture,
  options?: { allowWhileInteracting?: boolean; shouldCancel?: () => boolean },
) {
  if (previewTextureReadyRenderers.get(texture)?.has(renderer)) return Promise.resolve();
  let rendererUploads = previewTextureUploadPromises.get(texture);
  if (!rendererUploads) {
    rendererUploads = new WeakMap<THREE.WebGLRenderer, Promise<void>>();
    previewTextureUploadPromises.set(texture, rendererUploads);
  }
  const pending = rendererUploads.get(renderer);
  if (pending) return pending;
  markPreviewTextureUploadStarted(renderer);
  const upload = (async () => {
    const throwIfCancelled = () => {
      if (options?.shouldCancel?.()) {
        throw new DOMException('Texture upload superseded.', 'AbortError');
      }
    };
    throwIfCancelled();
    const image = texture.image;
    const usesVisibleRenderer = renderer.domElement.isConnected;
    const uploadPhasePrefix = usesVisibleRenderer
      ? 'gpu-viewport-texture-upload'
      : 'gpu-detached-texture-upload';
    // Both visible and detached uploads stop at stripe boundaries while the
    // viewport is moving. The detached context still shares the physical GPU,
    // so allowing it to advance during a drag can cost a compositor frame.
    const pauseDuringInteraction = options?.allowWhileInteracting !== true;
    const workerBitmapId = getWorkerBitmapId(texture);
    const imageBitmap = typeof ImageBitmap !== 'undefined' && image instanceof ImageBitmap;
    const markReady = () => {
      texture.userData.liclickPreviewStripedUploadReady = true;
      let readyRenderers = previewTextureReadyRenderers.get(texture);
      if (!readyRenderers) {
        readyRenderers = new WeakSet<THREE.WebGLRenderer>();
        previewTextureReadyRenderers.set(texture, readyRenderers);
      }
      readyRenderers.add(renderer);
    };
    if (!imageBitmap && workerBitmapId === undefined) {
      if (pauseDuringInteraction) await waitForViewportInteractionIdle();
      throwIfCancelled();
      renderer.initTexture(texture);
      markReady();
      return;
    }
    const context = renderer.getContext();
    const adaptiveVisibleUpload = usesVisibleRenderer && previewUploadGovernorEnabled();
    // Retain exact stripes and the presentation gate,
    // but do not charge a whole display frame for every sub-millisecond upload.
    const batchVisibleStripes = usesVisibleRenderer && typeof window !== 'undefined' &&
      !(new URLSearchParams(window.location.search).get('perfLab') === '1' &&
        new URLSearchParams(window.location.search).get('perfResidentQuality') === '0');
    let batchSynchronousMs = 0;
    let presentationRequired = false;
    let uploadBudget = createTextureUploadBudget();
    const frameMonitor = adaptiveVisibleUpload ? startFrameIntervalMonitor() : undefined;
    const startedAt = performance.now();
    let maximumStripeMs = 0;
    let submittedSinceFlush = 0;
    let stripeCount = 0;
    let minimumUploadPixels = uploadBudget.pixels;
    let maximumUploadPixels = uploadBudget.pixels;
    type PreparedPreviewStripe = { rowCount: number; stripe: ImageBitmap; y: number };
    let pendingStripe: Promise<PreparedPreviewStripe> | undefined;
    let activeStripe: ImageBitmap | undefined;
    try {
      texture.source.dataReady = false;
      texture.needsUpdate = true;
      if (pauseDuringInteraction) await waitForViewportInteractionIdle();
      throwIfCancelled();
      const allocationStartedAt = performance.now();
      renderer.initTexture(texture);
      document.body.dataset.previewTextureAllocationMs = (
        performance.now() - allocationStartedAt
      ).toFixed(1);
      document.body.dataset.previewTextureStripedUploadSize = `${image.width}x${image.height}`;
      const properties = renderer.properties.get(texture) as { __webglTexture?: WebGLTexture };
      const webGlTexture = properties.__webglTexture;
      if (!webGlTexture) throw new Error('Could not allocate the UV preview texture.');
      // Most preview bitmaps are pre-oriented and use flipY=false. Bake
      // textures may intentionally retain flipY=true; preserve that exact
      // sampling contract while still splitting the upload into stripes.
      const prepareStripe = async (
        y: number,
        pixelBudget: number,
      ): Promise<PreparedPreviewStripe> => {
        const rowsPerStripe = Math.max(
          1,
          Math.min(image.height, Math.floor(pixelBudget / Math.max(1, image.width))),
        );
        const rowCount = Math.min(rowsPerStripe, image.height - y);
        markPreviewUploadStep(`${uploadPhasePrefix}-crop`);
        const stripe =
          workerBitmapId !== undefined
            ? await requestPreviewBitmapStripe(workerBitmapId, y, rowCount)
            : await createImageBitmap(image, 0, y, image.width, rowCount, {
                imageOrientation: texture.flipY ? 'flipY' : 'none',
                premultiplyAlpha: 'none',
              });
        return { rowCount, stripe, y };
      };
      let y = 0;
      pendingStripe = prepareStripe(
        0,
        usesVisibleRenderer
          ? uploadBudget.pixels
          : DETACHED_PREVIEW_TEXTURE_UPLOAD_PIXELS_PER_FRAME,
      );
      void pendingStripe.catch(() => undefined);
      while (y < image.height) {
        throwIfCancelled();
        if (pauseDuringInteraction) await waitForViewportInteractionIdle();
        throwIfCancelled();
        const prepared: PreparedPreviewStripe = await pendingStripe!;
        activeStripe = prepared.stripe;
        const nextY: number = y + prepared.rowCount;
        // Keep one worker crop in flight while the browser presents. Budget
        // changes therefore take effect after at most one already-prepared
        // stripe, preserving overlap without permitting an unbounded batch.
        pendingStripe =
          nextY < image.height
            ? prepareStripe(
                nextY,
                usesVisibleRenderer
                  ? uploadBudget.pixels
                  : DETACHED_PREVIEW_TEXTURE_UPLOAD_PIXELS_PER_FRAME,
              )
            : undefined;
        void pendingStripe?.catch(() => undefined);
        markPreviewUploadStep(`${uploadPhasePrefix}-yield`);
        if (usesVisibleRenderer && (!batchVisibleStripes || batchSynchronousMs >= 4 || presentationRequired)) {
          // The visible context must yield through presentation because R3F
          // owns the same GL state and command stream.
          await waitForBrowserPaint();
          batchSynchronousMs = 0;
          presentationRequired = false;
        } else {
          // The detached renderer has independent GL state. A macrotask yield
          // lets pointer/rAF work run without adding a mandatory 16.7ms wait to
          // every exact upload stripe (hundreds of waits in a 14-view 4K bake).
          await yieldToBrowserTask();
        }
        throwIfCancelled();
        // Input may arrive between the idle check and the next animation frame.
        // Recheck before issuing any GL work so interaction always wins.
        if (pauseDuringInteraction) await waitForViewportInteractionIdle();
        throwIfCancelled();
        const { rowCount, stripe } = prepared;
        if (options?.shouldCancel?.()) {
          stripe.close();
          activeStripe = undefined;
          throw new DOMException('Texture upload superseded.', 'AbortError');
        }
        // The crop/worker transfer for the next stripe is already in flight.
        // The task yield above separates bitmap adoption from texSubImage2D,
        // preserving input priority without serializing crop and GPU work.
        // Never hold raw GL state across the asynchronous crop above. R3F may
        // render while the worker is producing the stripe, so capture and
        // restore the current bindings only inside this synchronous upload.
        const frameActiveTexture = context.getParameter(context.ACTIVE_TEXTURE) as number;
        const frameBinding = context.getParameter(
          context.TEXTURE_BINDING_2D,
        ) as WebGLTexture | null;
        const frameFlipY = context.getParameter(context.UNPACK_FLIP_Y_WEBGL) as boolean;
        const framePremultiply = context.getParameter(
          context.UNPACK_PREMULTIPLY_ALPHA_WEBGL,
        ) as boolean;
        context.pixelStorei(context.UNPACK_FLIP_Y_WEBGL, 0);
        context.pixelStorei(context.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0);
        let stripeSubmitMs = 0;
        try {
          const stripeStartedAt = performance.now();
          markPreviewUploadStep(`${uploadPhasePrefix}-submit`);
          context.bindTexture(context.TEXTURE_2D, webGlTexture);
          context.texSubImage2D(
            context.TEXTURE_2D,
            0,
            0,
            texture.flipY ? image.height - y - rowCount : y,
            context.RGBA,
            context.UNSIGNED_BYTE,
            stripe,
          );
          stripeSubmitMs = performance.now() - stripeStartedAt;
          batchSynchronousMs += stripeSubmitMs;
          maximumStripeMs = Math.max(maximumStripeMs, stripeSubmitMs);
          stripeCount += 1;
          submittedSinceFlush += 1;
          if (
            usesVisibleRenderer &&
            submittedSinceFlush >= PREVIEW_TEXTURE_UPLOAD_STRIPES_PER_FLUSH
          ) {
            // `clientWaitSync(..., 0, 0)` is permitted to poll, but NVIDIA's
            // Windows driver repeatedly blocked the main thread for 134-150ms.
            // A flush preserves command order without ever synchronously asking
            // the CPU to observe GPU completion.
            context.flush();
            submittedSinceFlush = 0;
          }
        } finally {
          stripe.close();
          activeStripe = undefined;
          context.activeTexture(frameActiveTexture);
          context.bindTexture(context.TEXTURE_2D, frameBinding);
          context.pixelStorei(context.UNPACK_FLIP_Y_WEBGL, Number(frameFlipY));
          context.pixelStorei(context.UNPACK_PREMULTIPLY_ALPHA_WEBGL, Number(framePremultiply));
        }
        if (adaptiveVisibleUpload && frameMonitor) {
          const frameSample = frameMonitor.readAndReset();
          presentationRequired = frameSample.sampleCount > 0 &&
            frameSample.maximumMs > frameSample.targetMs * 1.5;
          uploadBudget = updateTextureUploadBudget(uploadBudget, {
            frameMaximumMs: frameSample.maximumMs,
            frameSampleCount: frameSample.sampleCount,
            frameTargetMs: frameSample.targetMs,
            synchronousWorkMs: stripeSubmitMs,
            interactionBusy: isViewportInteractionBusy(240),
          });
          minimumUploadPixels = Math.min(minimumUploadPixels, uploadBudget.pixels);
          maximumUploadPixels = Math.max(maximumUploadPixels, uploadBudget.pixels);
        }
        y = nextY;
      }
      // Visible textures stay private for two presented frames after the final
      // flush. The upload and later sampler draw share one command stream, so
      // ordering is exact without a driver-side CPU fence poll. Detached
      // textures are likewise drawn/read back on their own ordered stream.
      if (usesVisibleRenderer) {
        markPreviewUploadStep(`${uploadPhasePrefix}-drain`);
        context.flush();
        for (let frame = 0; frame < 2; frame += 1) {
          await waitForBrowserPaint();
          throwIfCancelled();
          if (pauseDuringInteraction) await waitForViewportInteractionIdle();
          throwIfCancelled();
        }
      }
      texture.source.dataReady = true;
      markReady();
      document.body.dataset.previewTextureStripedUploadMs = (performance.now() - startedAt).toFixed(
        1,
      );
      document.body.dataset.previewTextureStripedUploadMaxStripeMs = maximumStripeMs.toFixed(1);
      document.body.dataset.previewTextureStripedUploadCount = String(stripeCount);
      document.body.dataset.previewTextureUploadBudgetRange = `${minimumUploadPixels}-${maximumUploadPixels}`;
      document.body.dataset.previewTextureUploadGovernor = adaptiveVisibleUpload
        ? 'adaptive'
        : 'fixed';
    } catch (error) {
      texture.source.dataReady = true;
      texture.needsUpdate = true;
      invalidatePreviewTextureAfterUploadFailure(texture);
      throw error;
    } finally {
      activeStripe?.close();
      // A crop already in flight still owns its eventual bitmap after abort.
      // Rejections are observed without replacing the original upload error.
      void pendingStripe?.then(
        ({ stripe }) => stripe.close(),
        () => undefined,
      );
      frameMonitor?.stop();
    }
  })().finally(() => markPreviewTextureUploadFinished(renderer));
  rendererUploads.set(renderer, upload);
  void upload.catch(() => rendererUploads?.delete(renderer));
  return upload;
}
