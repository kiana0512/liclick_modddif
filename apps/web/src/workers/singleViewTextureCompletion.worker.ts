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
    if (hasVisibleTexture) {
      const compositePixels = new Uint8ClampedArray(currentPixels.data);
      const completionMaskPixels =
        uncoveredPixelCount > 0 ? new Uint8ClampedArray(width * height * 4) : undefined;
      for (let index = 0; index < gapMask.data.length; index += 1) {
        const offset = index * 4;
        const maskValue = gapMask.data[index] ?? 0;
        if (completionMaskPixels) {
          completionMaskPixels[offset] = maskValue;
          completionMaskPixels[offset + 1] = maskValue;
          completionMaskPixels[offset + 2] = maskValue;
          completionMaskPixels[offset + 3] = 255;
        }
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
      if (completionMaskPixels) {
        const completionMaskCanvas = new OffscreenCanvas(width, height);
        const completionMaskContext = completionMaskCanvas.getContext('2d');
        if (!completionMaskContext) {
          throw new Error('Could not encode the single-view completion mask.');
        }
        completionMaskContext.putImageData(
          new ImageData(completionMaskPixels, width, height),
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
