import type { DisplayMode, ModelBoundingBox } from '@/types/model';

export const frontProjectThumbnailCapture = {
  width: 2048,
  height: 2048,
  matchCameraToRenderAspect: true,
} as const;

const PROJECT_THUMBNAIL_VERSION_PARAM = 'li3dThumbnail';

function isTransientThumbnailUrl(thumbnail: string | undefined) {
  return Boolean(thumbnail?.startsWith('data:') || thumbnail?.startsWith('blob:'));
}

/**
 * Project thumbnail assets intentionally keep a stable filename. Add the
 * project revision time to card URLs so an overwritten PNG cannot reuse an
 * older browser/CDN response.
 */
export function withProjectThumbnailVersion(thumbnail: string, updatedAt: string) {
  if (!thumbnail || isTransientThumbnailUrl(thumbnail)) return thumbnail;
  const version = Date.parse(updatedAt);
  if (!Number.isFinite(version)) return thumbnail;

  const hashIndex = thumbnail.indexOf('#');
  const hash = hashIndex >= 0 ? thumbnail.slice(hashIndex) : '';
  const withoutHash = hashIndex >= 0 ? thumbnail.slice(0, hashIndex) : thumbnail;
  const queryIndex = withoutHash.indexOf('?');
  const pathname = queryIndex >= 0 ? withoutHash.slice(0, queryIndex) : withoutHash;
  const search = new URLSearchParams(queryIndex >= 0 ? withoutHash.slice(queryIndex + 1) : '');
  search.set(PROJECT_THUMBNAIL_VERSION_PARAM, String(version));
  return `${pathname}?${search.toString()}${hash}`;
}

export function selectProjectCardThumbnail(
  serverProject: { thumbnail: string; updatedAt: string },
  currentProject?: { thumbnail?: string; updatedAt?: string; dirty?: boolean },
) {
  const serverThumbnail = withProjectThumbnailVersion(
    serverProject.thumbnail,
    serverProject.updatedAt,
  );
  if (!isTransientThumbnailUrl(currentProject?.thumbnail)) return serverThumbnail;

  const serverUpdatedAt = Date.parse(serverProject.updatedAt);
  const currentUpdatedAt = Date.parse(currentProject?.updatedAt ?? '');
  const currentThumbnailIsLatest =
    currentProject?.dirty === true ||
    !Number.isFinite(serverUpdatedAt) ||
    (Number.isFinite(currentUpdatedAt) && currentUpdatedAt >= serverUpdatedAt);
  return currentThumbnailIsLatest
    ? (currentProject?.thumbnail ?? serverThumbnail)
    : serverThumbnail;
}

/**
 * Project cards always use the textured PBR presentation. The editor defaults
 * to flat mode and users may leave from normal/wire mode, so thumbnail capture
 * must not inherit a diagnostic viewport mode or skip the capture entirely.
 */
export function withProjectThumbnailPbrMode<T>(
  currentDisplayMode: DisplayMode,
  setDisplayMode: (displayMode: DisplayMode) => void,
  capture: () => T,
) {
  if (currentDisplayMode === 'pbr') return capture();

  setDisplayMode('pbr');
  try {
    return capture();
  } finally {
    setDisplayMode(currentDisplayMode);
  }
}

export type ProjectThumbnailFraming = {
  bounds: ModelBoundingBox;
  leftmostModelIndex: number;
  rightmostModelIndex: number;
};

export type FrontProjectThumbnailCameraFrame = {
  aspect: number;
  fov: number;
  near: number;
  far: number;
  position: [number, number, number];
  target: [number, number, number];
};

function isUsableModelBounds(bounds: ModelBoundingBox) {
  const values = [...bounds.min, ...bounds.max];
  return (
    values.every(Number.isFinite) && bounds.max.every((value, index) => value >= bounds.min[index])
  );
}

