type GenerationInputWorkerRequest = {
  id: number;
  currentEffect: ImageBitmap;
  clayPreview: ImageBitmap;
  authoredMask: ImageBitmap;
};

type GenerationInputWorkerResponse =
  | {
      id: number;
      compositeBlob: Blob;
      submittedMaskBlob: Blob;
      dilationRadius: number;
      featherRadius: number;
      processMs: number;
    }
  | { id: number; error: string };

function readPixels(bitmap: ImageBitmap, width: number, height: number) {
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('Could not read a local repaint input image.');
  context.clearRect(0, 0, width, height);
  context.drawImage(bitmap, 0, 0, width, height);
  return context.getImageData(0, 0, width, height);
}

function maxFilterHorizontal(source: Uint8Array, width: number, height: number, radius: number) {
  const output = new Uint8Array(source.length);
  const queue = new Int32Array(width);
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    let head = 0;
    let tail = 0;
    let addedThrough = -1;
    for (let x = 0; x < width; x += 1) {
      const addUntil = Math.min(width - 1, x + radius);
      while (addedThrough < addUntil) {
        addedThrough += 1;
        const value = source[row + addedThrough];
        while (tail > head && source[row + queue[tail - 1]] <= value) tail -= 1;
        queue[tail] = addedThrough;
        tail += 1;
      }
      const minimum = x - radius;
      while (tail > head && queue[head] < minimum) head += 1;
      output[row + x] = source[row + queue[head]];
    }
  }
  return output;
}

function maxFilterVertical(source: Uint8Array, width: number, height: number, radius: number) {
  const output = new Uint8Array(source.length);
  const queue = new Int32Array(height);
  for (let x = 0; x < width; x += 1) {
    let head = 0;
    let tail = 0;
    let addedThrough = -1;
    for (let y = 0; y < height; y += 1) {
      const addUntil = Math.min(height - 1, y + radius);
      while (addedThrough < addUntil) {
        addedThrough += 1;
        const value = source[addedThrough * width + x];
        while (tail > head && source[queue[tail - 1] * width + x] <= value) tail -= 1;
        queue[tail] = addedThrough;
        tail += 1;
      }
      const minimum = y - radius;
      while (tail > head && queue[head] < minimum) head += 1;
      output[y * width + x] = source[queue[head] * width + x];
    }
  }
  return output;
}

function dilateMask(source: Uint8Array, width: number, height: number, radius: number) {
  if (radius <= 0) return new Uint8Array(source);
  return maxFilterVertical(maxFilterHorizontal(source, width, height, radius), width, height, radius);
}

function erodeMask(source: Uint8Array, width: number, height: number, radius: number) {
  if (radius <= 0) return new Uint8Array(source);
  const inverted = new Uint8Array(source.length);
  for (let index = 0; index < source.length; index += 1) inverted[index] = 255 - source[index];
  const expandedBackground = dilateMask(inverted, width, height, radius);
  for (let index = 0; index < source.length; index += 1) inverted[index] = 255 - expandedBackground[index];
  return inverted;
}

function getMaskBounds(mask: Uint8Array, width: number, height: number) {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let index = 0; index < mask.length; index += 1) {
    if (mask[index] === 0) continue;
    const x = index % width;
    const y = Math.floor(index / width);
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return { minX, minY, maxX, maxY };
}

