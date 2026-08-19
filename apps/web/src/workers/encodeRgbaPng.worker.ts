import { encodeRgbaPngBytesChunked } from '@/utils/encodeRgbaPngCore';

type EncodeRgbaPngRequest = {
  type?: 'encode';
  id: number;
  width: number;
  height: number;
  rgba: ArrayBuffer;
  output?: 'blob' | 'object-url';
};

type RevokeObjectUrlRequest = { type: 'revoke-object-url'; url: string };

type EncodeRgbaPngResponse = {
  id: number;
  blob?: Blob;
  url?: string;
  byteLength?: number;
  error?: string;
};

const workerScope = self as unknown as {
  onmessage: ((event: MessageEvent<EncodeRgbaPngRequest | RevokeObjectUrlRequest>) => void) | null;
  postMessage(message: EncodeRgbaPngResponse, transfer: Transferable[]): void;
};

// Worker timers are clamped too. A 2K encode has 128 cooperative boundaries;
// setTimeout(0) added hundreds of milliseconds to a cold publish even though
// this work never touches the UI thread. MessageChannel keeps cancellation and
// other worker messages schedulable without paying that timer floor.
const yieldQueue: Array<() => void> = [];
const yieldChannel = new MessageChannel();
yieldChannel.port1.onmessage = () => yieldQueue.shift()?.();

function yieldWorkerTask() {
  return new Promise<void>((resolve) => {
    yieldQueue.push(resolve);
    yieldChannel.port2.postMessage(0);
  });
}

workerScope.onmessage = async (event) => {
  if (event.data.type === 'revoke-object-url') {
    URL.revokeObjectURL(event.data.url);
    return;
  }
  try {
    const { id, width, height, rgba } = event.data;
    const png = await encodeRgbaPngBytesChunked(
      width,
      height,
      new Uint8ClampedArray(rgba),
      yieldWorkerTask,
    );
    const blob = new Blob([png], { type: 'image/png' });
    workerScope.postMessage(
      event.data.output === 'object-url'
        ? { id, url: URL.createObjectURL(blob), byteLength: blob.size }
        : { id, blob },
      [],
    );
  } catch (error) {
    workerScope.postMessage(
      {
        id: event.data.id,
        error: error instanceof Error ? error.message : 'Could not encode PNG.',
      },
      [],
    );
  }
};
