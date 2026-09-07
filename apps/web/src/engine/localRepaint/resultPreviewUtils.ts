import { blobToDataUrl, imageDataToBlob, resizeImageData, urlToImageData } from './imageUtils';
import { createDisplayPreviewQueue, requestDisplayPreview, type DisplayPreviewRequest } from './displayPreviewQueue';
import { waitForViewportInteractionIdle } from '@/engine/viewport/viewportInteractionState';
import { waitForBrowserPaint } from '@/utils/browserScheduling';

const previewCache = new Map<string, Promise<string>>();
const captureMaskedProjectionCache = new Map<
  string,
  { maskUrl: string; promise: Promise<string> }
>();
const MAX_PREVIEW_CACHE_ENTRIES = 12;
const SUBJECT_PADDING_RATIO = 0.02;
const GENERATED_DISPLAY_PADDING_RATIO = 0.06;
const GENERATED_DISPLAY_MAX_DIMENSION = 1024;
const CAPTURE_PREVIEW_EDGE_DETECT_RADIUS = 4;
const CAPTURE_PREVIEW_EDGE_PULL_DISTANCE = 6;
const CAPTURE_PREVIEW_EDGE_GRADIENT_START = 8;
const CAPTURE_PREVIEW_EDGE_GRADIENT_END = 128;

// Temporarily show local-repaint previews exactly as returned by ModelView.
// The preview flood-fill can mistake authored black material, narrow gaps, and
// shadows for the backdrop. Model projection keeps its separate silhouette
// constraint so the generated background still cannot be painted onto meshes.
export const LOCAL_REPAINT_RESULT_PREVIEW_CUTOUT_ENABLED = false;

function getTone(data: Uint8ClampedArray, offset: number) {
  const red = data[offset];
  const green = data[offset + 1];
  const blue = data[offset + 2];
  const alpha = data[offset + 3];
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const chroma = max - min;
  const luma = red * 0.2126 + green * 0.7152 + blue * 0.0722;
  return { alpha, max, min, chroma, luma };
}

export type BackgroundRemovalMode = 'neutral' | 'dark-only';

export type GeneratedDisplayPreview = {
  /** Source-sized copy for UI surfaces that must preserve capture alignment. */
  alignedUrl: string;
  /** Single-cropped copy for cards, zoom previews and layer thumbnails. */
  fittedUrl: string;
};

/**
 * Applies renderer-authored geometry coverage to a generated display copy.
 *
 * This is deliberately UI-only. It never changes the Generation result, Layer
 * imageUrl, projection source, UV bake input or export asset. Depth is safer
 * than colour-key matting because black generated material remains content.
 */
export function applyPackedDepthDisplayMask(source: ImageData, packedDepth: ImageData) {
  if (source.width !== packedDepth.width || source.height !== packedDepth.height) {
    throw new Error('Generated display source and depth dimensions must match.');
  }
  const output = new ImageData(new Uint8ClampedArray(source.data), source.width, source.height);
  const pixels = new Uint32Array(output.data.buffer);
  let changedPixels = 0;
  for (let offset = 0; offset < output.data.length; offset += 4) {
    const clearPixel =
      packedDepth.data[offset] >= 254 &&
      packedDepth.data[offset + 1] >= 254 &&
      packedDepth.data[offset + 2] >= 254;
    if (!clearPixel) continue;
    if (pixels[offset / 4] !== 0) changedPixels += 1;
    // Zero is identical in either byte order; keep the depth RGB test above.
    pixels[offset / 4] = 0;
  }
  return { imageData: output, changedPixels };
}

/**
 * Conservative fallback for legacy generated rows without capture depth.
 * Only an almost-black region connected to the outer frame is cleared. There
 * is no detached-region search, erosion, percentile trim or second matte pass.
 */