function fillSmallMaskHoles(
  source: Uint8Array,
  width: number,
  height: number,
  maximumHoleArea: number,
) {
  const output = new Uint8Array(source);
  const bounds = getMaskBounds(source, width, height);
  if (bounds.maxX < bounds.minX || bounds.maxY < bounds.minY) return output;
  const visited = new Uint8Array(source.length);
  const queue = new Int32Array(source.length);
  const neighborOffsets = [-1, 1, -width, width];
  for (let y = bounds.minY; y <= bounds.maxY; y += 1) {
    for (let x = bounds.minX; x <= bounds.maxX; x += 1) {
      const origin = y * width + x;
      if (source[origin] !== 0 || visited[origin] !== 0) continue;
      let head = 0;
      let tail = 0;
      let touchesBoundary = false;
      queue[tail++] = origin;
      visited[origin] = 1;
      while (head < tail) {
        const index = queue[head++];
        const currentX = index % width;
        const currentY = Math.floor(index / width);
        if (
          currentX === bounds.minX ||
          currentX === bounds.maxX ||
          currentY === bounds.minY ||
          currentY === bounds.maxY
        ) {
          touchesBoundary = true;
        }
        for (const neighborOffset of neighborOffsets) {
          const neighbor = index + neighborOffset;
          const neighborX = neighbor % width;
          const neighborY = Math.floor(neighbor / width);
          if (
            neighbor < 0 ||
            neighbor >= source.length ||
            neighborX < bounds.minX ||
            neighborX > bounds.maxX ||
            neighborY < bounds.minY ||
            neighborY > bounds.maxY ||
            Math.abs(neighborX - currentX) + Math.abs(neighborY - currentY) !== 1 ||
            source[neighbor] !== 0 ||
            visited[neighbor] !== 0
          ) {
            continue;
          }
          visited[neighbor] = 1;
          queue[tail++] = neighbor;
        }
      }
      if (!touchesBoundary && tail <= maximumHoleArea) {
        for (let queueIndex = 0; queueIndex < tail; queueIndex += 1) output[queue[queueIndex]] = 255;
      }
    }
  }
  return output;
}

function buildCompositeCoreMask(
  authoredStrength: Uint8Array,
  width: number,
  height: number,
  scale: number,
) {
  const candidate = new Uint8Array(authoredStrength.length);
  const strong = new Uint8Array(authoredStrength.length);
  for (let index = 0; index < authoredStrength.length; index += 1) {
    if (authoredStrength[index] >= 24) candidate[index] = 255;
    if (authoredStrength[index] >= 96) strong[index] = 255;
  }
  const candidateBounds = getMaskBounds(candidate, width, height);
  if (candidateBounds.maxX < candidateBounds.minX || candidateBounds.maxY < candidateBounds.minY) {
    throw new Error('The authored local repaint mask is empty.');
  }
  const candidateWidth = candidateBounds.maxX - candidateBounds.minX + 1;
  const candidateHeight = candidateBounds.maxY - candidateBounds.minY + 1;
  const minimumDimension = Math.min(candidateWidth, candidateHeight);
  const minimumCloseRadius = Math.max(1, Math.round(2 * scale));
  const maximumCloseRadius = Math.max(minimumCloseRadius, Math.round(6 * scale));
  const closeRadius = Math.max(
    minimumCloseRadius,
    Math.min(maximumCloseRadius, Math.round(minimumDimension * 0.012)),
  );
  const closedCandidate = erodeMask(
    dilateMask(candidate, width, height, closeRadius),
    width,
    height,
    closeRadius,
  );
  for (let index = 0; index < candidate.length; index += 1) {
    if (candidate[index] > 0) closedCandidate[index] = 255;
  }

  const bboxArea = candidateWidth * candidateHeight;
  const minimumIslandArea = Math.max(
    4,
    Math.round(24 * scale * scale),
    Math.round(bboxArea * 0.0002),
  );
  const core = new Uint8Array(authoredStrength.length);
  const visited = new Uint8Array(authoredStrength.length);
  const queue = new Int32Array(authoredStrength.length);
  let keptPixelCount = 0;
  for (let origin = 0; origin < closedCandidate.length; origin += 1) {
    if (closedCandidate[origin] === 0 || visited[origin] !== 0) continue;
    let head = 0;
    let tail = 0;
    let strongPixelCount = 0;
    queue[tail++] = origin;
    visited[origin] = 1;
    while (head < tail) {
      const index = queue[head++];
      if (strong[index] > 0) strongPixelCount += 1;
      const currentX = index % width;
      const currentY = Math.floor(index / width);
      for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
        for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
          if (offsetX === 0 && offsetY === 0) continue;
          const neighborX = currentX + offsetX;
          const neighborY = currentY + offsetY;
          if (neighborX < 0 || neighborX >= width || neighborY < 0 || neighborY >= height) continue;
          const neighbor = neighborY * width + neighborX;
          if (closedCandidate[neighbor] === 0 || visited[neighbor] !== 0) continue;
          visited[neighbor] = 1;
          queue[tail++] = neighbor;
        }
      }
    }
    if (strongPixelCount === 0 || (tail < minimumIslandArea && bboxArea >= minimumIslandArea)) continue;
    for (let queueIndex = 0; queueIndex < tail; queueIndex += 1) core[queue[queueIndex]] = 255;
    keptPixelCount += tail;
  }
  if (keptPixelCount === 0) {
    for (let index = 0; index < strong.length; index += 1) core[index] = strong[index];
  }
  const maximumHoleArea = Math.max(
    16,
    Math.round(64 * scale * scale),
    Math.round(bboxArea * 0.0005),
  );
  return fillSmallMaskHoles(core, width, height, maximumHoleArea);
}