/**
 * The front preview uses the world-X extremes as its horizontal boundary:
 * the model reaching furthest left supplies min X and the model reaching
 * furthest right supplies max X. Vertical/depth bounds still include every
 * model so a taller middle object cannot be clipped.
 */
export function getProjectThumbnailFraming(
  modelBounds: ModelBoundingBox[],
): ProjectThumbnailFraming | undefined {
  const usableBounds = modelBounds
    .map((bounds, index) => ({ bounds, index }))
    .filter(({ bounds }) => isUsableModelBounds(bounds));
  if (usableBounds.length === 0) return undefined;

  let leftmost = usableBounds[0];
  let rightmost = usableBounds[0];
  for (const candidate of usableBounds.slice(1)) {
    if (candidate.bounds.min[0] < leftmost.bounds.min[0]) leftmost = candidate;
    if (candidate.bounds.max[0] > rightmost.bounds.max[0]) rightmost = candidate;
  }

  const minX = leftmost.bounds.min[0];
  const maxX = rightmost.bounds.max[0];
  const minY = Math.min(...usableBounds.map(({ bounds }) => bounds.min[1]));
  const maxY = Math.max(...usableBounds.map(({ bounds }) => bounds.max[1]));
  const minZ = Math.min(...usableBounds.map(({ bounds }) => bounds.min[2]));
  const maxZ = Math.max(...usableBounds.map(({ bounds }) => bounds.max[2]));

  return {
    bounds: {
      min: [minX, minY, minZ],
      max: [maxX, maxY, maxZ],
      center: [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2],
      size: [maxX - minX, maxY - minY, maxZ - minZ],
    },
    leftmostModelIndex: leftmost.index,
    rightmostModelIndex: rightmost.index,
  };
}

export function getFrontProjectThumbnailCameraFrame(
  bounds: ModelBoundingBox,
  aspect = 1,
  fov = 35,
  padding = 1.08,
): FrontProjectThumbnailCameraFrame {
  const safeAspect = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
  const safeFov = Number.isFinite(fov) ? Math.min(Math.max(fov, 1), 120) : 35;
  const safePadding = Number.isFinite(padding) ? Math.max(padding, 1) : 1.08;
  const halfWidth = Math.max(bounds.size[0] / 2, 0.001);
  const halfHeight = Math.max(bounds.size[1] / 2, 0.001);
  const halfDepth = Math.max(bounds.size[2] / 2, 0.001);
  const tanHalfVerticalFov = Math.tan((safeFov * Math.PI) / 360);
  const tanHalfHorizontalFov = tanHalfVerticalFov * safeAspect;
  const distance =
    halfDepth +
    Math.max(halfHeight / tanHalfVerticalFov, halfWidth / tanHalfHorizontalFov) * safePadding;
  const maxDimension = Math.max(bounds.size[0], bounds.size[1], bounds.size[2], 1);
  const target = [...bounds.center] as [number, number, number];

  return {
    aspect: safeAspect,
    fov: safeFov,
    near: 0.01,
    far: Math.max(distance + halfDepth + maxDimension * 6, 100),
    position: [target[0], target[1], target[2] + Math.max(distance, 0.1)],
    target,
  };
}

export type ImageDrawRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export function getContainedImageDrawRect(
  sourceWidth: number,
  sourceHeight: number,
  targetWidth: number,
  targetHeight: number,
): ImageDrawRect {
  if (
    sourceWidth <= 0 ||
    sourceHeight <= 0 ||
    targetWidth <= 0 ||
    targetHeight <= 0 ||
    ![sourceWidth, sourceHeight, targetWidth, targetHeight].every(Number.isFinite)
  ) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }

  const scale = Math.min(targetWidth / sourceWidth, targetHeight / sourceHeight);
  const width = sourceWidth * scale;
  const height = sourceHeight * scale;
  return {
    x: (targetWidth - width) / 2,
    y: (targetHeight - height) / 2,
    width,
    height,
  };
}