export function removeStrictOuterDarkDisplayBackground(source: ImageData) {
  const { width, height, data } = source;
  const output = new ImageData(new Uint8ClampedArray(data), width, height);
  const visited = new Uint8Array(width * height);
  const queue = new Int32Array(width * height);
  let head = 0;
  let tail = 0;
  const accepts = (index: number, seed: boolean) => {
    const offset = index * 4;
    if (data[offset + 3] <= (seed ? 8 : 16)) return true;
    const red = data[offset], green = data[offset + 1], blue = data[offset + 2];
    const max = Math.max(red, green, blue);
    const chroma = max - Math.min(red, green, blue);
    const luma = red * 0.2126 + green * 0.7152 + blue * 0.0722;
    return seed
      ? luma <= 11 && max <= 24 && chroma <= 20
      : luma <= 17 && max <= 32 && chroma <= 24;
  };
  const enqueue = (index: number, seed: boolean) => {
    if (visited[index] || !accepts(index, seed)) return;
    visited[index] = 1;
    queue[tail] = index;
    tail += 1;
  };
  for (let x = 0; x < width; x += 1) {
    enqueue(x, true);
    enqueue((height - 1) * width + x, true);
  }
  for (let y = 1; y < height - 1; y += 1) {
    enqueue(y * width, true);
    enqueue(y * width + width - 1, true);
  }
  while (head < tail) {
    const current = queue[head];
    head += 1;
    const x = current % width;
    const y = Math.floor(current / width);
    if (x > 0) enqueue(current - 1, false);
    if (x < width - 1) enqueue(current + 1, false);
    if (y > 0) enqueue(current - width, false);
    if (y < height - 1) enqueue(current + width, false);
  }
  let changedPixels = 0;
  for (let index = 0; index < tail; index += 1) {
    const offset = queue[index] * 4;
    if (
      output.data[offset] !== 0 ||
      output.data[offset + 1] !== 0 ||
      output.data[offset + 2] !== 0 ||
      output.data[offset + 3] !== 0
    )
      changedPixels += 1;
    output.data[offset] = 0;
    output.data[offset + 1] = 0;
    output.data[offset + 2] = 0;
    output.data[offset + 3] = 0;
  }
  return { imageData: output, changedPixels };
}

/**
 * Turns a packed linear-depth capture into a geometry-only coverage mask.
 * Depth captures clear pixels without geometry to opaque white. Using this
 * signal instead of source colour keeps dark, edge-connected recesses inside
 * the model paintable while still excluding the generated backdrop.
 */
export function createPackedDepthVisibilityMask(depthImageData: ImageData) {
  const { width, height, data } = depthImageData;
  const output = new ImageData(width, height);
  for (let offset = 0; offset < data.length; offset += 4) {
    const isClearPixel = data[offset] >= 254 && data[offset + 1] >= 254 && data[offset + 2] >= 254;
    output.data[offset] = 255;
    output.data[offset + 1] = 255;
    output.data[offset + 2] = 255;
    output.data[offset + 3] = isClearPixel ? 0 : 255;
  }
  return output;
}

function isBackgroundSeed(data: Uint8ClampedArray, offset: number, mode: BackgroundRemovalMode) {
  const { alpha, max, min, chroma, luma } = getTone(data, offset);
  if (alpha <= 32) return true;
  const black = luma <= 28 && max <= 42 && chroma <= 24;
  const white = luma >= 238 && min >= 224 && chroma <= 30;
  return black || (mode === 'neutral' && white);
}

function isBackgroundCandidate(
  data: Uint8ClampedArray,
  offset: number,
  mode: BackgroundRemovalMode,
) {
  const { alpha, max, min, chroma, luma } = getTone(data, offset);
  if (alpha <= 64) return true;
  const black = luma <= 58 && max <= 82 && chroma <= 36;
  const white = luma >= 208 && min >= 190 && chroma <= 52;
  return black || (mode === 'neutral' && white);
}

