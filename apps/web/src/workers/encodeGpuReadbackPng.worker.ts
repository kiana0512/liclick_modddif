import { encodeRgbaPngBytes } from '@/utils/encodeRgbaPngCore';

export {};

type EncodeRequest = {
  id: number;
  pixels: ArrayBuffer;
  width: number;
  height: number;
  outputWidth?: number;
  outputHeight?: number;
};
type EncodeResponse =
  | { id: number; png: ArrayBuffer }
  | { id: number; error: string };

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<EncodeRequest>) => void) | null;
  postMessage(message: EncodeResponse, transfer?: Transferable[]): void;
};

function resizeRgbaBilinear(
  source: Uint8ClampedArray,
  sourceWidth: number,
  sourceHeight: number,
  outputWidth: number,
  outputHeight: number,
) {
  if (sourceWidth === outputWidth && sourceHeight === outputHeight) return source;
  const output = new Uint8ClampedArray(outputWidth * outputHeight * 4);
  const x0 = new Uint16Array(outputWidth);
  const x1 = new Uint16Array(outputWidth);
  const xWeight = new Float32Array(outputWidth);
  for (let x = 0; x < outputWidth; x += 1) {
    const sourceX = ((x + 0.5) * sourceWidth) / outputWidth - 0.5;
    const lower = Math.max(0, Math.min(sourceWidth - 1, Math.floor(sourceX)));
    x0[x] = lower;
    x1[x] = Math.min(sourceWidth - 1, lower + 1);
    xWeight[x] = Math.max(0, Math.min(1, sourceX - lower));
  }
  for (let y = 0; y < outputHeight; y += 1) {
    const sourceY = ((y + 0.5) * sourceHeight) / outputHeight - 0.5;
    const upperY = Math.max(0, Math.min(sourceHeight - 1, Math.floor(sourceY)));
    const lowerY = Math.min(sourceHeight - 1, upperY + 1);
    const yWeight = Math.max(0, Math.min(1, sourceY - upperY));
    for (let x = 0; x < outputWidth; x += 1) {
      const topOffset = (upperY * sourceWidth + x0[x]) * 4;
      const topRightOffset = (upperY * sourceWidth + x1[x]) * 4;
      const bottomOffset = (lowerY * sourceWidth + x0[x]) * 4;
      const bottomRightOffset = (lowerY * sourceWidth + x1[x]) * 4;
      const outputOffset = (y * outputWidth + x) * 4;
      const wx = xWeight[x];
      for (let channel = 0; channel < 4; channel += 1) {
        const top =
          source[topOffset + channel] * (1 - wx) + source[topRightOffset + channel] * wx;
        const bottom =
          source[bottomOffset + channel] * (1 - wx) +
          source[bottomRightOffset + channel] * wx;
        output[outputOffset + channel] = top * (1 - yWeight) + bottom * yWeight;
      }
    }
  }
  return output;
}

scope.onmessage = (event) => {
  const { id, pixels, width, height, outputWidth = width, outputHeight = height } = event.data;
  try {
    const source = new Uint8Array(pixels);
    const flipped = new Uint8ClampedArray(source.byteLength);
    const rowStride = width * 4;
    for (let y = 0; y < height; y += 1) {
      const sourceStart = (height - y - 1) * rowStride;
      flipped.set(source.subarray(sourceStart, sourceStart + rowStride), y * rowStride);
    }
    const output = resizeRgbaBilinear(flipped, width, height, outputWidth, outputHeight);
    const encoded = encodeRgbaPngBytes(outputWidth, outputHeight, output);
    const png = encoded.buffer.slice(
      encoded.byteOffset,
      encoded.byteOffset + encoded.byteLength,
    ) as ArrayBuffer;
    scope.postMessage({ id, png }, [png]);
  } catch (error) {
    scope.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
};
