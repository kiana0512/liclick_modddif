export {};

type Request =
  | { type: 'decode'; id: number; url: string; maxSize?: number }
  | { type: 'adopt'; id: number; bitmap: ImageBitmap }
  | { type: 'adopt-mask'; id: number; mask: ArrayBuffer; width: number; height: number }
  | { type: 'stripe'; id: number; requestId: number; y: number; height: number }
  | { type: 'release'; id: number };
type Response =
  | { type: 'ready'; id: number; width: number; height: number }
  | { type: 'stripe'; requestId: number; bitmap: ImageBitmap }
  | { type: 'mask-stripe'; requestId: number; pixels: ArrayBuffer; width: number; height: number }
  | { type: 'error'; id?: number; requestId?: number; message: string };

type MaskSource = { data: Uint8Array; width: number; height: number };
const sources = new Map<number, ImageBitmap | MaskSource>();
const scope = self as unknown as {
  onmessage: ((event: MessageEvent<Request>) => void) | null;
  postMessage(message: Response, transfer?: Transferable[]): void;
};

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function replaceSource(id: number, source: ImageBitmap | MaskSource) {
  const previous = sources.get(id);
  if (previous && !('data' in previous)) previous.close();
  sources.set(id, source);
}

function postReady(id: number, source: ImageBitmap | MaskSource) {
  scope.postMessage({ type: 'ready', id, width: source.width, height: source.height });
}

scope.onmessage = (event) => {
  const request = event.data;
  if (request.type === 'release') {
    const source = sources.get(request.id);
    if (source && !('data' in source)) source.close();
    sources.delete(request.id);
    return;
  }
  void (async () => {
    try {
      if (request.type === 'decode') {
        const response = await fetch(request.url, { credentials: 'same-origin' });
        if (!response.ok) throw new Error(`Texture request failed (${response.status}).`);
        const sourceBitmap = await createImageBitmap(await response.blob(), {
          imageOrientation: 'flipY',
          premultiplyAlpha: 'none',
        });
        const scale = request.maxSize
          ? Math.min(1, request.maxSize / Math.max(sourceBitmap.width, sourceBitmap.height))
          : 1;
        const bitmap =
          scale < 1
            ? await createImageBitmap(sourceBitmap, {
                resizeWidth: Math.max(1, Math.round(sourceBitmap.width * scale)),
                resizeHeight: Math.max(1, Math.round(sourceBitmap.height * scale)),
                resizeQuality: 'medium',
                premultiplyAlpha: 'none',
              })
            : sourceBitmap;
        if (bitmap !== sourceBitmap) sourceBitmap.close();
        replaceSource(request.id, bitmap);
        postReady(request.id, bitmap);
        return;
      }
      if (request.type === 'adopt') {
        replaceSource(request.id, request.bitmap);
        postReady(request.id, request.bitmap);
        return;
      }
      if (request.type === 'adopt-mask') {
        const mask = new Uint8Array(request.mask);
        if (request.width * request.height !== mask.length) {
          throw new RangeError('Invalid preview mask dimensions.');
        }
        const source = { data: mask, width: request.width, height: request.height };
        replaceSource(request.id, source);
        postReady(request.id, source);
        return;
      }
      const source = sources.get(request.id);
      if (!source) throw new Error('Preview texture released.');
      const sourceWidth = source.width;
      const sourceHeight = source.height;
      const rowCount = Math.max(1, Math.min(request.height, sourceHeight - request.y));
      if ('data' in source) {
        const pixels = new Uint8Array(sourceWidth * rowCount);
        for (let row = 0; row < rowCount; row++) {
          const sourceRow = sourceHeight - 1 - request.y - row;
          const sourceOffset = sourceRow * sourceWidth;
          const destinationOffset = row * sourceWidth;
          pixels.set(source.data.subarray(sourceOffset, sourceOffset + sourceWidth), destinationOffset);
        }
        scope.postMessage(
          { type: 'mask-stripe', requestId: request.requestId, pixels: pixels.buffer, width: sourceWidth, height: rowCount },
          [pixels.buffer],
        );
        return;
      }
      const stripe = await createImageBitmap(source, 0, request.y, sourceWidth, rowCount, {
        premultiplyAlpha: 'none',
      });
      scope.postMessage({ type: 'stripe', requestId: request.requestId, bitmap: stripe }, [stripe]);
    } catch (error) {
      scope.postMessage({
        type: 'error',
        ...(request.type === 'stripe' ? { requestId: request.requestId } : { id: request.id }),
        message: errorMessage(error),
      });
    }
  })();
};
