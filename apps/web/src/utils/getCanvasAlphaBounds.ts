export type CanvasAlphaBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

function getCanvasAlphaBoundsOnMainThread(
  canvas: HTMLCanvasElement,
): CanvasAlphaBounds | undefined {
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return undefined;
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
  if (maxX < minX || maxY < minY) return undefined;
  return {
    x: minX,
    y: minY,
    width: maxX - minX + 1,
    height: maxY - minY + 1,
  };
}

function getCanvasAlphaBoundsInWorker(canvas: HTMLCanvasElement) {
  return new Promise<CanvasAlphaBounds | undefined>((resolve, reject) => {
    const worker = new Worker(new URL('../workers/getCanvasAlphaBounds.worker.ts', import.meta.url), {
      type: 'module',
    });
    const finish = () => worker.terminate();
    worker.onmessage = (
      event: MessageEvent<{ bounds?: CanvasAlphaBounds; error?: string }>,
    ) => {
      finish();
      if (event.data.error) reject(new Error(event.data.error));
      else resolve(event.data.bounds);
    };
    worker.onerror = (event) => {
      finish();
      reject(new Error(event.message || 'Could not scan canvas alpha in the worker.'));
    };
    void createImageBitmap(canvas)
      .then((bitmap) => worker.postMessage({ bitmap }, [bitmap]))
      .catch((error) => {
        finish();
        reject(error);
      });
  });
}

/**
 * Finds the non-transparent area without scanning a 2K/4K canvas on the editor
 * thread. The synchronous implementation is kept only for older browsers.
 */
export async function getCanvasAlphaBoundsAsync(
  canvas: HTMLCanvasElement,
): Promise<CanvasAlphaBounds | undefined> {
  if (typeof Worker === 'undefined' || typeof createImageBitmap === 'undefined') {
    return getCanvasAlphaBoundsOnMainThread(canvas);
  }
  try {
    return await getCanvasAlphaBoundsInWorker(canvas);
  } catch (error) {
    console.warn(
      '[Liclick 3D Texture] Alpha-bounds worker failed; using main-thread fallback.',
      error,
    );
    return getCanvasAlphaBoundsOnMainThread(canvas);
  }
}