export function removeEdgeConnectedNeutralBackground(
  imageData: ImageData,
  mode: BackgroundRemovalMode,
) {
  const { width, height } = imageData;
  const output = new ImageData(new Uint8ClampedArray(imageData.data), width, height);
  const visited = new Uint8Array(width * height);
  const queue = new Int32Array(width * height);
  let head = 0;
  let tail = 0;
  let removedOpaquePixels = 0;
  let hadTransparency = false;
  for (let offset = 3; offset < output.data.length; offset += 4) {
    if (output.data[offset] < 250) {
      hadTransparency = true;
      break;
    }
  }

  const enqueueSeed = (index: number) => {
    if (visited[index] || !isBackgroundSeed(output.data, index * 4, mode)) return;
    visited[index] = 1;
    queue[tail] = index;
    tail += 1;
  };
  for (let x = 0; x < width; x += 1) {
    enqueueSeed(x);
    enqueueSeed((height - 1) * width + x);
  }
  for (let y = 1; y < height - 1; y += 1) {
    enqueueSeed(y * width);
    enqueueSeed(y * width + width - 1);
  }

  while (head < tail) {
    const current = queue[head];
    head += 1;
    if (output.data[current * 4 + 3] > 64) removedOpaquePixels += 1;
    output.data[current * 4 + 3] = 0;
    const x = current % width;
    const y = Math.floor(current / width);
    const neighbors = [
      x > 0 ? current - 1 : -1,
      x < width - 1 ? current + 1 : -1,
      y > 0 ? current - width : -1,
      y < height - 1 ? current + width : -1,
    ];
    for (const neighbor of neighbors) {
      if (
        neighbor < 0 ||
        visited[neighbor] ||
        !isBackgroundCandidate(output.data, neighbor * 4, mode)
      )
        continue;
      visited[neighbor] = 1;
      queue[tail] = neighbor;
      tail += 1;
    }
  }

  // Closed silhouettes (for example a ring-shaped texture result) can trap the
  // same black/white backdrop inside the subject. Remove only large detached
  // neutral regions so small dark or light material details remain intact.
  const minimumDetachedRegionSize = Math.max(64, Math.floor(width * height * 0.0025));
  for (let index = 0; index < width * height; index += 1) {
    if (visited[index] || !isBackgroundSeed(output.data, index * 4, mode)) continue;
    head = 0;
    tail = 0;
    visited[index] = 1;
    queue[tail] = index;
    tail += 1;
    while (head < tail) {
      const current = queue[head];
      head += 1;
      const x = current % width;
      const y = Math.floor(current / width);
      const neighbors = [
        x > 0 ? current - 1 : -1,
        x < width - 1 ? current + 1 : -1,
        y > 0 ? current - width : -1,
        y < height - 1 ? current + width : -1,
      ];
      for (const neighbor of neighbors) {
        if (
          neighbor < 0 ||
          visited[neighbor] ||
          !isBackgroundCandidate(output.data, neighbor * 4, mode)
        )
          continue;
        visited[neighbor] = 1;
        queue[tail] = neighbor;
        tail += 1;
      }
    }
    if (tail < minimumDetachedRegionSize) continue;
    for (let queueIndex = 0; queueIndex < tail; queueIndex += 1) {
      const pixel = queue[queueIndex];
      if (output.data[pixel * 4 + 3] > 64) removedOpaquePixels += 1;
      output.data[pixel * 4 + 3] = 0;
    }
  }
  return { imageData: output, removedOpaquePixels, hadTransparency };
}

function getAlphaContentBounds(imageData: ImageData) {
  const { width, height, data } = imageData;
  const columns = new Uint32Array(width);
  const rows = new Uint32Array(height);
  let total = 0;
  for (let y = 0; y < height; y += 1) {
    const rowOffset = y * width;
    for (let x = 0; x < width; x += 1) {
      if (data[(rowOffset + x) * 4 + 3] <= 24) continue;
      columns[x] += 1;
      rows[y] += 1;
      total += 1;
    }
  }
  if (total === 0) return undefined;
  const trim = Math.floor(total * 0.0025);
  const findStart = (counts: Uint32Array) => {
    let accumulated = 0;
    for (let index = 0; index < counts.length; index += 1) {
      accumulated += counts[index];
      if (accumulated > trim) return index;
    }
    return 0;
  };
  const findEnd = (counts: Uint32Array) => {
    let accumulated = 0;
    for (let index = counts.length - 1; index >= 0; index -= 1) {
      accumulated += counts[index];
      if (accumulated > trim) return index;
    }
    return counts.length - 1;
  };
  const left = findStart(columns);
  const right = findEnd(columns);
  const top = findStart(rows);
  const bottom = findEnd(rows);
  return {
    x: left,
    y: top,
    width: Math.max(1, right - left + 1),
    height: Math.max(1, bottom - top + 1),
  };
}

