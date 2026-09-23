import { createManualRepaintFalloffPixels } from '../engine/localRepaint/inwardCrossfadeMask';

type FalloffRequest = {
  id: number;
  mask: ImageBitmap;
  width: number;
  height: number;
};

type FalloffResponse =
  | { id: number; bitmap: ImageBitmap; processMs: number }
  | { id: number; error: string };

self.onmessage = (event: MessageEvent<FalloffRequest>) => {
  const { id, mask, width, height } = event.data;
  const startedAt = performance.now();
  try {
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('Could not create local repaint falloff canvas.');
    context.clearRect(0, 0, width, height);
    context.drawImage(mask, 0, 0, width, height);
    const maskPixels = context.getImageData(0, 0, width, height);
    context.putImageData(new ImageData(createManualRepaintFalloffPixels(maskPixels), width, height), 0, 0);

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
  }
};

export {};
