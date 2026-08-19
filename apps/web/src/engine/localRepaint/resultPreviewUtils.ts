import { blobToDataUrl, imageDataToBlob, urlToImageData } from './imageUtils';

const previewCache = new Map<string, Promise<string>>();
const captureMaskedPreviewCache = new Map<
  string,
  { maskUrl: string; promise: Promise<string> }
>();
const MAX_PREVIEW_CACHE_ENTRIES = 12;
const SUBJECT_PADDING_RATIO = 0.02;

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

function isBackgroundSeed(
  data: Uint8ClampedArray,
  offset: number,
  mode: BackgroundRemovalMode,
) {
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

/**
 * Build a soft mask that never grows beyond the authored selection. An
 * eight-neighbour distance field keeps the work linear in pixel count and
 * produces a uniform, direction-independent transition toward the interior.
 */
export function createInwardFeatheredMask(imageData: ImageData, radius: number) {
  const { width, height, data } = imageData;
  const originalCoverage = new Uint8ClampedArray(width * height);
  const distance = new Float32Array(width * height);
  const output = new ImageData(width, height);
  const infinity = width + height + 1;
  const diagonal = Math.SQRT2;

  for (let index = 0; index < originalCoverage.length; index += 1) {
    const offset = index * 4;
    const coverage = Math.round(
      Math.max(data[offset], data[offset + 1], data[offset + 2]) *
        (data[offset + 3] / 255),
    );
    originalCoverage[index] = coverage;
    distance[index] = coverage > 0 ? infinity : 0;
    output.data[offset] = 255;
    output.data[offset + 1] = 255;
    output.data[offset + 2] = 255;
  }

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      if (distance[index] === 0) continue;
      let value =
        x === 0 || y === 0 || x === width - 1 || y === height - 1
          ? 1
          : distance[index];
      if (x > 0) value = Math.min(value, distance[index - 1] + 1);
      if (y > 0) value = Math.min(value, distance[index - width] + 1);
      if (x > 0 && y > 0)
        value = Math.min(value, distance[index - width - 1] + diagonal);
      if (x + 1 < width && y > 0)
        value = Math.min(value, distance[index - width + 1] + diagonal);
      distance[index] = value;
    }
  }

  for (let y = height - 1; y >= 0; y -= 1) {
    for (let x = width - 1; x >= 0; x -= 1) {
      const index = y * width + x;
      if (distance[index] === 0) continue;
      let value = distance[index];
      if (x + 1 < width) value = Math.min(value, distance[index + 1] + 1);
      if (y + 1 < height) value = Math.min(value, distance[index + width] + 1);
      if (x + 1 < width && y + 1 < height)
        value = Math.min(value, distance[index + width + 1] + diagonal);
      if (x > 0 && y + 1 < height)
        value = Math.min(value, distance[index + width - 1] + diagonal);
      distance[index] = value;
    }
  }

  const featherRadius = Math.max(1, radius);
  for (let index = 0; index < originalCoverage.length; index += 1) {
    const normalized = Math.max(0, Math.min(1, distance[index] / featherRadius));
    const smoothCoverage = normalized * normalized * (3 - 2 * normalized);
    output.data[index * 4 + 3] = Math.round(originalCoverage[index] * smoothCoverage);
  }
  return output;
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
  const cropX = Math.max(0, bounds.x - padding);
  const cropY = Math.max(0, bounds.y - padding);
  const cropRight = Math.min(source.width, bounds.x + bounds.width + padding);
  const cropBottom = Math.min(source.height, bounds.y + bounds.height + padding);
  const cropWidth = Math.max(1, cropRight - cropX);
  const cropHeight = Math.max(1, cropBottom - cropY);

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
  return blobToDataUrl(await imageDataToBlob(output));
}

async function createCaptureMaskedPreviewUncached(sourceUrl: string, maskUrl: string) {
  const source = await urlToImageData(sourceUrl);
  const mask = await urlToImageData(maskUrl, source.width, source.height);
  const masked = new ImageData(new Uint8ClampedArray(source.data), source.width, source.height);
  for (let offset = 0; offset < masked.data.length; offset += 4) {
    const maskLuminance =
      mask.data[offset] * 0.299 + mask.data[offset + 1] * 0.587 + mask.data[offset + 2] * 0.114;
    const maskCoverage = (maskLuminance / 255) * (mask.data[offset + 3] / 255);
    const nextAlpha = Math.round(masked.data[offset + 3] * maskCoverage);
    masked.data[offset + 3] = nextAlpha;
    if (nextAlpha > 0) continue;
    masked.data[offset] = 0;
    masked.data[offset + 1] = 0;
    masked.data[offset + 2] = 0;
  }

  const bounds = getAlphaContentBounds(masked);
  if (!bounds) return sourceUrl;
  const padding = Math.max(
    2,
    Math.round(Math.max(bounds.width, bounds.height) * SUBJECT_PADDING_RATIO),
  );
  const cropX = Math.max(0, bounds.x - padding);
  const cropY = Math.max(0, bounds.y - padding);
  const cropRight = Math.min(source.width, bounds.x + bounds.width + padding);
  const cropBottom = Math.min(source.height, bounds.y + bounds.height + padding);
  const cropWidth = Math.max(1, cropRight - cropX);
  const cropHeight = Math.max(1, cropBottom - cropY);

  const sourceCanvas = document.createElement('canvas');
  sourceCanvas.width = source.width;
  sourceCanvas.height = source.height;
  const sourceContext = sourceCanvas.getContext('2d');
  if (!sourceContext) return sourceUrl;
  sourceContext.putImageData(masked, 0, 0);

  const outputCanvas = document.createElement('canvas');
  outputCanvas.width = cropWidth;
  outputCanvas.height = cropHeight;
  const outputContext = outputCanvas.getContext('2d', { willReadFrequently: true });
  if (!outputContext) return sourceUrl;
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
  return blobToDataUrl(
    await imageDataToBlob(outputContext.getImageData(0, 0, cropWidth, cropHeight)),
  );
}

export function createCaptureMaskedPreview(sourceUrl: string, maskUrl: string) {
  const cached = captureMaskedPreviewCache.get(sourceUrl);
  if (cached?.maskUrl === maskUrl) return cached.promise;
  const promise = createCaptureMaskedPreviewUncached(sourceUrl, maskUrl).catch((error) => {
    if (captureMaskedPreviewCache.get(sourceUrl)?.promise === promise)
      captureMaskedPreviewCache.delete(sourceUrl);
    throw error;
  });
  captureMaskedPreviewCache.set(sourceUrl, { maskUrl, promise });
  while (captureMaskedPreviewCache.size > MAX_PREVIEW_CACHE_ENTRIES) {
    const oldestKey = captureMaskedPreviewCache.keys().next().value as string | undefined;
    if (!oldestKey) break;
    captureMaskedPreviewCache.delete(oldestKey);
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
