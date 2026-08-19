import {
  createInwardFeatheredMask,
  removeEdgeConnectedNeutralBackground,
} from '../engine/localRepaint/resultPreviewUtils';

type FalloffRequest = {
  id: number;
  mask: ImageBitmap;
  source: ImageBitmap;
  width: number;
  height: number;
};

type FalloffResponse =
  | { id: number; bitmap: ImageBitmap; processMs: number }
  | { id: number; error: string };

self.onmessage = (event: MessageEvent<FalloffRequest>) => {
  const { id, mask, source, width, height } = event.data;
  const startedAt = performance.now();
  try {
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('Could not create local repaint falloff canvas.');
    context.clearRect(0, 0, width, height);
    context.drawImage(mask, 0, 0, width, height);
    const maskPixels = context.getImageData(0, 0, width, height);
    const featherRadius = Math.max(
      4,
      Math.min(18, Math.round(Math.min(width, height) * 0.016)),
    );
    const output = createInwardFeatheredMask(maskPixels, featherRadius);

    // Match the transparent preview shown in the generation panel. The source
    // colour remains the original high-resolution asset; only its lightweight
    // coverage silhouette is combined here, entirely off the main thread.
    const sourceCanvas = new OffscreenCanvas(width, height);
    const sourceContext = sourceCanvas.getContext('2d', { willReadFrequently: true });
    if (!sourceContext) throw new Error('Could not create local repaint source mask canvas.');
    sourceContext.drawImage(source, 0, 0, width, height);
    const sourcePixels = sourceContext.getImageData(0, 0, width, height);
    const transparentSource = removeEdgeConnectedNeutralBackground(sourcePixels, 'dark-only');
    for (let offset = 0; offset < output.data.length; offset += 4) {
      output.data[offset + 3] = Math.round(
        (output.data[offset + 3] * transparentSource.imageData.data[offset + 3]) / 255,
      );
    }
    context.putImageData(output, 0, 0);

    const bitmap = canvas.transferToImageBitmap();
    const response: FalloffResponse = {
      id,
      bitmap,
      processMs: performance.now() - startedAt,
    };
    self.postMessage(response, { transfer: [bitmap] });
  } catch (error) {
    const response: FalloffResponse = {
      id,
      error: error instanceof Error ? error.message : String(error),
    };
    self.postMessage(response);
  } finally {
    mask.close();
    source.close();
  }
};

export {};
