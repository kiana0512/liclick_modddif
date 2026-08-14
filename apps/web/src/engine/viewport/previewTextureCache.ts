import * as THREE from 'three';
import { isViewportInteractionBusy } from './viewportInteractionState';

const MAX_PREVIEW_TEXTURE_CACHE_SIZE = 12;
const bakedTextureCache = new Map<string, Promise<THREE.Texture>>();
export const residentPreviewTextureCache = new Map<string, THREE.Texture>();
const previewTextureUploadPromises = new WeakMap<THREE.Texture, Promise<void>>();
// One eighth of a megapixel bounds each exact RGBA upload submission to 0.5MB. Bake
// uploads share the physical GPU with the viewport even when they use a
// detached WebGL context; this keeps the final upload fence inside one frame.
// Dimensions, filtering and source bytes are unchanged.
const PREVIEW_TEXTURE_UPLOAD_PIXELS_PER_FRAME = 128 * 1024;
// rAF spacing limits CPU submission work, but it does not guarantee that the
// GPU has consumed earlier texSubImage2D commands. Drain a small rolling batch
// before queueing more; otherwise an entire 4K texture accumulates behind the
// viewport and the final fence turns into a 40-60ms release frame.
const PREVIEW_TEXTURE_UPLOAD_STRIPES_PER_FENCE = 4;
let registeredPreviewRenderer: THREE.WebGLRenderer | undefined;
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

async function waitForViewportInteractionIdle() {
  while (isViewportInteractionBusy(240)) {
    await new Promise<void>((resolve) =>
      window.requestAnimationFrame(() => window.setTimeout(resolve, 0)),
    );
  }
}

