import * as THREE from 'three';

const LIVE_PROJECTED_CANVAS_PREFIX = 'liclick-live-projected-canvas:';

type LiveCanvasEntry = {
  canvas: HTMLCanvasElement;
  texture: THREE.CanvasTexture;
  revision: number;
  flipY: boolean;
};

const liveCanvasTextures = new Map<string, LiveCanvasEntry>();

function configureTexture(texture: THREE.CanvasTexture, colorSpace: THREE.ColorSpace, flipY: boolean) {
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

export function isLiveProjectedCanvasUrl(url: string | undefined) {
  return Boolean(url?.startsWith(LIVE_PROJECTED_CANVAS_PREFIX));
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

export function getLiveProjectedCanvasDataUrl(url: string) {
  return liveCanvasTextures.get(url)?.canvas.toDataURL('image/png');
}
