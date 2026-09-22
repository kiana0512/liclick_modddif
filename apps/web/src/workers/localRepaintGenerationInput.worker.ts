import { projectionGapMaskFromAlpha } from '../engine/projection/projectionCoverageContract.mjs';
import { composeGptRepaintGuide } from '../engine/localRepaint/gptGuide';

type GenerationInputWorkerRequest = {
  mode: 'local' | 'single' | 'gpt-local';
  id: number;
  currentEffect: ImageBitmap;
  clayPreview?: ImageBitmap;
  coverageDepth?: ImageBitmap;
  inputMask: ImageBitmap;
  whiteFill?: boolean;
  fullObject?: boolean;
};

type GenerationInputWorkerResponse =
  | {
      id: number;
      compositeBlob: Blob;
      submittedMaskBlob: Blob;
      selectionMaskBlob?: Blob;
      dilationRadius: number;
      featherRadius: number;
      processMs: number;
      phaseDurationsMs: Record<string, number>;
    }
  | {
      id: number;
      compositeBlob?: Blob;
      submittedMaskBlob?: Blob;
      hasVisibleTexture: boolean;
      uncoveredPixelCount: number;
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

function readObjectMask(bitmap: ImageBitmap, width: number, height: number) {
  const pixels = readPixels(bitmap, width, height);
  const data = new Uint8ClampedArray(width * height);
  for (let index = 0; index < data.length; index += 1) {
    const offset = index * 4;
    const value = Math.max(
      pixels.data[offset] ?? 0,
      pixels.data[offset + 1] ?? 0,
      pixels.data[offset + 2] ?? 0,
    );
    data[index] = value > 127 && (pixels.data[offset + 3] ?? 0) > 8 ? 255 : 0;
  }
  return { width, height, data };
}

type MaskBounds = { minX: number; minY: number; maxX: number; maxY: number };

function expandMaskBounds(
  bounds: MaskBounds,
  radius: number,
  width: number,
  height: number,
): MaskBounds {
  return {
    minX: Math.max(0, bounds.minX - radius),
    minY: Math.max(0, bounds.minY - radius),
    maxX: Math.min(width - 1, bounds.maxX + radius),
    maxY: Math.min(height - 1, bounds.maxY + radius),
  };
}

function maxFilterHorizontal(
  source: Uint8Array,
  width: number,
  height: number,
  radius: number,
  bounds?: MaskBounds,
) {
  const output = new Uint8Array(source.length);
  const queue = new Int32Array(width);
  const minY = bounds?.minY ?? 0;
  const maxY = bounds?.maxY ?? height - 1;
  for (let y = minY; y <= maxY; y += 1) {
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

function maxFilterVertical(
  source: Uint8Array,
  width: number,
  height: number,
  radius: number,
  bounds?: MaskBounds,
) {
  const output = new Uint8Array(source.length);
  const queue = new Int32Array(height);
  const minX = bounds?.minX ?? 0;
  const maxX = bounds?.maxX ?? width - 1;
  for (let x = minX; x <= maxX; x += 1) {
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

function dilateMask(
  source: Uint8Array,
  width: number,
  height: number,
  radius: number,
  bounds?: MaskBounds,
) {
  if (radius <= 0) return new Uint8Array(source);
  const horizontal = maxFilterHorizontal(source, width, height, radius, bounds);
  const horizontalBounds = bounds
    ? {
        minX: Math.max(0, bounds.minX - radius),
        minY: bounds.minY,
        maxX: Math.min(width - 1, bounds.maxX + radius),
        maxY: bounds.maxY,
      }
    : undefined;
  return maxFilterVertical(horizontal, width, height, radius, horizontalBounds);
}

function minFilterHorizontal(
  source: Uint8Array,
  width: number,
  height: number,
  radius: number,
  bounds: MaskBounds,
) {
  const output = new Uint8Array(source.length);
  const queue = new Int32Array(Math.min(width, bounds.maxX - bounds.minX + radius * 2 + 1));
  const scanMinX = Math.max(0, bounds.minX - radius);
  const scanMaxX = Math.min(width - 1, bounds.maxX + radius);
  for (let y = bounds.minY; y <= bounds.maxY; y += 1) {
    const row = y * width;
    let head = 0;
    let tail = 0;
    let addedThrough = scanMinX - 1;
    for (let x = bounds.minX; x <= bounds.maxX; x += 1) {
      const addUntil = Math.min(scanMaxX, x + radius);
      while (addedThrough < addUntil) {
        addedThrough += 1;
        const value = source[row + addedThrough];
        while (tail > head && source[row + queue[tail - 1]] >= value) tail -= 1;
        queue[tail++] = addedThrough;
      }
      const minimum = Math.max(scanMinX, x - radius);
      while (tail > head && queue[head] < minimum) head += 1;
      output[row + x] = source[row + queue[head]];
    }
  }
  return output;
}

function minFilterVertical(
  source: Uint8Array,
  width: number,
  height: number,
  radius: number,
  bounds: MaskBounds,
) {
  const output = new Uint8Array(source.length);
  const queue = new Int32Array(Math.min(height, bounds.maxY - bounds.minY + radius * 2 + 1));
  const scanMinY = Math.max(0, bounds.minY - radius);
  const scanMaxY = Math.min(height - 1, bounds.maxY + radius);
  for (let x = bounds.minX; x <= bounds.maxX; x += 1) {
    let head = 0;
    let tail = 0;
    let addedThrough = scanMinY - 1;
    for (let y = bounds.minY; y <= bounds.maxY; y += 1) {
      const addUntil = Math.min(scanMaxY, y + radius);
      while (addedThrough < addUntil) {
        addedThrough += 1;
        const value = source[addedThrough * width + x];
        while (tail > head && source[queue[tail - 1] * width + x] >= value) tail -= 1;
        queue[tail++] = addedThrough;
      }
      const minimum = Math.max(scanMinY, y - radius);
      while (tail > head && queue[head] < minimum) head += 1;
      output[y * width + x] = source[queue[head] * width + x];
    }
  }
  return output;
}

function erodeMask(
  source: Uint8Array,
  width: number,
  height: number,
  radius: number,
  bounds = getMaskBounds(source, width, height),
) {
  if (radius <= 0) return new Uint8Array(source);
  if (bounds.maxX < bounds.minX || bounds.maxY < bounds.minY) return new Uint8Array(source.length);
  const horizontal = minFilterHorizontal(source, width, height, radius, bounds);
  return minFilterVertical(horizontal, width, height, radius, bounds);
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
  sourceBounds?: MaskBounds,
) {
  const output = new Uint8Array(source);
  const bounds = sourceBounds ?? getMaskBounds(source, width, height);
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
  const candidateBounds: MaskBounds = { minX: width, minY: height, maxX: -1, maxY: -1 };
  const strongBounds: MaskBounds = { minX: width, minY: height, maxX: -1, maxY: -1 };
  let x = 0;
  let y = 0;
  for (let index = 0; index < authoredStrength.length; index += 1) {
    if (authoredStrength[index] >= 24) {
      candidate[index] = 255;
      candidateBounds.minX = Math.min(candidateBounds.minX, x);
      candidateBounds.minY = Math.min(candidateBounds.minY, y);
      candidateBounds.maxX = Math.max(candidateBounds.maxX, x);
      candidateBounds.maxY = Math.max(candidateBounds.maxY, y);
    }
    if (authoredStrength[index] >= 96) {
      strong[index] = 255;
      strongBounds.minX = Math.min(strongBounds.minX, x);
      strongBounds.minY = Math.min(strongBounds.minY, y);
      strongBounds.maxX = Math.max(strongBounds.maxX, x);
      strongBounds.maxY = Math.max(strongBounds.maxY, y);
    }
    x += 1;
    if (x === width) {
      x = 0;
      y += 1;
    }
  }
  if (candidateBounds.maxX < candidateBounds.minX || candidateBounds.maxY < candidateBounds.minY) {
    throw new Error('蒙版为空，请先涂抹重绘区域。');
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
  const dilatedCandidate = dilateMask(candidate, width, height, closeRadius, candidateBounds);
  const closedCandidate = erodeMask(
    dilatedCandidate,
    width,
    height,
    closeRadius,
    expandMaskBounds(candidateBounds, closeRadius, width, height),
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
  const coreBounds: MaskBounds = { minX: width, minY: height, maxX: -1, maxY: -1 };
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
    for (let queueIndex = 0; queueIndex < tail; queueIndex += 1) {
      const index = queue[queueIndex];
      core[index] = 255;
      const x = index % width;
      const y = Math.floor(index / width);
      coreBounds.minX = Math.min(coreBounds.minX, x);
      coreBounds.minY = Math.min(coreBounds.minY, y);
      coreBounds.maxX = Math.max(coreBounds.maxX, x);
      coreBounds.maxY = Math.max(coreBounds.maxY, y);
    }
    keptPixelCount += tail;
  }
  if (keptPixelCount === 0) {
    for (let index = 0; index < strong.length; index += 1) core[index] = strong[index];
    coreBounds.minX = strongBounds.minX;
    coreBounds.minY = strongBounds.minY;
    coreBounds.maxX = strongBounds.maxX;
    coreBounds.maxY = strongBounds.maxY;
  }
  const maximumHoleArea = Math.max(
    16,
    Math.round(64 * scale * scale),
    Math.round(bboxArea * 0.0005),
  );
  return {
    core: fillSmallMaskHoles(core, width, height, maximumHoleArea, coreBounds),
    bounds: coreBounds,
  };
}

function boxBlur(
  source: Uint8Array,
  width: number,
  height: number,
  radius: number,
  bounds?: MaskBounds,
) {
  if (radius <= 0) return new Uint8Array(source);
  const horizontal = new Float32Array(source.length);
  const output = new Uint8Array(source.length);
  const minY = bounds?.minY ?? 0;
  const maxY = bounds?.maxY ?? height - 1;
  for (let y = minY; y <= maxY; y += 1) {
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
  const minX = bounds ? Math.max(0, bounds.minX - radius) : 0;
  const maxX = bounds ? Math.min(width - 1, bounds.maxX + radius) : width - 1;
  for (let x = minX; x <= maxX; x += 1) {
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
  const request = event.data;
  const { id, currentEffect, clayPreview, inputMask, coverageDepth } = request;
  const isSingleViewCompletion = request.mode === 'single';
  const whiteSingleView = isSingleViewCompletion && request.whiteFill === true;
  const startedAt = performance.now();
  try {
    const phaseDurationsMs: Record<string, number> = {};
    let phaseStartedAt = startedAt;
    const finishPhase = (name: string) => {
      const now = performance.now();
      phaseDurationsMs[name] = now - phaseStartedAt;
      phaseStartedAt = now;
    };
    const width = currentEffect.width;
    const height = currentEffect.height;
    if (
      width <= 0 ||
      height <= 0 ||
      (request.mode !== 'local' && !whiteSingleView && (!clayPreview || clayPreview.width !== width || clayPreview.height !== height)) ||
      (coverageDepth && (coverageDepth.width !== width || coverageDepth.height !== height)) ||
      inputMask.width !== width ||
      inputMask.height !== height
    ) {
      throw new Error('Texture input dimensions differ.');
    }
    const currentPixels = readPixels(currentEffect, width, height);
    const clayPixels = clayPreview ? readPixels(clayPreview, width, height) : undefined;
    finishPhase('read-input-pixels');
    if (request.mode === 'gpt-local') {
      const maskPixels = readPixels(inputMask, width, height);
      const composite = composeGptRepaintGuide(currentPixels.data, clayPixels!.data, maskPixels.data);
      const canvas = new OffscreenCanvas(width, height);
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Could not encode GPT repaint guide.');
      context.putImageData(new ImageData(composite, width, height), 0, 0);
      const compositeBlob = await canvas.convertToBlob({ type: 'image/png' });
      self.postMessage({ id, compositeBlob, dilationRadius: 0, featherRadius: 0,
        processMs: performance.now() - startedAt, phaseDurationsMs });
      return;
    }
    const scale = Math.max(width, height) / 2048;
    let selectionMask: Uint8Array | undefined;
    let visibleObjectMask: Uint8ClampedArray | undefined;
    let compositeCore: Uint8Array;
    let coreBounds: MaskBounds;
    let objectPixelCount = 0;
    let uncoveredPixelCount = 0;
    let texturedPixelCount = 0;
    let singleViewHasTexture = false;
    let singleViewObjectMask: Uint8ClampedArray | undefined;
    if (isSingleViewCompletion) {
      const targetMask = readObjectMask(inputMask, width, height);
      singleViewObjectMask = targetMask.data;
      const gapMask = whiteSingleView && request.fullObject
        ? targetMask : projectionGapMaskFromAlpha(currentPixels, targetMask);
      for (let index = 0; index < targetMask.data.length; index += 1) {
        if ((targetMask.data[index] ?? 0) === 0) continue;
        objectPixelCount += 1;
        if ((gapMask.data[index] ?? 0) > 0) uncoveredPixelCount += 1;
      }
      if (objectPixelCount === 0) throw new Error('Object mask is empty.');
      texturedPixelCount = Math.max(0, objectPixelCount - uncoveredPixelCount);
      const hasVisibleTexture =
        texturedPixelCount >= Math.max(64, Math.round(objectPixelCount * 0.0005));
      singleViewHasTexture = hasVisibleTexture;
      if ((!hasVisibleTexture && !whiteSingleView) || uncoveredPixelCount === 0) {
        self.postMessage({
          id,
          hasVisibleTexture,
          uncoveredPixelCount,
        } satisfies GenerationInputWorkerResponse);
        return;
      }
      compositeCore = Uint8Array.from(
        whiteSingleView && !hasVisibleTexture ? targetMask.data : gapMask.data,
        (value) => (value > 0 ? 255 : 0),
      );
      coreBounds = getMaskBounds(compositeCore, width, height);
    } else {
      const maskPixels = readPixels(inputMask, width, height);
      const authoredStrength = new Uint8Array(width * height);
      for (let index = 0; index < authoredStrength.length; index += 1) {
        const offset = index * 4;
        authoredStrength[index] = Math.round(
          (Math.max(
            maskPixels.data[offset],
            maskPixels.data[offset + 1],
            maskPixels.data[offset + 2],
          ) *
            maskPixels.data[offset + 3]) /
            255,
        );
      }
      finishPhase('extract-authored-mask');
      if (coverageDepth) {
        // LOCAL-REPAINT-VISIBLE-GAPS/1.0.0: coverage alpha, never RGB.
        // Packed depth excludes clear background and hidden surfaces in this view.
        const depth = readPixels(coverageDepth, width, height).data;
        visibleObjectMask = new Uint8ClampedArray(width * height);
        for (let index = 0; index < visibleObjectMask.length; index++) {
          const offset = index * 4;
          visibleObjectMask[index] = depth[offset] >= 254 && depth[offset + 1] >= 254 && depth[offset + 2] >= 254 ? 0 : 255;
        }
        const gaps = projectionGapMaskFromAlpha(currentPixels, { width, height, data: visibleObjectMask });
        selectionMask = authoredStrength;
        for (let index = 0; index < selectionMask.length; index++) {
          selectionMask[index] = visibleObjectMask[index] ? Math.max(selectionMask[index], gaps.data[index]) : 0;
        }
        // Do not close holes in this union: they may be textured islands or background.
        compositeCore = selectionMask;
        coreBounds = getMaskBounds(compositeCore, width, height);
      } else {
        ({ core: compositeCore, bounds: coreBounds } = buildCompositeCoreMask(
          authoredStrength, width, height, scale,
        ));
      }
    }
    if (coreBounds.maxX < coreBounds.minX || coreBounds.maxY < coreBounds.minY) {
      throw new Error('Input mask is empty.');
    }
    finishPhase('build-core-mask');
    // MODELVIEW-WHITE-INPUT/1.0.0: exact white marking, no grey/clay edge.
    // The independent sampling mask retains its existing expansion/feathering.
    const compositeEdgeRadius = 0;
    const compositeAlpha = boxBlur(
      compositeCore,
      width,
      height,
      compositeEdgeRadius,
      coreBounds,
    );
    for (let y = coreBounds.minY; y <= coreBounds.maxY; y += 1) {
      const row = y * width;
      for (let x = coreBounds.minX; x <= coreBounds.maxX; x += 1) {
        const index = row + x;
        if (compositeCore[index] > 0) compositeAlpha[index] = 255;
      }
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
    // MODELVIEW-SINGLE-WHITE/1.0.0: remote guides are opaque black outside the
    // frozen object silhouette. Coverage is derived from alpha, never RGB.
    if (whiteSingleView && singleViewObjectMask) {
      for (let index = 0; index < singleViewObjectMask.length; index += 1) {
        if (singleViewObjectMask[index]) continue;
        const offset = index * 4;
        compositePixels.fill(0, offset, offset + 3);
        compositePixels[offset + 3] = 255;
      }
    }
    const compositeBounds = expandMaskBounds(coreBounds, compositeEdgeRadius, width, height);
    for (let y = compositeBounds.minY; y <= compositeBounds.maxY; y += 1) {
      const row = y * width;
      for (let x = compositeBounds.minX; x <= compositeBounds.maxX; x += 1) {
        const index = row + x;
        const alpha = compositeAlpha[index] / 255;
        if (alpha <= 0) continue;
        const offset = index * 4;
        if (!isSingleViewCompletion || whiteSingleView) {
          compositePixels.fill(255, offset, offset + 4);
          continue;
        }
        for (let channel = 0; channel < 4; channel += 1) {
          compositePixels[offset + channel] = Math.round(
            currentPixels.data[offset + channel] * (1 - alpha) +
              clayPixels!.data[offset + channel] * alpha,
          );
        }
      }
    }
    finishPhase(isSingleViewCompletion && !whiteSingleView ? 'blend-clay-composite' : 'fill-white-selection');

    const dilated = dilateMask(compositeCore, width, height, dilationRadius, coreBounds);
    const dilatedBounds = expandMaskBounds(coreBounds, dilationRadius, width, height);
    const submittedMask = boxBlur(dilated, width, height, featherRadius, dilatedBounds);
    for (let y = coreBounds.minY; y <= coreBounds.maxY; y += 1) {
      const row = y * width;
      for (let x = coreBounds.minX; x <= coreBounds.maxX; x += 1) {
        const index = row + x;
        if (compositeCore[index] > 0) submittedMask[index] = 255;
      }
    }
    if (visibleObjectMask) {
      for (let index = 0; index < submittedMask.length; index++) {
        if (!visibleObjectMask[index]) submittedMask[index] = 0;
      }
    }
    finishPhase('build-submitted-mask');

    const compositeCanvas = new OffscreenCanvas(width, height);
    const compositeContext = compositeCanvas.getContext('2d');
    if (!compositeContext) throw new Error('Could not encode the local repaint composite.');
    compositeContext.putImageData(new ImageData(compositePixels, width, height), 0, 0);
    const maskCanvas = new OffscreenCanvas(width, height);
    const maskContext = maskCanvas.getContext('2d');
    if (!maskContext) throw new Error('Could not encode the submitted local repaint mask.');
    maskContext.putImageData(writeMaskPixels(submittedMask, width, height), 0, 0);
    finishPhase('upload-output-pixels');
    const [compositeBlob, submittedMaskBlob] = await Promise.all([
      compositeCanvas.convertToBlob({ type: 'image/png' }),
      maskCanvas.convertToBlob({ type: 'image/png' }),
    ]);
    let selectionMaskBlob: Blob | undefined;
    if (selectionMask) {
      maskContext.putImageData(writeMaskPixels(selectionMask, width, height), 0, 0);
      selectionMaskBlob = await maskCanvas.convertToBlob({ type: 'image/png' });
    }
    finishPhase('encode-output-png');
    const response: GenerationInputWorkerResponse = isSingleViewCompletion
      ? {
          id,
          compositeBlob,
          submittedMaskBlob,
          hasVisibleTexture: singleViewHasTexture,
          uncoveredPixelCount,
        }
      : {
          id,
          compositeBlob,
          submittedMaskBlob,
          selectionMaskBlob,
          dilationRadius,
          featherRadius,
          processMs: performance.now() - startedAt,
          phaseDurationsMs,
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
    clayPreview?.close();
    coverageDepth?.close();
    inputMask.close();
  }
};

export {};
