/// <reference lib="webworker" />

const entries = new Map<
  string,
  { bytes: Uint8Array<ArrayBuffer>; resolution: number; maskLength: number }
>();
const budget = 256 * 1024 * 1024;
let retained = 0;
const diskCache = 'li3d-resident-uv-display-v1';
const diskRequest = (key: string) => `${self.location.origin}/__li3d_internal/resident-uv/${key}`;
const digest = async (bytes: Uint8Array<ArrayBuffer>) =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
const validDiskKey = (key: unknown): key is string => typeof key === 'string' && /^[a-f0-9]{64}$/.test(key);
async function readDisk(key: string, miss: (reason: string) => void) {
  try {
    const response = await (await caches.open(diskCache)).match(diskRequest(key));
    if (!response) { miss('not-found'); return; }
    const bytes = new Uint8Array(await response.arrayBuffer());
    const resolution = Number(response.headers.get('x-resolution'));
    const maskLength = Number(response.headers.get('x-mask-length'));
    if (![1024, 2048, 4096, 8192].includes(resolution) ||
      (maskLength !== 0 && maskLength !== resolution ** 2) || bytes.length > budget ||
      await digest(bytes) !== response.headers.get('x-sha256')) { miss('invalid-bytes-or-metadata'); return; }
    return { bytes, resolution, maskLength };
  } catch { miss('storage-unavailable'); }
}
async function writeDisk(key: string, entry: { bytes: Uint8Array<ArrayBuffer>; resolution: number; maskLength: number }) {
  try {
    const cache = await caches.open(diskCache);
    await cache.put(diskRequest(key), new Response(entry.bytes, { headers: {
      'content-type': 'application/octet-stream', 'x-sha256': await digest(entry.bytes),
      'x-resolution': String(entry.resolution), 'x-mask-length': String(entry.maskLength),
    } }));
    // Two full-resolution snapshots bound disk storage independently of the memory LRU.
    const keys = await cache.keys();
    for (const old of keys.slice(0, Math.max(0, keys.length - 2))) await cache.delete(old);
    return `saved:${keys.length}`;
  } catch (error) { return error instanceof Error ? error.name : 'storage-unavailable'; }
}
self.onmessage = async ({ data }) => {
  const { id, key, type } = data;
  try {
    if (type === 'store') {
      let diskWrite: string | undefined;
      const color = new Uint8Array(data.color),
        mask = new Uint8Array(data.mask);
      const source = new ReadableStream<BufferSource>({
        start(controller) {
          controller.enqueue(color);
          controller.enqueue(mask);
          controller.close();
        },
      });
      const bytes = new Uint8Array(
        await new Response(source.pipeThrough(new CompressionStream('deflate'))).arrayBuffer(),
      );
      if (bytes.byteLength <= budget) {
        const previous = entries.get(key);
        if (previous) {
          retained -= previous.bytes.byteLength;
          entries.delete(key);
        }
        while (retained + bytes.byteLength > budget && entries.size) {
          const oldest = entries.keys().next().value!;
          retained -= entries.get(oldest)!.bytes.byteLength;
          entries.delete(oldest);
        }
        const entry = { bytes, resolution: data.resolution, maskLength: mask.length };
        entries.set(key, entry);
        retained += bytes.byteLength;
        if (validDiskKey(data.persistentKey)) diskWrite = await writeDisk(data.persistentKey, entry);
      }
      self.postMessage({ id, keys: [...entries.keys()], retained, diskWrite });
    } else {
      let miss = 'memory-miss';
      const entry = entries.get(key) ?? (validDiskKey(data.persistentKey) ? await readDisk(data.persistentKey, reason => { miss = reason; }) : undefined);
      if (!entry) {
        self.postMessage({ id, miss });
        return;
      }
      if (entries.has(key)) { entries.delete(key); entries.set(key, entry); }
      const source = new ReadableStream<BufferSource>({
        start(controller) {
          controller.enqueue(entry.bytes);
          controller.close();
        },
      });
      const output = await new Response(
        source.pipeThrough(new DecompressionStream('deflate')),
      ).arrayBuffer();
      if (output.byteLength !== entry.resolution ** 2 * 4 + entry.maskLength)
        throw new Error('Invalid cached UV length');
      self.postMessage({ id, output, resolution: entry.resolution, maskLength: entry.maskLength }, [
        output,
      ]);
    }
  } catch (error) {
    self.postMessage({ id, error: String(error) });
  }
};
export {};