async function waitForTextureUploadFence(
  context: WebGLRenderingContext | WebGL2RenderingContext,
  pauseDuringInteraction: boolean,
  existingSync?: WebGLSync,
  frameAlreadyYielded = false,
) {
  if (!('fenceSync' in context)) return;
  const gl2 = context as WebGL2RenderingContext;
  const sync = existingSync ?? gl2.fenceSync(gl2.SYNC_GPU_COMMANDS_COMPLETE, 0);
  if (!sync) return;
  const startedAt = performance.now();
  if (!existingSync) gl2.flush();
  try {
    let canPollImmediately = frameAlreadyYielded;
    while (true) {
      if (pauseDuringInteraction) await waitForViewportInteractionIdle();
      if (!canPollImmediately) {
        await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
      }
      canPollImmediately = false;
      const status = gl2.clientWaitSync(sync, 0, 0);
      if (status === gl2.ALREADY_SIGNALED || status === gl2.CONDITION_SATISFIED) break;
      if (status === gl2.WAIT_FAILED) throw new Error('UV preview GPU upload fence failed.');
    }
  } finally {
    gl2.deleteSync(sync);
    document.body.dataset.previewTextureUploadFenceMs = (performance.now() - startedAt).toFixed(1);
  }
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
  options?: { allowWhileInteracting?: boolean },
) {
  if (texture.userData.liclickPreviewStripedUploadReady === true) return Promise.resolve();
  const pending = previewTextureUploadPromises.get(texture);
  if (pending) return pending;
  const upload = (async () => {
    const image = texture.image;
    // A detached renderer owns no visible canvas state. It may keep advancing
    // one bounded upload stripe after each presented viewport frame even while
    // the user is dragging. Waiting for global interaction idle here deadlocks
    // the S4 stress run, which intentionally keeps interaction active for the
    // whole bake. The connected viewport renderer retains the stricter pause.
    const pauseDuringInteraction =
      renderer.domElement.isConnected && options?.allowWhileInteracting !== true;
    const workerBitmapId = getWorkerBitmapId(texture);
    const imageBitmap = typeof ImageBitmap !== 'undefined' && image instanceof ImageBitmap;
    if (!imageBitmap && workerBitmapId === undefined) {
      if (pauseDuringInteraction) await waitForViewportInteractionIdle();
      renderer.initTexture(texture);
      texture.userData.liclickPreviewStripedUploadReady = true;
      return;
    }
    const context = renderer.getContext();
    const rowsPerStripe = Math.max(
      1,
      Math.min(
        image.height,
        Math.floor(PREVIEW_TEXTURE_UPLOAD_PIXELS_PER_FRAME / Math.max(1, image.width)),
      ),
    );
    const startedAt = performance.now();
    let maximumStripeMs = 0;
    let pendingStripeFence: WebGLSync | undefined;
    let submittedSinceFence = 0;
    texture.source.dataReady = false;
    texture.needsUpdate = true;
    if (pauseDuringInteraction) await waitForViewportInteractionIdle();
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
      for (let y = 0; y < image.height; y += rowsPerStripe) {
        if (pauseDuringInteraction) await waitForViewportInteractionIdle();
        markPreviewUploadStep('gpu-texture-upload-wait-frame');
        // Let every visible rAF callback submit first. Continuing from the rAF
        // microtask could put a detached 4K upload stripe ahead of R3F and cost
        // one presentation interval even though the stripe itself is bounded.
        await new Promise<void>((resolve) =>
          window.requestAnimationFrame(() => window.setTimeout(resolve, 0)),
        );
        // Input may arrive between the idle check and the next animation frame.
        // Recheck before issuing any GL work so interaction always wins.
        if (pauseDuringInteraction) await waitForViewportInteractionIdle();
        if (pendingStripeFence) {
          await waitForTextureUploadFence(
            context,
            pauseDuringInteraction,
            pendingStripeFence,
            true,
          );
          pendingStripeFence = undefined;
        }
        // React Three Fiber may have rendered during the rAF above. Reassert
        // only the upload-local unpack state immediately before touching GL;
        // never leave it or our raw texture binding live across a frame.
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
        const rowCount = Math.min(rowsPerStripe, image.height - y);
        markPreviewUploadStep('gpu-texture-upload-crop');
        const stripe =
          workerBitmapId !== undefined
            ? await requestPreviewBitmapStripe(workerBitmapId, y, rowCount)
            : await createImageBitmap(image, 0, y, image.width, rowCount, {
                imageOrientation: texture.flipY ? 'flipY' : 'none',
                premultiplyAlpha: 'none',
              });
        try {
          const stripeStartedAt = performance.now();
          markPreviewUploadStep('gpu-texture-upload-submit');
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
          maximumStripeMs = Math.max(maximumStripeMs, performance.now() - stripeStartedAt);
          submittedSinceFence += 1;
          if (
            'fenceSync' in context &&
            submittedSinceFence >= PREVIEW_TEXTURE_UPLOAD_STRIPES_PER_FENCE
          ) {
            const gl2 = context as WebGL2RenderingContext;
            pendingStripeFence = gl2.fenceSync(gl2.SYNC_GPU_COMMANDS_COMPLETE, 0) ?? undefined;
            gl2.flush();
            submittedSinceFence = 0;
          }
        } finally {
          stripe.close();
          context.activeTexture(frameActiveTexture);
          context.bindTexture(context.TEXTURE_2D, frameBinding);
          context.pixelStorei(context.UNPACK_FLIP_Y_WEBGL, Number(frameFlipY));
          context.pixelStorei(context.UNPACK_PREMULTIPLY_ALPHA_WEBGL, Number(framePremultiply));
        }
      }
      // `texSubImage2D` only queues the transfer. Publishing the texture before
      // that queue is drained shifts the cost into the first real sampler use,
      // which showed up as a 200ms interaction frame when an eye was opened.
      // Fence asynchronously while the texture is still private, then publish.
      markPreviewUploadStep('gpu-texture-upload-fence');
      if (pendingStripeFence) {
        await waitForTextureUploadFence(context, pauseDuringInteraction, pendingStripeFence);
        pendingStripeFence = undefined;
      }
      if (submittedSinceFence > 0) {
        await waitForTextureUploadFence(context, pauseDuringInteraction);
      }
      texture.source.dataReady = true;
      texture.userData.liclickPreviewStripedUploadReady = true;
      document.body.dataset.previewTextureStripedUploadMs = (performance.now() - startedAt).toFixed(
        1,
      );
      document.body.dataset.previewTextureStripedUploadMaxStripeMs = maximumStripeMs.toFixed(1);
      document.body.dataset.previewTextureStripedUploadCount = String(
        Math.ceil(image.height / rowsPerStripe),
      );
    } catch (error) {
      if (pendingStripeFence && 'deleteSync' in context) {
        (context as WebGL2RenderingContext).deleteSync(pendingStripeFence);
      }
      texture.source.dataReady = true;
      texture.needsUpdate = true;
      throw error;
    }
  })();
  previewTextureUploadPromises.set(texture, upload);
  void upload.catch(() => previewTextureUploadPromises.delete(texture));
  return upload;
}
