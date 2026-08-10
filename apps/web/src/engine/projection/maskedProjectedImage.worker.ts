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
};

function deserializeImage(input: SerializedImageData) {
  return new ImageData(new Uint8ClampedArray(input.data), input.width, input.height);
}

self.addEventListener('message', (event: MessageEvent<MaskedProjectedWorkerRequest>) => {
  const { id, source, mask } = event.data;
  try {
    const cutout = removeSolidBackground(deserializeImage(source));
    const projectionMask = mask ? deserializeImage(mask) : undefined;
    const output = projectionMask
      ? applyProjectedAlphaMask(
          alignCutoutToProjectionMask(cutout, projectionMask),
          projectionMask,
        )
      : cutout;
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
