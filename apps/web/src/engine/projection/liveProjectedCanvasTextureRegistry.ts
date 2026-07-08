import * as THREE from 'three';

const LIVE_PROJECTED_CANVAS_PREFIX = 'liclick-live-projected-canvas:';

type LiveCanvasEntry = {
  canvas: HTMLCanvasElement;
  texture: THREE.CanvasTexture;
};

const liveCanvasTextures = new Map<string, LiveCanvasEntry>();

function configureTexture(texture: THREE.CanvasTexture, colorSpace: THREE.ColorSpace) {
  texture.colorSpace = colorSpace;
  texture.flipY = false;
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
) {
  const url = createLiveProjectedCanvasUrl(id);
  const existing = liveCanvasTextures.get(url);
  if (existing?.canvas === canvas) return url;
  existing?.texture.dispose();
  const texture = new THREE.CanvasTexture(canvas);
  configureTexture(texture, colorSpace);
  liveCanvasTextures.set(url, { canvas, texture });
  return url;
}

export function getLiveProjectedCanvasTexture(url: string, colorSpace: THREE.ColorSpace = THREE.NoColorSpace) {
  const entry = liveCanvasTextures.get(url);
  if (!entry) return undefined;
  configureTexture(entry.texture, colorSpace);
  return entry.texture;
}

export function markLiveProjectedCanvasTextureUpdated(url: string) {
  const entry = liveCanvasTextures.get(url);
  if (entry) entry.texture.needsUpdate = true;
}

export function getLiveProjectedCanvasDataUrl(url: string) {
  return liveCanvasTextures.get(url)?.canvas.toDataURL('image/png');
}
