export {};

type Request = { id: number; url: string; width: number; height: number };
type Response =
  | { id: number; rgba: ArrayBuffer; width: number; height: number }
  | { id: number; error: string };

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<Request>) => void) | null;
  postMessage(message: Response, transfer?: Transferable[]): void;
};

scope.onmessage = async (event) => {
  const request = event.data;
  try {
    const response = await fetch(request.url);
    if (!response.ok) throw new Error(`Image request failed (${response.status}).`);
    const bitmap = await createImageBitmap(await response.blob(), {
      resizeWidth: request.width,
      resizeHeight: request.height,
      resizeQuality: 'high',
    });
    const canvas = new OffscreenCanvas(request.width, request.height);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('Offscreen image canvas unavailable.');
    context.drawImage(bitmap, 0, 0, request.width, request.height);
    bitmap.close();
    const rgba = context.getImageData(0, 0, request.width, request.height).data.buffer;
    scope.postMessage({ id: request.id, rgba, width: request.width, height: request.height }, [rgba]);
  } catch (error) {
    scope.postMessage({ id: request.id, error: error instanceof Error ? error.message : String(error) });
  }
};