function boxBlur(source: Uint8Array, width: number, height: number, radius: number) {
  if (radius <= 0) return new Uint8Array(source);
  const horizontal = new Float32Array(source.length);
  const output = new Uint8Array(source.length);
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    let sum = 0;
    for (let x = 0; x <= Math.min(width - 1, radius); x += 1) sum += source[row + x];
    for (let x = 0; x < width; x += 1) {
      const left = Math.max(0, x - radius);
      const right = Math.min(width - 1, x + radius);
      if (x > 0) {
        const previousLeft = Math.max(0, x - radius - 1);
        const previousRight = Math.min(width - 1, x + radius - 1);
        if (left > previousLeft) sum -= source[row + previousLeft];
        if (right > previousRight) sum += source[row + right];
      }
      horizontal[row + x] = sum / (right - left + 1);
    }
  }
  for (let x = 0; x < width; x += 1) {
    let sum = 0;
    for (let y = 0; y <= Math.min(height - 1, radius); y += 1) sum += horizontal[y * width + x];
    for (let y = 0; y < height; y += 1) {
      const top = Math.max(0, y - radius);
      const bottom = Math.min(height - 1, y + radius);
      if (y > 0) {
        const previousTop = Math.max(0, y - radius - 1);
        const previousBottom = Math.min(height - 1, y + radius - 1);
        if (top > previousTop) sum -= horizontal[previousTop * width + x];
        if (bottom > previousBottom) sum += horizontal[bottom * width + x];
      }
      output[y * width + x] = Math.round(sum / (bottom - top + 1));
    }
  }
  return output;
}

function writeMaskPixels(mask: Uint8Array, width: number, height: number) {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < mask.length; index += 1) {
    const offset = index * 4;
    const value = mask[index];
    pixels[offset] = value;
    pixels[offset + 1] = value;
    pixels[offset + 2] = value;
    pixels[offset + 3] = 255;
  }
  return new ImageData(pixels, width, height);
}

