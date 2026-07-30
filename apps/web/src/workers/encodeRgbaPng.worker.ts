import { encodeRgbaPngBytes } from '@/utils/encodeRgbaPngCore';

type EncodeRgbaPngRequest = {
  width: number;
  height: number;
  rgba: ArrayBuffer;
};

type EncodeRgbaPngResponse = {
  png?: ArrayBuffer;
  error?: string;
};

const workerScope = self as unknown as {
  onmessage: ((event: MessageEvent<EncodeRgbaPngRequest>) => void) | null;
  postMessage(message: EncodeRgbaPngResponse, transfer: Transferable[]): void;
};

workerScope.onmessage = (event) => {
  try {
    const { width, height, rgba } = event.data;
    const png = encodeRgbaPngBytes(width, height, new Uint8ClampedArray(rgba));
    const pngBuffer = new ArrayBuffer(png.byteLength);
    new Uint8Array(pngBuffer).set(png);
    workerScope.postMessage({ png: pngBuffer }, [pngBuffer]);
  } catch (error) {
    workerScope.postMessage(
      { error: error instanceof Error ? error.message : 'Could not encode PNG.' },
      [],
    );
  }
};
