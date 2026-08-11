import { encodeRgbaPngBytesChunked } from '@/utils/encodeRgbaPngCore';

type EncodeRgbaPngRequest = {
  width: number;
  height: number;
  rgba: ArrayBuffer;
};

type EncodeRgbaPngResponse = {
  blob?: Blob;
  error?: string;
};

const workerScope = self as unknown as {
  onmessage: ((event: MessageEvent<EncodeRgbaPngRequest>) => void) | null;
  postMessage(message: EncodeRgbaPngResponse, transfer: Transferable[]): void;
};

workerScope.onmessage = async (event) => {
  try {
    const { width, height, rgba } = event.data;
    const png = await encodeRgbaPngBytesChunked(
      width,
      height,
      new Uint8ClampedArray(rgba),
      () => new Promise<void>((resolve) => setTimeout(resolve, 0)),
    );
    workerScope.postMessage({ blob: new Blob([png], { type: 'image/png' }) }, []);
  } catch (error) {
    workerScope.postMessage(
      { error: error instanceof Error ? error.message : 'Could not encode PNG.' },
      [],
    );
  }
};
