import { encodeRgbaPngBytes } from '@/utils/encodeRgbaPngCore';

export {};

type EncodeRequest = { id: number; pixels: ArrayBuffer; width: number; height: number };
type EncodeResponse =
  | { id: number; png: ArrayBuffer }
  | { id: number; error: string };

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<EncodeRequest>) => void) | null;
  postMessage(message: EncodeResponse, transfer?: Transferable[]): void;
};

scope.onmessage = (event) => {
  const { id, pixels, width, height } = event.data;
  try {
    const source = new Uint8Array(pixels);
    const flipped = new Uint8ClampedArray(source.byteLength);
    const rowStride = width * 4;
    for (let y = 0; y < height; y += 1) {
      const sourceStart = (height - y - 1) * rowStride;
      flipped.set(source.subarray(sourceStart, sourceStart + rowStride), y * rowStride);
    }
    const encoded = encodeRgbaPngBytes(width, height, flipped);
    const png = encoded.buffer.slice(
      encoded.byteOffset,
      encoded.byteOffset + encoded.byteLength,
    ) as ArrayBuffer;
    scope.postMessage({ id, png }, [png]);
  } catch (error) {
    scope.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
};
