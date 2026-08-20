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

const MAX_PREVIEW_TEXTURE_CACHE_SIZE = 12;
const bakedTextureCache = new Map<string, Promise<THREE.Texture>>();
export const residentPreviewTextureCache = new Map<string, THREE.Texture>();
const previewTextureUploadPromises = new WeakMap<
  THREE.Texture,
  WeakMap<THREE.WebGLRenderer, Promise<void>>
>();
const previewTextureReadyRenderers = new WeakMap<THREE.Texture, WeakSet<THREE.WebGLRenderer>>();
// Detached contexts stay at roughly 0.5MB. Larger detached submissions did
// not improve S9 wall time and increased long frames on NVIDIA/Windows. The
// visible renderer instead uses the frame-budget governor below.
const DETACHED_PREVIEW_TEXTURE_UPLOAD_PIXELS_PER_FRAME = INITIAL_TEXTURE_UPLOAD_PIXELS;
// Flush visible uploads every four stripes without polling a WebGL fence:
// timeout-zero clientWaitSync still blocked the UI thread for 134-150ms on
// NVIDIA under load. Both renderer paths rely on exact same-context ordering.
const PREVIEW_TEXTURE_UPLOAD_STRIPES_PER_FLUSH = 4;
let registeredPreviewRenderer: THREE.WebGLRenderer | undefined;

/**
 * A decoded preview enters the resident cache before its striped GPU upload
 * finishes. Rendering that texture early exposes an allocated-but-incomplete
 * sampler and can leave a restored UV/content-aware layer invisible until a
 * later eye toggle invalidates the material. Only publish cache entries after
 * the exact upload has completed.
 */
