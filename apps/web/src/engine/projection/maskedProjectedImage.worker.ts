/// <reference lib="webworker" />

import {
  applyProjectedAlphaMask,
} from './createMaskedProjectedImage';

type SerializedImageData = {
  width: number;
  height: number;
  data: ArrayBuffer;
};

type MaskedProjectedWorkerRequest = {
  id: number;
  source: SerializedImageData;
  mask: SerializedImageData;
};

function deserializeImage(input: SerializedImageData) {
  return new ImageData(new Uint8ClampedArray(input.data), input.width, input.height);
}

self.addEventListener('message', (event: MessageEvent<MaskedProjectedWorkerRequest>) => {
  const { id, source, mask } = event.data;
  try {
    const sourceImage = deserializeImage(source);
    const projectionMask = deserializeImage(mask);
    const output = applyProjectedAlphaMask(sourceImage, projectionMask, {
      ignoreSourceAlpha: true,
    });
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
