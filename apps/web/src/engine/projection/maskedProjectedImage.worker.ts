/// <reference lib="webworker" />

import {
  alignCutoutToProjectionMask,
  applyProjectedAlphaMask,
  removeSolidBackground,
} from './createMaskedProjectedImage';

type SerializedImageData = {
  width: number;
  height: number;
  data: ArrayBuffer;
};

type MaskedProjectedWorkerRequest = {
  id: number;
  source: SerializedImageData;
  mask?: SerializedImageData;
  mode?: 'cutout' | 'projection-alpha-only';
};

function deserializeImage(input: SerializedImageData) {
  return new ImageData(new Uint8ClampedArray(input.data), input.width, input.height);
}

self.addEventListener('message', (event: MessageEvent<MaskedProjectedWorkerRequest>) => {
  const { id, source, mask, mode = 'cutout' } = event.data;
  try {
    const sourceImage = deserializeImage(source);
    const projectionMask = mask ? deserializeImage(mask) : undefined;
    const output =
      mode === 'projection-alpha-only'
        ? projectionMask
          ? applyProjectedAlphaMask(sourceImage, projectionMask)
          : sourceImage
        : (() => {
            const cutout = removeSolidBackground(sourceImage);
            return projectionMask
              ? applyProjectedAlphaMask(
                  alignCutoutToProjectionMask(cutout, projectionMask),
                  projectionMask,
                )
              : cutout;
          })();
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
