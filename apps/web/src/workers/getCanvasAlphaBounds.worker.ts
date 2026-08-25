type CanvasAlphaBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type CanvasAlphaBoundsRequest = {
  bitmap: ImageBitmap;
};

type CanvasAlphaBoundsResponse = {
  bounds?: CanvasAlphaBounds;
  error?: string;
};

const workerScope = self as unknown as {
  onmessage: ((event: MessageEvent<CanvasAlphaBoundsRequest>) => void) | null;
  postMessage(message: CanvasAlphaBoundsResponse): void;
};

workerScope.onmessage = (event) => {
  const { bitmap } = event.data;
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('Could not create alpha-bounds worker canvas.');
    context.drawImage(bitmap, 0, 0);
    bitmap.close();
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
    let minX = canvas.width;
    let minY = canvas.height;
    let maxX = -1;
    let maxY = -1;
    for (let y = 0; y < canvas.height; y += 1) {
      const rowOffset = y * canvas.width * 4;
      for (let x = 0; x < canvas.width; x += 1) {
        if (data[rowOffset + x * 4 + 3] === 0) continue;
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
    workerScope.postMessage({
      bounds:
        maxX < minX || maxY < minY
          ? undefined
          : {
              x: minX,
              y: minY,
              width: maxX - minX + 1,
              height: maxY - minY + 1,
            },
    });
  } catch (error) {
    bitmap.close();
    workerScope.postMessage({
      error: error instanceof Error ? error.message : 'Could not scan canvas alpha.',
    });
  }
};
