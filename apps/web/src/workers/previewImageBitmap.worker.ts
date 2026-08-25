export {};

type Request =
  | { type: 'decode'; id: number; url: string }
  | { type: 'stripe'; id: number; requestId: number; y: number; height: number }
  | { type: 'release'; id: number };
type Response =
  | { type: 'ready'; id: number; width: number; height: number }
  | { type: 'stripe'; requestId: number; bitmap: ImageBitmap }
  | { type: 'error'; id?: number; requestId?: number; message: string };

const bitmaps = new Map<number, ImageBitmap>();
const scope = self as unknown as {
  onmessage: ((event: MessageEvent<Request>) => void) | null;
  postMessage(message: Response, transfer?: Transferable[]): void;
};

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

scope.onmessage = (event) => {
  const request = event.data;
  if (request.type === 'release') {
    bitmaps.get(request.id)?.close();
    bitmaps.delete(request.id);
    return;
  }
  void (async () => {
    try {
      if (request.type === 'decode') {
        const response = await fetch(request.url, { credentials: 'same-origin' });
        if (!response.ok) throw new Error(`Texture request failed (${response.status}).`);
        const bitmap = await createImageBitmap(await response.blob(), {
          imageOrientation: 'flipY',
          premultiplyAlpha: 'none',
        });
        bitmaps.get(request.id)?.close();
        bitmaps.set(request.id, bitmap);
        scope.postMessage({
          type: 'ready',
          id: request.id,
          width: bitmap.width,
          height: bitmap.height,
        });
        return;
      }
      const source = bitmaps.get(request.id);
      if (!source) throw new Error('Decoded preview texture is no longer resident.');
      const rowCount = Math.max(1, Math.min(request.height, source.height - request.y));
      const stripe = await createImageBitmap(source, 0, request.y, source.width, rowCount, {
        premultiplyAlpha: 'none',
      });
      scope.postMessage({ type: 'stripe', requestId: request.requestId, bitmap: stripe }, [stripe]);
    } catch (error) {
      scope.postMessage({
        type: 'error',
        ...(request.type === 'decode' ? { id: request.id } : { requestId: request.requestId }),
        message: errorMessage(error),
      });
    }
  })();
};
