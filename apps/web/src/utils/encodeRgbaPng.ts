function blobToDataUrl(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () =>
      typeof reader.result === 'string'
        ? resolve(reader.result)
        : reject(new Error('Could not encode PNG data URL.'));
    reader.onerror = () => reject(reader.error ?? new Error('Could not read encoded PNG.'));
    reader.readAsDataURL(blob);
  });
}

async function encodeRgbaPngOnMainThread(
  width: number,
  height: number,
  rgba: Uint8Array | Uint8ClampedArray,
) {
  // This module is loaded only as a compatibility fallback. Keeping it out of
  // the normal client graph also keeps fflate parsing away from editor startup.
  const { encodeRgbaPngBytes } = await import('@/utils/encodeRgbaPngCore');
  const png = encodeRgbaPngBytes(width, height, rgba);
  const pngBuffer = new ArrayBuffer(png.byteLength);
  new Uint8Array(pngBuffer).set(png);
  return pngBuffer;
}

function encodeRgbaPngInWorker(
  width: number,
  height: number,
  rgba: Uint8Array | Uint8ClampedArray,
) {
  const rgbaBuffer = new ArrayBuffer(rgba.byteLength);
  new Uint8Array(rgbaBuffer).set(new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength));
  return new Promise<ArrayBuffer>((resolve, reject) => {
    const worker = new Worker(new URL('../workers/encodeRgbaPng.worker.ts', import.meta.url), {
      type: 'module',
    });
    const finish = () => worker.terminate();
    worker.onmessage = (event: MessageEvent<{ png?: ArrayBuffer; error?: string }>) => {
      finish();
      if (event.data.png) resolve(event.data.png);
      else reject(new Error(event.data.error ?? 'Could not encode PNG in the worker.'));
    };
    worker.onerror = (event) => {
      finish();
      reject(new Error(event.message || 'Could not run the PNG encoding worker.'));
    };
    worker.postMessage({ width, height, rgba: rgbaBuffer }, [rgbaBuffer]);
  });
}

/**
 * Encodes straight (unassociated) RGBA bytes without passing through Canvas.
 * Canvas PNG export may erase RGB values beneath alpha=0, while ComfyUI needs
 * those RGB values for IMAGE and the alpha channel for MASK from the same file.
 * The pixel packing, CRC calculation and zlib compression run in a Worker so
 * submitting a local repaint does not block viewport input.
 */
export async function encodeRgbaPngDataUrl(
  width: number,
  height: number,
  rgba: Uint8Array | Uint8ClampedArray,
) {
  let pngBuffer: ArrayBuffer;
  if (typeof Worker === 'undefined') {
    pngBuffer = await encodeRgbaPngOnMainThread(width, height, rgba);
  } else {
    try {
      pngBuffer = await encodeRgbaPngInWorker(width, height, rgba);
    } catch (error) {
      console.warn('[Liclick 3D Texture] PNG worker failed; using main-thread fallback.', error);
      pngBuffer = await encodeRgbaPngOnMainThread(width, height, rgba);
    }
  }
  return blobToDataUrl(new Blob([pngBuffer], { type: 'image/png' }));
}
