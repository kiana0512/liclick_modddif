const CACHE_NAME = 'liclick-content-aware-projection-v1';
const CACHE_PATH = '/__liclick_internal_cache/content-aware-projection/';
const MAX_CACHE_ENTRIES = 4;

async function createCacheRequest(signature: string) {
  const bytes = new TextEncoder().encode(signature);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const key = Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join(
    '',
  );
  return new Request(`${location.origin}${CACHE_PATH}${key}`);
}

/**
 * Reads an exact straight-RGBA projection composite persisted by a previous
 * editor session. Raw bytes deliberately avoid PNG decode/colour conversion,
 * so a cold page reload can restore a 2K repair source without reprojecting
 * every view or touching a canvas on the interaction thread.
 */
export async function readContentAwareProjectionBake(
  signature: string,
  width: number,
  height: number,
) {
  if (!('caches' in window) || !crypto.subtle) return undefined;
  try {
    const cache = await caches.open(CACHE_NAME);
    const response = await cache.match(await createCacheRequest(signature));
    if (!response) return undefined;
    if (
      Number(response.headers.get('x-liclick-width')) !== width ||
      Number(response.headers.get('x-liclick-height')) !== height
    ) {
      return undefined;
    }
    const bytes = new Uint8ClampedArray(await response.arrayBuffer());
    if (bytes.byteLength !== width * height * 4) return undefined;
    return new ImageData(bytes, width, height);
  } catch (error) {
    console.warn('[Liclick Content Aware] Could not read the persistent projection cache.', error);
    return undefined;
  }
}

/** Writes only after an authoritative full-quality bake has completed. */
export async function writeContentAwareProjectionBake(
  signature: string,
  imageData: ImageData,
) {
  if (!('caches' in window) || !crypto.subtle) return;
  try {
    const cache = await caches.open(CACHE_NAME);
    // Response consumes its own ArrayBuffer; this bounded copy prevents a
    // background cache write from detaching or mutating the live repair input.
    const bytes = new Uint8Array(imageData.data.byteLength);
    bytes.set(imageData.data);
    await cache.put(
      await createCacheRequest(signature),
      new Response(bytes, {
        headers: {
          'content-type': 'application/octet-stream',
          'x-liclick-width': String(imageData.width),
          'x-liclick-height': String(imageData.height),
          'x-liclick-created-at': String(Date.now()),
        },
      }),
    );
    const keys = await cache.keys();
    if (keys.length > MAX_CACHE_ENTRIES) {
      await Promise.all(keys.slice(0, keys.length - MAX_CACHE_ENTRIES).map((key) => cache.delete(key)));
    }
  } catch (error) {
    console.warn('[Liclick Content Aware] Could not persist the projection cache.', error);
  }
}

