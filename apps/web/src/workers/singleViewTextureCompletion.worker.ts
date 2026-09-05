import { inferProjectionGapMask } from '../engine/localRepaint/imageUtils';

type WorkerRequest = {
  id: number;
  currentEffect: ImageBitmap;
  clayPreview: ImageBitmap;
  objectMask: ImageBitmap;
};

type WorkerResponse =
  | {
      id: number;
      compositeBlob?: Blob;
      completionMaskBlob?: Blob;
      dilationRadius: number;
      featherRadius: number;
      hasVisibleTexture: boolean;
      objectPixelCount: number;
      texturedPixelCount: number;
      uncoveredPixelCount: number;
      visibleTextureRatio: number;
      uncoveredRatio: number;
      processMs: number;
    }
  | { id: number; error: string };

function readPixels(bitmap: ImageBitmap, width: number, height: number) {
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('Could not read a single-view texture input image.');
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

function getMaskBounds(mask: Uint8Array, width: number, height: number): MaskBounds {
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
  bounds: MaskBounds,
) {
  const output = new Uint8Array(source.length);
  const queue = new Int32Array(width);
  for (let y = bounds.minY; y <= bounds.maxY; y += 1) {
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
        queue[tail++] = addedThrough;
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
  bounds: MaskBounds,
) {
  const output = new Uint8Array(source.length);
  const queue = new Int32Array(height);
  for (let x = bounds.minX; x <= bounds.maxX; x += 1) {
    let head = 0;
    let tail = 0;
    let addedThrough = -1;
    for (let y = 0; y < height; y += 1) {
      const addUntil = Math.min(height - 1, y + radius);
      while (addedThrough < addUntil) {
        addedThrough += 1;
        const value = source[addedThrough * width + x];
        while (tail > head && source[queue[tail - 1] * width + x] <= value) tail -= 1;
        queue[tail++] = addedThrough;
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
  bounds: MaskBounds,
) {
  const horizontal = maxFilterHorizontal(source, width, height, radius, bounds);
  return maxFilterVertical(
    horizontal,
    width,
    height,
    radius,
    {
      minX: Math.max(0, bounds.minX - radius),
      minY: bounds.minY,
      maxX: Math.min(width - 1, bounds.maxX + radius),
      maxY: bounds.maxY,
    },
  );
}

function boxBlur(
  source: Uint8Array,
  width: number,
  height: number,
  radius: number,
  bounds: MaskBounds,
) {
  const horizontal = new Float32Array(source.length);
  const output = new Uint8Array(source.length);
  for (let y = bounds.minY; y <= bounds.maxY; y += 1) {
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
  const minX = Math.max(0, bounds.minX - radius);
  const maxX = Math.min(width - 1, bounds.maxX + radius);
  for (let x = minX; x <= maxX; x += 1) {
    let sum = 0;
    for (let y = 0; y <= Math.min(height - 1, radius); y += 1) {
      sum += horizontal[y * width + x];
    }
    for (let y = 0; y < height; y += 1) {
      const top = Math.max(0, y - radius);
      const bottom = Math.min(height - 1, y + radius);
      if (y > 0) {
        const previousTop = Math.max(0, y - radius - 1);
        const previousBottom = Math.min(height - 1, y + radius - 1);
        if (top > previousTop) sum -= horizontal[previousTop * width + x];
        if (bottom > previousBottom) sum += horizontal[previousBottom * width + x];
      }
      output[y * width + x] = Math.round(sum / (bottom - top + 1));
    }
  }
  return output;
}

function writeRgbMask(mask: Uint8Array, width: number, height: number) {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < mask.length; index += 1) {
    const offset = index * 4;
    const value = mask[index];
    pixels[offset] = value;
    pixels[offset + 1] = value;
    pixels[offset + 2] = value;
    pixels[offset + 3] = 255;
  }
  return pixels;
}

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const { id, currentEffect, clayPreview, objectMask } = event.data;
  const startedAt = performance.now();
  try {
    const width = currentEffect.width;
    const height = currentEffect.height;
    if (width < 1 || height < 1) throw new Error('The current single-view capture is empty.');
    const currentPixels = readPixels(currentEffect, width, height);
    const clayPixels = readPixels(clayPreview, width, height);
    const targetMask = readObjectMask(objectMask, width, height);

    const gapMask = inferProjectionGapMask(currentPixels, targetMask, 1);
    let objectPixelCount = 0;
    let uncoveredPixelCount = 0;
    for (let index = 0; index < targetMask.data.length; index += 1) {
      if ((targetMask.data[index] ?? 0) === 0) continue;
      objectPixelCount += 1;
      if ((gapMask.data[index] ?? 0) > 0) uncoveredPixelCount += 1;
    }
    if (objectPixelCount === 0) throw new Error('The current single-view object mask is empty.');

    const texturedPixelCount = Math.max(0, objectPixelCount - uncoveredPixelCount);
    const visibleTextureRatio = texturedPixelCount / objectPixelCount;
    const uncoveredRatio = uncoveredPixelCount / objectPixelCount;
    // Ignore sub-pixel/MSAA residue, while still accepting a deliberately
    // small projection as existing material context.
    const minimumVisiblePixels = Math.max(64, Math.round(objectPixelCount * 0.0005));
    const hasVisibleTexture = texturedPixelCount >= minimumVisiblePixels;

    let compositeBlob: Blob | undefined;
    let completionMaskBlob: Blob | undefined;
    let dilationRadius = 0;
    let featherRadius = 0;
    if (hasVisibleTexture) {
      const compositePixels = new Uint8ClampedArray(currentPixels.data);
      for (let index = 0; index < gapMask.data.length; index += 1) {
        const offset = index * 4;
        const maskValue = gapMask.data[index] ?? 0;
        if (maskValue > 0) {
          compositePixels[offset] = clayPixels.data[offset] ?? 0;
          compositePixels[offset + 1] = clayPixels.data[offset + 1] ?? 0;
          compositePixels[offset + 2] = clayPixels.data[offset + 2] ?? 0;
          compositePixels[offset + 3] = clayPixels.data[offset + 3] ?? 255;
        }
      }

      const compositeCanvas = new OffscreenCanvas(width, height);
      const compositeContext = compositeCanvas.getContext('2d');
      if (!compositeContext) throw new Error('Could not encode the single-view completion input.');
      compositeContext.putImageData(new ImageData(compositePixels, width, height), 0, 0);
      if (uncoveredPixelCount > 0) {
        const coreMask = Uint8Array.from(gapMask.data, (value) => (value > 0 ? 255 : 0));
        const coreBounds = getMaskBounds(coreMask, width, height);
        const scale = Math.max(width, height) / 2048;
        const minimumDimension = Math.min(
          coreBounds.maxX - coreBounds.minX + 1,
          coreBounds.maxY - coreBounds.minY + 1,
        );
        dilationRadius = Math.max(
          Math.round(24 * scale),
          Math.min(Math.round(64 * scale), Math.round(minimumDimension * 0.25)),
        );
        featherRadius = Math.max(
          Math.round(4 * scale),
          Math.min(Math.round(10 * scale), Math.round(dilationRadius * 0.2)),
        );
        const dilated = dilateMask(coreMask, width, height, dilationRadius, coreBounds);
        const dilatedBounds = expandMaskBounds(coreBounds, dilationRadius, width, height);
        const submittedMask = boxBlur(
          dilated,
          width,
          height,
          featherRadius,
          dilatedBounds,
        );
        for (let index = 0; index < coreMask.length; index += 1) {
          if (coreMask[index] > 0) submittedMask[index] = 255;
        }
        const completionMaskCanvas = new OffscreenCanvas(width, height);
        const completionMaskContext = completionMaskCanvas.getContext('2d');
        if (!completionMaskContext) {
          throw new Error('Could not encode the single-view completion mask.');
        }
        completionMaskContext.putImageData(
          new ImageData(writeRgbMask(submittedMask, width, height), width, height),
          0,
          0,
        );
        [compositeBlob, completionMaskBlob] = await Promise.all([
          compositeCanvas.convertToBlob({ type: 'image/png' }),
          completionMaskCanvas.convertToBlob({ type: 'image/png' }),
        ]);
      } else {
        compositeBlob = await compositeCanvas.convertToBlob({ type: 'image/png' });
      }
    }

    const response: WorkerResponse = {
      id,
      compositeBlob,
      completionMaskBlob,
      dilationRadius,
      featherRadius,
      hasVisibleTexture,
      objectPixelCount,
      texturedPixelCount,
      uncoveredPixelCount,
      visibleTextureRatio,
      uncoveredRatio,
      processMs: performance.now() - startedAt,
    };
    self.postMessage(response);
  } catch (error) {
    const response: WorkerResponse = {
      id,
      error: error instanceof Error ? error.message : String(error),
    };
    self.postMessage(response);
  } finally {
    currentEffect.close();
    clayPreview.close();
    objectMask.close();
  }
};
