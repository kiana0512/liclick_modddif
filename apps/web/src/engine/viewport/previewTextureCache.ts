import * as THREE from 'three';

const MAX_PREVIEW_TEXTURE_CACHE_SIZE = 12;
const bakedTextureCache = new Map<string, Promise<THREE.Texture>>();
export const residentPreviewTextureCache = new Map<string, THREE.Texture>();
const previewTextureUploadPromises = new WeakMap<THREE.Texture, Promise<void>>();
// Two megapixels keeps a 4K upload below the 16.7ms interaction budget on the
// performance-lab GPU while halving the number of ImageBitmap crops and rAF
// gaps. Pixel format, dimensions and filtering remain unchanged.
const PREVIEW_TEXTURE_UPLOAD_PIXELS_PER_FRAME = 2 * 1024 * 1024;
let registeredPreviewRenderer: THREE.WebGLRenderer | undefined;

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
    void texturePromise?.then((texture) => texture.dispose()).catch(() => undefined);
  }
}

async function loadPreviewImageBitmap(imageUrl: string) {
  if (typeof createImageBitmap !== 'function') return undefined;
  const response = await fetch(imageUrl, { credentials: 'same-origin' });
  if (!response.ok) {
    throw new Error(`Preview texture request failed (${response.status}).`);
  }
  const blob = await response.blob();
  // Preserve the original source dimensions pixel-for-pixel. The optimization
  // is asynchronous decode and scheduling only; no preview downsampling.
  const bitmap = await createImageBitmap(blob, {
    imageOrientation: 'flipY',
    premultiplyAlpha: 'none',
  });
  return { bitmap, sourceWidth: bitmap.width, sourceHeight: bitmap.height };
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
      // Fetching to Blob before createImageBitmap prevents HTMLImageElement's
      // deferred decode from surfacing later as a 400-700ms render-thread task,
      // while preserving the exact source dimensions.
      const result = await loadPreviewImageBitmap(imageUrl);
      if (!result) throw new Error('ImageBitmap is unavailable.');
      texture = new THREE.Texture(result.bitmap);
      texture.flipY = false;
      document.body.dataset.previewTextureSourceSize =
        `${result.sourceWidth}x${result.sourceHeight}`;
      document.body.dataset.previewTextureGpuSize =
        `${result.bitmap.width}x${result.bitmap.height}`;
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
  })()
    .catch((error) => {
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

export async function prewarmPreviewTextures(imageUrls: string[]) {
  const uniqueUrls = [...new Set(imageUrls.filter(Boolean))];
  const startedAt = performance.now();
  const results = await Promise.allSettled(uniqueUrls.map((url) => loadPreviewTexture(url)));
  const renderer = registeredPreviewRenderer;
  if (renderer) {
    for (const result of results) {
      if (result.status !== 'fulfilled') continue;
      await uploadPreviewTextureInStripes(renderer, result.value);
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
      texture.dispose();
    })
    .catch(() => undefined);
}

export function uploadPreviewTextureInStripes(
  renderer: THREE.WebGLRenderer,
  texture: THREE.Texture,
) {
  if (texture.userData.liclickPreviewStripedUploadReady === true) return Promise.resolve();
  const pending = previewTextureUploadPromises.get(texture);
  if (pending) return pending;
  const upload = (async () => {
    const image = texture.image;
    if (!(typeof ImageBitmap !== 'undefined' && image instanceof ImageBitmap)) {
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
    texture.source.dataReady = false;
    texture.needsUpdate = true;
    const allocationStartedAt = performance.now();
    renderer.initTexture(texture);
    document.body.dataset.previewTextureAllocationMs = (
      performance.now() - allocationStartedAt
    ).toFixed(1);
    document.body.dataset.previewTextureStripedUploadSize = `${image.width}x${image.height}`;
    const properties = renderer.properties.get(texture) as { __webglTexture?: WebGLTexture };
    const webGlTexture = properties.__webglTexture;
    if (!webGlTexture) throw new Error('Could not allocate the UV preview texture.');
    const previousActiveTexture = context.getParameter(context.ACTIVE_TEXTURE) as number;
    const previousBinding = context.getParameter(context.TEXTURE_BINDING_2D) as WebGLTexture | null;
    const previousFlipY = context.getParameter(context.UNPACK_FLIP_Y_WEBGL) as boolean;
    const previousPremultiply = context.getParameter(
      context.UNPACK_PREMULTIPLY_ALPHA_WEBGL,
    ) as boolean;
    try {
      // Most preview bitmaps are pre-oriented and use flipY=false. Bake
      // textures may intentionally retain flipY=true; preserve that exact
      // sampling contract while still splitting the upload into stripes.
      context.pixelStorei(context.UNPACK_FLIP_Y_WEBGL, 0);
      context.pixelStorei(context.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0);
      for (let y = 0; y < image.height; y += rowsPerStripe) {
        await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
        const rowCount = Math.min(rowsPerStripe, image.height - y);
        const stripe = await createImageBitmap(image, 0, y, image.width, rowCount, {
          imageOrientation: texture.flipY ? 'flipY' : 'none',
          premultiplyAlpha: 'none',
        });
        try {
          const stripeStartedAt = performance.now();
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
        } finally {
          stripe.close();
        }
      }
      texture.source.dataReady = true;
      texture.userData.liclickPreviewStripedUploadReady = true;
      document.body.dataset.previewTextureStripedUploadMs = (
        performance.now() - startedAt
      ).toFixed(1);
      document.body.dataset.previewTextureStripedUploadMaxStripeMs = maximumStripeMs.toFixed(1);
      document.body.dataset.previewTextureStripedUploadCount = String(
        Math.ceil(image.height / rowsPerStripe),
      );
    } catch (error) {
      texture.source.dataReady = true;
      texture.needsUpdate = true;
      throw error;
    } finally {
      context.activeTexture(previousActiveTexture);
      context.bindTexture(context.TEXTURE_2D, previousBinding);
      context.pixelStorei(context.UNPACK_FLIP_Y_WEBGL, Number(previousFlipY));
      context.pixelStorei(
        context.UNPACK_PREMULTIPLY_ALPHA_WEBGL,
        Number(previousPremultiply),
      );
    }
  })();
  previewTextureUploadPromises.set(texture, upload);
  void upload.catch(() => previewTextureUploadPromises.delete(texture));
  return upload;
}
