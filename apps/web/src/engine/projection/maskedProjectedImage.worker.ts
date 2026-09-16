/// <reference lib="webworker" />

import {
  applyProjectedAlphaMask,
} from './projectedAlphaMask';

type SerializedImageData = {
  width: number;
  height: number;
  data: ArrayBuffer;
};

type MaskedProjectedWorkerRequest = {
  id: number;
  source: SerializedImageData;
  mask?: SerializedImageData;
  mode?: 'mask-only' | 'projection-alpha-only';
  pngOnly?: boolean;
};

// MASKED-PROJECTED-PNG/1.0.0: one full PNG canvas at a time. Mask processing
// keeps its existing byte protocol; only private output buffers enter here.
let pngEncoding = Promise.resolve();

function deserializeImage(input: SerializedImageData) {
  return new ImageData(new Uint8ClampedArray(input.data), input.width, input.height);
}

self.addEventListener('message', async (event: MessageEvent<MaskedProjectedWorkerRequest>) => {
  const { id, source, mask, mode = 'mask-only', pngOnly } = event.data;
  try {
    const sourceImage = deserializeImage(source);
    if (pngOnly) {
      const encode = pngEncoding.then(async () => {
        const canvas = new OffscreenCanvas(sourceImage.width, sourceImage.height);
        try {
          const context = canvas.getContext('2d');
          if (!context) throw new Error('Could not create masked projected image canvas.');
          context.putImageData(sourceImage, 0, 0);
          const png = await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer();
          self.postMessage({ id, png }, { transfer: [png] });
        } finally { canvas.width = canvas.height = 0; }
      });
      pngEncoding = encode.catch(() => undefined);
      await encode;
      return;
    }
    const projectionMask = mask ? deserializeImage(mask) : undefined;
    const output =
      mode === 'projection-alpha-only'
        ? projectionMask
          ? applyProjectedAlphaMask(sourceImage, projectionMask, { ignoreSourceAlpha: true })
          : sourceImage
        : projectionMask
          ? applyProjectedAlphaMask(sourceImage, projectionMask)
          : sourceImage;
    const outputBuffer = output.data.buffer as ArrayBuffer;
    self.postMessage(
      { id, width: output.width, height: output.height, data: outputBuffer },
      { transfer: [outputBuffer] },
    );
  } catch (error) {
    self.postMessage({
      id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

export {};