self.onmessage = async (event: MessageEvent<GenerationInputWorkerRequest>) => {
  const { id, currentEffect, clayPreview, authoredMask } = event.data;
  const startedAt = performance.now();
  try {
    const width = currentEffect.width;
    const height = currentEffect.height;
    if (
      width <= 0 ||
      height <= 0 ||
      clayPreview.width !== width ||
      clayPreview.height !== height ||
      authoredMask.width !== width ||
      authoredMask.height !== height
    ) {
      throw new Error('Current effect, clay preview and authored mask must have identical dimensions.');
    }
    const currentPixels = readPixels(currentEffect, width, height);
    const clayPixels = readPixels(clayPreview, width, height);
    const maskPixels = readPixels(authoredMask, width, height);
    const authoredStrength = new Uint8Array(width * height);
    for (let index = 0; index < authoredStrength.length; index += 1) {
      const offset = index * 4;
      const value = Math.round(
        (Math.max(maskPixels.data[offset], maskPixels.data[offset + 1], maskPixels.data[offset + 2]) *
          maskPixels.data[offset + 3]) /
          255,
      );
      authoredStrength[index] = value;
    }

    const scale = Math.max(width, height) / 2048;
    const compositeCore = buildCompositeCoreMask(authoredStrength, width, height, scale);
    const coreBounds = getMaskBounds(compositeCore, width, height);
    if (coreBounds.maxX < coreBounds.minX || coreBounds.maxY < coreBounds.minY) {
      throw new Error('The authored local repaint mask is empty.');
    }
    const compositeEdgeRadius = Math.max(1, Math.round(1.5 * scale));
    const compositeAlpha = boxBlur(compositeCore, width, height, compositeEdgeRadius);
    for (let index = 0; index < compositeCore.length; index += 1) {
      if (compositeCore[index] > 0) compositeAlpha[index] = 255;
    }
    const minX = coreBounds.minX;
    const minY = coreBounds.minY;
    const maxX = coreBounds.maxX;
    const maxY = coreBounds.maxY;
    const minimumDimension = Math.min(maxX - minX + 1, maxY - minY + 1);
    const dilationRadius = Math.max(
      Math.round(24 * scale),
      Math.min(Math.round(64 * scale), Math.round(minimumDimension * 0.25)),
    );
    const featherRadius = Math.max(
      Math.round(4 * scale),
      Math.min(Math.round(10 * scale), Math.round(dilationRadius * 0.2)),
    );

    const compositePixels = new Uint8ClampedArray(currentPixels.data);
    for (let index = 0; index < compositeAlpha.length; index += 1) {
      const alpha = compositeAlpha[index] / 255;
      if (alpha <= 0) continue;
      const offset = index * 4;
      for (let channel = 0; channel < 4; channel += 1) {
        compositePixels[offset + channel] = Math.round(
          currentPixels.data[offset + channel] * (1 - alpha) +
            clayPixels.data[offset + channel] * alpha,
        );
      }
    }

    const dilated = dilateMask(compositeCore, width, height, dilationRadius);
    const submittedMask = boxBlur(dilated, width, height, featherRadius);
    for (let index = 0; index < compositeCore.length; index += 1) {
      if (compositeCore[index] > 0) submittedMask[index] = 255;
    }

    const compositeCanvas = new OffscreenCanvas(width, height);
    const compositeContext = compositeCanvas.getContext('2d');
    if (!compositeContext) throw new Error('Could not encode the local repaint composite.');
    compositeContext.putImageData(new ImageData(compositePixels, width, height), 0, 0);
    const maskCanvas = new OffscreenCanvas(width, height);
    const maskContext = maskCanvas.getContext('2d');
    if (!maskContext) throw new Error('Could not encode the submitted local repaint mask.');
    maskContext.putImageData(writeMaskPixels(submittedMask, width, height), 0, 0);
    const [compositeBlob, submittedMaskBlob] = await Promise.all([
      compositeCanvas.convertToBlob({ type: 'image/png' }),
      maskCanvas.convertToBlob({ type: 'image/png' }),
    ]);
    const response: GenerationInputWorkerResponse = {
      id,
      compositeBlob,
      submittedMaskBlob,
      dilationRadius,
      featherRadius,
      processMs: performance.now() - startedAt,
    };
    self.postMessage(response);
  } catch (error) {
    const response: GenerationInputWorkerResponse = {
      id,
      error: error instanceof Error ? error.message : String(error),
    };
    self.postMessage(response);
  } finally {
    currentEffect.close();
    clayPreview.close();
    authoredMask.close();
  }
};

export {};