function getExactAlphaContentBounds(imageData: ImageData) {
  const { width, height, data } = imageData;
  let left = width;
  let top = height;
  let right = -1;
  let bottom = -1;
  for (let y = 0; y < height; y += 1) {
    const rowOffset = y * width * 4 + 3;
    let first = 0;
    while (first < width && data[rowOffset + first * 4] === 0) first += 1;
    if (first === width) continue;
    let last = width - 1;
    while (last > first && data[rowOffset + last * 4] === 0) last -= 1;
    // Only the first/last nonzero alpha in a row can extend its exact bounds.
    // Interior gaps and faint nonzero alpha retain the original semantics.
    left = Math.min(left, first);
    right = Math.max(right, last);
    top = Math.min(top, y);
    bottom = y;
  }
  if (right < left || bottom < top) return undefined;
  return { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
}

function paddedDisplayBounds(source: ImageData, bounds: { x: number; y: number; width: number; height: number }, padding: number) {
  const x = Math.max(0, bounds.x - padding);
  const y = Math.max(0, bounds.y - padding);
  return [x, y,
    Math.max(1, Math.min(source.width, bounds.x + bounds.width + padding) - x),
    Math.max(1, Math.min(source.height, bounds.y + bounds.height + padding) - y),
  ] as const;
}

// Both display paths use the same unscaled canvas crop. Keep their distinct
// bounds, padding and missing-context fallback decisions in their callers.
function cropDisplayImage(image: ImageData, x: number, y: number, width: number, height: number) {
  const source = document.createElement('canvas');
  const output = document.createElement('canvas');
  try {
    source.width = image.width;
    source.height = image.height;
    const sourceContext = source.getContext('2d');
    if (!sourceContext) return undefined;
    sourceContext.putImageData(image, 0, 0);
    output.width = width;
    output.height = height;
    const context = output.getContext('2d', { willReadFrequently: true });
    if (!context) return undefined;
    context.drawImage(source, x, y, width, height, 0, 0, width, height);
    return context.getImageData(0, 0, width, height);
  } finally {
    source.width = output.width = 0;
  }
}

function encodeDisplayImage(imageData: ImageData) {
  return imageDataToBlob(imageData).then(blobToDataUrl);
}

async function createGeneratedDisplayPreviewUncached(
  sourceUrl: string,
  depthUrl?: string,
  signal?: AbortSignal,
): Promise<GeneratedDisplayPreview> {
  const checkpoint = async () => {
    signal?.throwIfAborted();
    // An idle check can resolve immediately. Cross a presentation boundary so
    // resize, masking, bounds and PNG preparation cannot form one long task.
    await waitForBrowserPaint();
    await waitForViewportInteractionIdle();
    signal?.throwIfAborted();
  };
  const readOptions = { cooperative: true, signal };
  const decoded = await urlToImageData(sourceUrl, undefined, undefined, readOptions);
  await checkpoint();
  const scale = Math.min(
    1,
    GENERATED_DISPLAY_MAX_DIMENSION / Math.max(decoded.width, decoded.height, 1),
  );
  const source =
    scale < 1
      ? resizeImageData(
          decoded,
          Math.max(1, Math.round(decoded.width * scale)),
          Math.max(1, Math.round(decoded.height * scale)),
        )
      : decoded;
  await checkpoint();
  let processed: ReturnType<typeof removeStrictOuterDarkDisplayBackground>;
  if (depthUrl) {
    try {
      const depth = await urlToImageData(depthUrl, source.width, source.height, readOptions);
      await checkpoint();
      processed = applyPackedDepthDisplayMask(source, depth);
    } catch {
      signal?.throwIfAborted();
      // Depth is the safest display authority, but old/expired project assets must
      // still render. The fallback only clears an edge-connected, nearly-black
      // outer region and never runs a second matte over the generated subject.
      processed = removeStrictOuterDarkDisplayBackground(source);
    }
  } else {
    processed = removeStrictOuterDarkDisplayBackground(source);
  }
  const transparent = processed.imageData;
  await checkpoint();
  const bounds = getExactAlphaContentBounds(transparent);
  if (!bounds) return { alignedUrl: sourceUrl, fittedUrl: sourceUrl };

  const alignedUrl =
    processed.changedPixels > 0 || scale < 1
      ? await encodeDisplayImage(transparent)
      : sourceUrl;
  await checkpoint();
  const padding = Math.max(
    4,
    Math.round(Math.max(bounds.width, bounds.height) * GENERATED_DISPLAY_PADDING_RATIO),
  );
  const [cropX, cropY, cropWidth, cropHeight] = paddedDisplayBounds(source, bounds, padding);
  if (cropWidth === source.width && cropHeight === source.height)
    return { alignedUrl, fittedUrl: alignedUrl };

  const fitted = cropDisplayImage(transparent, cropX, cropY, cropWidth, cropHeight);
  return { alignedUrl, fittedUrl: fitted ? await encodeDisplayImage(fitted) : alignedUrl };
}

export function createGeneratedDisplayPreview(
  sourceUrl: string, depthUrl?: string, request: DisplayPreviewRequest = {},
) {
  return requestDisplayPreview(
    JSON.stringify(['display', sourceUrl, depthUrl, request.revision]),
    (signal) => createGeneratedDisplayPreviewUncached(sourceUrl, depthUrl, signal),
    request.signal,
  );
}

// Only 48px layer rows consume this bounded cache. Zoom previews and all
// production assets retain their original dimensions and processing path.
const requestLayerThumbnail = createDisplayPreviewQueue(4 * 1024 * 1024, 128);
export function createLayerThumbnail(
  sourceUrl: string, depthUrl?: string, request: DisplayPreviewRequest = {}, projected = true,
) {
  return requestLayerThumbnail(JSON.stringify([sourceUrl, depthUrl, request.revision, projected]), async (signal) => {
    const url = projected
      ? (await createGeneratedDisplayPreview(sourceUrl, depthUrl, { ...request, signal })).fittedUrl
      : sourceUrl;
    const pixels = await urlToImageData(url, undefined, undefined, { cooperative: true, signal, maxSize: 128 });
    signal.throwIfAborted();
    const thumbnail = await encodeDisplayImage(pixels);
    return { alignedUrl: thumbnail, fittedUrl: thumbnail };
  }, request.signal);
}

function smoothstep(edge0: number, edge1: number, value: number) {
  const t = Math.min(1, Math.max(0, (value - edge0) / Math.max(1e-6, edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/**
 * Applies the geometry capture mask while replacing background-contaminated
 * silhouette RGB with a nearby interior colour. Keeping the antialiased alpha
 * but decontaminating its RGB prevents a dark halo over the preview checkerboard.
 */
export function applyCapturePreviewMask(source: ImageData, mask: ImageData) {
  const { width, height } = source;
  if (mask.width !== width || mask.height !== height)
    throw new Error('Capture preview mask dimensions must match the source image.');

  const output = new ImageData(new Uint8ClampedArray(source.data), width, height);
  const coverage = new Uint8Array(width * height);
  for (let index = 0; index < coverage.length; index += 1) {
    const offset = index * 4;
    const maskLuminance =
      mask.data[offset] * 0.299 + mask.data[offset + 1] * 0.587 + mask.data[offset + 2] * 0.114;
    coverage[index] = Math.round(maskLuminance * (mask.data[offset + 3] / 255));
  }

  const coverageAt = (x: number, y: number) => {
    const clampedX = Math.min(width - 1, Math.max(0, x));
    const clampedY = Math.min(height - 1, Math.max(0, y));
    return coverage[clampedY * width + clampedX];
  };
  const sourceChannelAt = (x: number, y: number, channel: number) => {
    const clampedX = Math.min(width - 1, Math.max(0, x));
    const clampedY = Math.min(height - 1, Math.max(0, y));
    return source.data[(clampedY * width + clampedX) * 4 + channel];
  };
  const sampleSourceChannel = (x: number, y: number, channel: number) => {
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const x1 = x0 + 1;
    const y1 = y0 + 1;
    const tx = x - x0;
    const ty = y - y0;
    const top = sourceChannelAt(x0, y0, channel) * (1 - tx) + sourceChannelAt(x1, y0, channel) * tx;
    const bottom =
      sourceChannelAt(x0, y1, channel) * (1 - tx) + sourceChannelAt(x1, y1, channel) * tx;
    return top * (1 - ty) + bottom * ty;
  };

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      const offset = index * 4;
      const maskCoverage = coverage[index] / 255;
      const nextAlpha = Math.round(source.data[offset + 3] * maskCoverage);
      output.data[offset + 3] = nextAlpha;
      if (nextAlpha <= 0) {
        output.data[offset] = 0;
        output.data[offset + 1] = 0;
        output.data[offset + 2] = 0;
        continue;
      }

      const gradientX =
        coverageAt(x + CAPTURE_PREVIEW_EDGE_DETECT_RADIUS, y) -
        coverageAt(x - CAPTURE_PREVIEW_EDGE_DETECT_RADIUS, y);
      const gradientY =
        coverageAt(x, y + CAPTURE_PREVIEW_EDGE_DETECT_RADIUS) -
        coverageAt(x, y - CAPTURE_PREVIEW_EDGE_DETECT_RADIUS);
      const gradientLength = Math.hypot(gradientX, gradientY);
      const edgeMix = smoothstep(
        CAPTURE_PREVIEW_EDGE_GRADIENT_START,
        CAPTURE_PREVIEW_EDGE_GRADIENT_END,
        gradientLength,
      );
      if (edgeMix <= 0) continue;

      const pullX = x + (gradientX / gradientLength) * CAPTURE_PREVIEW_EDGE_PULL_DISTANCE;
      const pullY = y + (gradientY / gradientLength) * CAPTURE_PREVIEW_EDGE_PULL_DISTANCE;
      for (let channel = 0; channel < 3; channel += 1) {
        const interior = sampleSourceChannel(pullX, pullY, channel);
        output.data[offset + channel] = Math.round(
          source.data[offset + channel] * (1 - edgeMix) + interior * edgeMix,
        );
      }
    }
  }
  return output;
}

/**
 * Produces a projection-safe counterpart of the cropped panel preview. The
 * image stays at the capture resolution so projected UVs remain unchanged,
 * while cleaned silhouette colours are bled into the masked-out background.
 * The projected material owns coverage through its separate capture mask, so
 * this colour image is intentionally opaque to keep browsers from discarding
 * useful RGB stored under transparent pixels during PNG encoding.
 */
export function applyCaptureProjectionImage(
  source: ImageData,
  mask: ImageData,
) {
  const { width, height } = source;
  if (mask.width !== width || mask.height !== height)
    throw new Error('Capture projection mask dimensions must match the source image.');

  const cleaned = applyCapturePreviewMask(source, mask);
  const output = new ImageData(new Uint8ClampedArray(source.data), width, height);
  const coverage = new Uint8Array(width * height);
  for (let index = 0; index < coverage.length; index += 1) {
    const offset = index * 4;
    const maskLuminance =
      mask.data[offset] * 0.299 + mask.data[offset + 1] * 0.587 + mask.data[offset + 2] * 0.114;
    coverage[index] = Math.round(maskLuminance * (mask.data[offset + 3] / 255));
    output.data[offset + 3] = 255;
    if (coverage[index] <= 0) continue;
    output.data[offset] = cleaned.data[offset];
    output.data[offset + 1] = cleaned.data[offset + 1];
    output.data[offset + 2] = cleaned.data[offset + 2];
  }

  // A bounded breadth-first dilation is linear in the number of pixels in the
  // edge band, unlike repeatedly scanning the full 2K/4K frame. The band is
  // wide enough to survive minification/mipmap sampling but never changes the
  // projection footprint because the separate mask remains authoritative.
  const maximumBleedDistance = Math.min(
    48,
    Math.max(8, Math.round(Math.max(width, height) * 0.015)),
  );
  const distances = new Uint16Array(width * height);
  const queue = new Int32Array(width * height);
  let head = 0;
  let tail = 0;
  const isOutside = (x: number, y: number) =>
    x < 0 || x >= width || y < 0 || y >= height || coverage[y * width + x] <= 0;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      if (
        coverage[index] <= 0 ||
        (!isOutside(x - 1, y) &&
          !isOutside(x + 1, y) &&
          !isOutside(x, y - 1) &&
          !isOutside(x, y + 1))
      )
        continue;
      distances[index] = 1;
      queue[tail] = index;
      tail += 1;
    }
  }

  const neighborOffsets = [
    [-1, -1],
    [0, -1],
    [1, -1],
    [-1, 0],
    [1, 0],
    [-1, 1],
    [0, 1],
    [1, 1],
  ] as const;

  while (head < tail) {
    const current = queue[head];
    head += 1;
    const distance = distances[current];
    if (distance > maximumBleedDistance) continue;
    const x = current % width;
    const y = Math.floor(current / width);
    const sourceOffset = current * 4;
    for (const [offsetX, offsetY] of neighborOffsets) {
      const neighborX = x + offsetX;
      const neighborY = y + offsetY;
      if (neighborX < 0 || neighborX >= width || neighborY < 0 || neighborY >= height) continue;
      const neighbor = neighborY * width + neighborX;
      if (coverage[neighbor] > 0 || distances[neighbor] !== 0) continue;
      const neighborOffset = neighbor * 4;
      output.data[neighborOffset] = output.data[sourceOffset];
      output.data[neighborOffset + 1] = output.data[sourceOffset + 1];
      output.data[neighborOffset + 2] = output.data[sourceOffset + 2];
      output.data[neighborOffset + 3] = 255;
      distances[neighbor] = distance + 1;
      queue[tail] = neighbor;
      tail += 1;
    }
  }
  return output;
}

async function createPreviewUncached(sourceUrl: string, mode: BackgroundRemovalMode) {
  const source = await urlToImageData(sourceUrl);
  const backgroundResult = removeEdgeConnectedNeutralBackground(source, mode);
  const transparent = backgroundResult.imageData;
  const bounds = getAlphaContentBounds(transparent);
  if (!bounds) return sourceUrl;

  const padding = Math.max(
    2,
    Math.round(Math.max(bounds.width, bounds.height) * SUBJECT_PADDING_RATIO),
  );
  const [cropX, cropY, cropWidth, cropHeight] = paddedDisplayBounds(source, bounds, padding);

  // Avoid a needless PNG re-encode when the returned image is already opaque and tightly framed.
  if (
    backgroundResult.removedOpaquePixels === 0 &&
    !backgroundResult.hadTransparency &&
    cropWidth >= source.width * 0.9 &&
    cropHeight >= source.height * 0.9
  )
    return sourceUrl;

  const sourceCanvas = document.createElement('canvas');
  sourceCanvas.width = source.width;
  sourceCanvas.height = source.height;
  const sourceContext = sourceCanvas.getContext('2d');
  if (!sourceContext) return sourceUrl;
  sourceContext.putImageData(transparent, 0, 0);

  const outputCanvas = document.createElement('canvas');
  // The processed image is preview-only. Tight output dimensions let object-contain
  // fill the panel even when ComfyUI returned a wide frame around a tall subject.
  outputCanvas.width = cropWidth;
  outputCanvas.height = cropHeight;
  const outputContext = outputCanvas.getContext('2d', { willReadFrequently: true });
  if (!outputContext) return sourceUrl;
  outputContext.imageSmoothingEnabled = true;
  outputContext.imageSmoothingQuality = 'high';
  outputContext.clearRect(0, 0, cropWidth, cropHeight);
  outputContext.drawImage(
    sourceCanvas,
    cropX,
    cropY,
    cropWidth,
    cropHeight,
    0,
    0,
    cropWidth,
    cropHeight,
  );
  const output = outputContext.getImageData(0, 0, cropWidth, cropHeight);
  return encodeDisplayImage(output);
}

async function createCaptureMaskedPreviewUncached(sourceUrl: string, maskUrl: string, signal: AbortSignal) {
  const source = await urlToImageData(sourceUrl);
  await waitForViewportInteractionIdle();
  signal.throwIfAborted();
  const mask = await urlToImageData(maskUrl, source.width, source.height);
  await waitForViewportInteractionIdle();
  signal.throwIfAborted();
  const masked = applyCapturePreviewMask(source, mask);

  const bounds = getAlphaContentBounds(masked);
  if (!bounds) return sourceUrl;
  const padding = Math.max(
    2,
    Math.round(Math.max(bounds.width, bounds.height) * SUBJECT_PADDING_RATIO),
  );
  const [cropX, cropY, cropWidth, cropHeight] = paddedDisplayBounds(source, bounds, padding);

  const fitted = cropDisplayImage(masked, cropX, cropY, cropWidth, cropHeight);
  return fitted ? encodeDisplayImage(fitted) : sourceUrl;
}

export function createCaptureMaskedPreview(sourceUrl: string, maskUrl: string, request: DisplayPreviewRequest = {}) {
  return requestDisplayPreview(
    JSON.stringify(['capture', sourceUrl, maskUrl, request.revision]),
    async (signal) => {
      const url = await createCaptureMaskedPreviewUncached(sourceUrl, maskUrl, signal);
      return { alignedUrl: url, fittedUrl: url };
    },
    request.signal,
  ).then((preview) => preview.fittedUrl);
}

async function createCaptureMaskedProjectionImageUncached(
  sourceUrl: string,
  maskUrl: string,
) {
  const source = await urlToImageData(sourceUrl);
  const mask = await urlToImageData(maskUrl, source.width, source.height);
  return encodeDisplayImage(applyCaptureProjectionImage(source, mask));
}

export function createCaptureMaskedProjectionImage(
  sourceUrl: string,
  maskUrl: string,
) {
  const cacheKey = sourceUrl;
  const cached = captureMaskedProjectionCache.get(cacheKey);
  if (cached?.maskUrl === maskUrl) return cached.promise;
  const promise = createCaptureMaskedProjectionImageUncached(sourceUrl, maskUrl).catch((error) => {
    if (captureMaskedProjectionCache.get(cacheKey)?.promise === promise)
      captureMaskedProjectionCache.delete(cacheKey);
    throw error;
  });
  captureMaskedProjectionCache.set(cacheKey, { maskUrl, promise });
  while (captureMaskedProjectionCache.size > MAX_PREVIEW_CACHE_ENTRIES) {
    const oldestKey = captureMaskedProjectionCache.keys().next().value as string | undefined;
    if (!oldestKey) break;
    captureMaskedProjectionCache.delete(oldestKey);
  }
  return promise;
}

export function createSubjectFilledPreview(
  sourceUrl: string,
  mode: BackgroundRemovalMode = 'neutral',
) {
  const cacheKey = `${mode}:${sourceUrl}`;
  const cached = previewCache.get(cacheKey);
  if (cached) return cached;
  const promise = createPreviewUncached(sourceUrl, mode).catch((error) => {
    if (previewCache.get(cacheKey) === promise) previewCache.delete(cacheKey);
    throw error;
  });
  previewCache.set(cacheKey, promise);
  while (previewCache.size > MAX_PREVIEW_CACHE_ENTRIES) {
    const oldestKey = previewCache.keys().next().value as string | undefined;
    if (!oldestKey) break;
    previewCache.delete(oldestKey);
  }
  return promise;
}
