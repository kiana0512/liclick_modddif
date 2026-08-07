import * as THREE from 'three';

const LIVE_PROJECTED_CANVAS_PREFIX = 'liclick-live-projected-canvas:';

type LiveCanvasEntry = {
  canvas: HTMLCanvasElement;
  texture: THREE.CanvasTexture;
  revision: number;
  flipY: boolean;
  encodedPng?: {
    revision: number;
    promise: Promise<Blob>;
  };
};

type LiveImageEntry = {
  image: HTMLImageElement;
  texture: THREE.Texture;
  revision: number;
  flipY: boolean;
};

const liveCanvasTextures = new Map<string, LiveCanvasEntry>();
const liveImageTextures = new Map<string, LiveImageEntry>();

function configureTexture(
  texture: THREE.Texture,
  colorSpace: THREE.ColorSpace,
  flipY: boolean,
) {
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
  const existing = liveCanvasTextures.get(url);
  if (existing?.canvas === canvas) return url;
  existing?.texture.dispose();
  liveImageTextures.get(url)?.texture.dispose();
  liveImageTextures.delete(url);
  const texture = new THREE.CanvasTexture(canvas);
  const flipY = options.flipY ?? false;
  configureTexture(texture, colorSpace, flipY);
  // Preserve a monotonic revision when a stable runtime URL swaps canvases.
  // Consumers can then detect the replacement without forcing a new layer URL.
  liveCanvasTextures.set(url, {
    canvas,
    texture,
    revision: (existing?.revision ?? -1) + 1,
    flipY,
  });
  return url;
}

export function registerLiveProjectedImageTexture(
  id: string,
  image: HTMLImageElement,
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
  configureTexture(texture, colorSpace, flipY);
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
  const entry = liveCanvasTextures.get(url);
  if (!entry) return undefined;
  entry.flipY = options.flipY ?? entry.flipY;
  configureTexture(entry.texture, colorSpace, entry.flipY);
  return entry.texture;
}

export function getLiveProjectedTexture(
  url: string,
  colorSpace: THREE.ColorSpace = THREE.NoColorSpace,
  options: { flipY?: boolean } = {},
) {
  const entry = liveCanvasTextures.get(url) ?? liveImageTextures.get(url);
  if (!entry) return undefined;
  entry.flipY = options.flipY ?? entry.flipY;
  configureTexture(entry.texture, colorSpace, entry.flipY);
  return entry.texture;
}

export function markLiveProjectedCanvasTextureUpdated(url: string) {
  const entry = liveCanvasTextures.get(url);
  if (entry) {
    entry.revision += 1;
    entry.texture.needsUpdate = true;
  }
}

export function getLiveProjectedCanvasState(url: string) {
  const entry = liveCanvasTextures.get(url);
  return entry ? { canvas: entry.canvas, revision: entry.revision } : undefined;
}

function canvasToPngBlob(canvas: HTMLCanvasElement) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('Could not encode the live projected canvas as PNG.'));
    }, 'image/png');
  });
}

export function getLiveProjectedCanvasBlob(url: string) {
  const entry = liveCanvasTextures.get(url);
  if (!entry) return undefined;
  if (entry.encodedPng?.revision === entry.revision) return entry.encodedPng.promise;

  const revision = entry.revision;
  const promise = canvasToPngBlob(entry.canvas).catch((error) => {
    const latest = liveCanvasTextures.get(url);
    if (latest?.encodedPng?.promise === promise) latest.encodedPng = undefined;
    throw error;
  });
  entry.encodedPng = { revision, promise };
  return promise;
}

export function getLiveProjectedTextureSourceState(url: string) {
  const canvasEntry = liveCanvasTextures.get(url);
  if (canvasEntry) return { source: canvasEntry.canvas, revision: canvasEntry.revision };
  const imageEntry = liveImageTextures.get(url);
  return imageEntry ? { source: imageEntry.image, revision: imageEntry.revision } : undefined;
}
