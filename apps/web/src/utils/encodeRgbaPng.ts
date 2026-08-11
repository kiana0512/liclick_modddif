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
  transferOwnership: boolean,
) {
  const canTransferSource =
    transferOwnership &&
    rgba.buffer instanceof ArrayBuffer &&
    rgba.byteOffset === 0 &&
    rgba.byteLength === rgba.buffer.byteLength;
  const rgbaBuffer = canTransferSource ? rgba.buffer : new ArrayBuffer(rgba.byteLength);
  if (!canTransferSource) {
    new Uint8Array(rgbaBuffer).set(new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength));
  }
  return new Promise<Blob>((resolve, reject) => {
    const worker = new Worker(new URL('../workers/encodeRgbaPng.worker.ts', import.meta.url), {
      type: 'module',
    });
    const finish = () => worker.terminate();
    worker.onmessage = (event: MessageEvent<{ blob?: Blob; error?: string }>) => {
      finish();
      if (event.data.blob) resolve(event.data.blob);
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
  return blobToDataUrl(await encodeRgbaPngBlob(width, height, rgba));
}

/**
 * Blob variant for persisted editor assets. This keeps RGB padding beneath
 * fully transparent texels intact, which Canvas.toBlob() is allowed to erase.
 */
export async function encodeRgbaPngBlob(
  width: number,
  height: number,
  rgba: Uint8Array | Uint8ClampedArray,
  options: { transferOwnership?: boolean } = {},
) {
  let pngBlob: Blob;
  if (typeof Worker === 'undefined') {
    pngBlob = new Blob([await encodeRgbaPngOnMainThread(width, height, rgba)], {
      type: 'image/png',
    });
  } else {
    try {
      pngBlob = await encodeRgbaPngInWorker(
        width,
        height,
        rgba,
        options.transferOwnership === true,
      );
    } catch (error) {
      if (options.transferOwnership) {
        throw new Error(
          `PNG worker failed after the final RGBA handoff: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      console.warn('[Liclick 3D Texture] PNG worker failed; using main-thread fallback.', error);
      pngBlob = new Blob([await encodeRgbaPngOnMainThread(width, height, rgba)], {
        type: 'image/png',
      });
    }
  }
  return pngBlob;
}
