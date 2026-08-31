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
    const authoredBinary = new Uint8Array(width * height);
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;
    for (let index = 0; index < authoredStrength.length; index += 1) {
      const offset = index * 4;
      const value = Math.round(
        (Math.max(maskPixels.data[offset], maskPixels.data[offset + 1], maskPixels.data[offset + 2]) *
          maskPixels.data[offset + 3]) /
          255,
      );
      authoredStrength[index] = value;
      if (value <= 8) continue;
      authoredBinary[index] = 255;
      const x = index % width;
      const y = Math.floor(index / width);
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
    if (maxX < minX || maxY < minY) throw new Error('The authored local repaint mask is empty.');

    const scale = Math.max(width, height) / 2048;
    const minimumDimension = Math.min(maxX - minX + 1, maxY - minY + 1);
    const dilationRadius = Math.max(
      Math.round(16 * scale),
      Math.min(Math.round(48 * scale), Math.round(minimumDimension * 0.2)),
    );
    const featherRadius = Math.max(
      Math.round(4 * scale),
      Math.min(Math.round(10 * scale), Math.round(dilationRadius * 0.2)),
    );

    const compositePixels = new Uint8ClampedArray(currentPixels.data);
    for (let index = 0; index < authoredStrength.length; index += 1) {
      const alpha = authoredStrength[index] / 255;
      if (alpha <= 0) continue;
      const offset = index * 4;
      for (let channel = 0; channel < 4; channel += 1) {
        compositePixels[offset + channel] = Math.round(
          currentPixels.data[offset + channel] * (1 - alpha) +
            clayPixels.data[offset + channel] * alpha,
        );
      }
    }

    const dilated = dilateMask(authoredBinary, width, height, dilationRadius);
    const submittedMask = boxBlur(dilated, width, height, featherRadius);
    for (let index = 0; index < authoredBinary.length; index += 1) {
      if (authoredBinary[index] > 0) submittedMask[index] = 255;
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