export function getReadyResidentPreviewTexture(imageUrl?: string, renderer?: THREE.WebGLRenderer) {
  if (!imageUrl) return undefined;
  const texture = residentPreviewTextureCache.get(imageUrl);
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

function decodePreviewBitmapInWorker(imageUrl: string) {
  const id = nextBitmapId++;
  return new Promise<{ id: number; width: number; height: number }>((resolve, reject) => {
    pendingBitmapMetadata.set(id, { resolve, reject });
    getBitmapWorker().postMessage({
      type: 'decode',
      id,
      url: new URL(imageUrl, window.location.href).href,
    });
  });
}

function requestPreviewBitmapStripe(id: number, y: number, height: number) {
  const requestId = nextStripeRequestId++;
  return new Promise<ImageBitmap>((resolve, reject) => {
    pendingBitmapStripes.set(requestId, { resolve, reject });
    getBitmapWorker().postMessage({ type: 'stripe', id, requestId, y, height });
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

function trimBakedTextureCache() {
  while (bakedTextureCache.size > MAX_PREVIEW_TEXTURE_CACHE_SIZE) {
    const oldestKey = bakedTextureCache.keys().next().value as string | undefined;
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

export function loadPreviewTexture(imageUrl: string) {
  const cached = bakedTextureCache.get(imageUrl);
  if (cached) {
    bakedTextureCache.delete(imageUrl);
    bakedTextureCache.set(imageUrl, cached);
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
      const result = await decodePreviewBitmapInWorker(imageUrl);
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
      texture = await new THREE.TextureLoader().loadAsync(imageUrl);
      texture.flipY = true;
    }
    configurePreviewTexture(texture);
    residentPreviewTextureCache.set(imageUrl, texture);
    document.body.dataset.previewTextureLoadReadyUnixMs = String(Date.now());
    document.body.dataset.previewTextureLoadDurationMs = (
      performance.now() - loadStartedAt
    ).toFixed(1);
    document.body.dataset.previewTextureFirstReadyMs ??= performance.now().toFixed(1);
    return texture;
  })().catch((error) => {
    if (bakedTextureCache.get(imageUrl) === texturePromise) {
      bakedTextureCache.delete(imageUrl);
    }
    residentPreviewTextureCache.delete(imageUrl);
    throw error;
  });
  bakedTextureCache.set(imageUrl, texturePromise);
  trimBakedTextureCache();
  return texturePromise;
}

export async function prewarmPreviewTextures(
  imageUrls: string[],
  options?: { allowWhileInteracting?: boolean },
) {
  const uniqueUrls = [...new Set(imageUrls.filter(Boolean))];
  const startedAt = performance.now();
  const results = await Promise.allSettled(uniqueUrls.map((url) => loadPreviewTexture(url)));
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
    if (!imageBitmap && workerBitmapId === undefined) {
      if (pauseDuringInteraction) await waitForViewportInteractionIdle();
      throwIfCancelled();
      renderer.initTexture(texture);
      texture.userData.liclickPreviewStripedUploadReady = true;
      let readyRenderers = previewTextureReadyRenderers.get(texture);
      if (!readyRenderers) {
        readyRenderers = new WeakSet<THREE.WebGLRenderer>();
        previewTextureReadyRenderers.set(texture, readyRenderers);
      }
      readyRenderers.add(renderer);
      return;
    }
    const context = renderer.getContext();
    const adaptiveVisibleUpload = usesVisibleRenderer && previewUploadGovernorEnabled();
    let uploadBudget = createTextureUploadBudget();
    const frameMonitor = adaptiveVisibleUpload ? startFrameIntervalMonitor() : undefined;
    const startedAt = performance.now();
    let maximumStripeMs = 0;
    let submittedSinceFlush = 0;
    let stripeCount = 0;
    let minimumUploadPixels = uploadBudget.pixels;
    let maximumUploadPixels = uploadBudget.pixels;
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
    try {
      // Most preview bitmaps are pre-oriented and use flipY=false. Bake
      // textures may intentionally retain flipY=true; preserve that exact
      // sampling contract while still splitting the upload into stripes.
      type PreparedPreviewStripe = { rowCount: number; stripe: ImageBitmap; y: number };
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
      let pendingStripe: Promise<PreparedPreviewStripe> | undefined = prepareStripe(
        0,
        usesVisibleRenderer
          ? uploadBudget.pixels
          : DETACHED_PREVIEW_TEXTURE_UPLOAD_PIXELS_PER_FRAME,
      );
      while (y < image.height) {
        throwIfCancelled();
        if (pauseDuringInteraction) await waitForViewportInteractionIdle();
        throwIfCancelled();
        const prepared: PreparedPreviewStripe = await pendingStripe!;
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
        markPreviewUploadStep(`${uploadPhasePrefix}-yield`);
        if (usesVisibleRenderer) {
          // The visible context must yield through presentation because R3F
          // owns the same GL state and command stream.
          await waitForBrowserPaint();
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
          context.activeTexture(frameActiveTexture);
          context.bindTexture(context.TEXTURE_2D, frameBinding);
          context.pixelStorei(context.UNPACK_FLIP_Y_WEBGL, Number(frameFlipY));
          context.pixelStorei(context.UNPACK_PREMULTIPLY_ALPHA_WEBGL, Number(framePremultiply));
        }
        if (adaptiveVisibleUpload && frameMonitor) {
          const frameSample = frameMonitor.readAndReset();
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
      texture.userData.liclickPreviewStripedUploadReady = true;
      let readyRenderers = previewTextureReadyRenderers.get(texture);
      if (!readyRenderers) {
        readyRenderers = new WeakSet<THREE.WebGLRenderer>();
        previewTextureReadyRenderers.set(texture, readyRenderers);
      }
      readyRenderers.add(renderer);
      document.body.dataset.previewTextureStripedUploadMs = (performance.now() - startedAt).toFixed(
        1,
      );
      document.body.dataset.previewTextureStripedUploadMaxStripeMs = maximumStripeMs.toFixed(1);
      document.body.dataset.previewTextureStripedUploadCount = String(stripeCount);
      document.body.dataset.previewTextureUploadBudgetRange = `${minimumUploadPixels}-${maximumUploadPixels}`;
      document.body.dataset.previewTextureUploadGovernor = adaptiveVisibleUpload ? 'adaptive' : 'fixed';
    } catch (error) {
      texture.source.dataReady = true;
      texture.needsUpdate = true;
      throw error;
    } finally {
      frameMonitor?.stop();
    }
  })();
  rendererUploads.set(renderer, upload);
  void upload.catch(() => rendererUploads?.delete(renderer));
  return upload;
}
