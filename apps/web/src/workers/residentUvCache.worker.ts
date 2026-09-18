/// <reference lib="webworker" />

type Entry = { bytes: Uint8Array<ArrayBuffer>; resolution: number; maskLength: number; persistentKey?: string };
const entries = new Map<string, Entry>();
let activeKey: string | undefined;
let diskWrites = Promise.resolve<string | undefined>(undefined);
const budget = 256 * 1024 * 1024;
const diskEntryLimit = 4;
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
function remember(key: string, entry: Entry) {
  const previous = entries.get(key);
  if (previous) { retained -= previous.bytes.byteLength; entries.delete(key); }
  for (const [oldest, old] of entries) {
    if (retained + entry.bytes.byteLength <= budget) break;
    if (oldest === activeKey) continue;
    retained -= old.bytes.byteLength; entries.delete(oldest);
  }
  if (retained + entry.bytes.byteLength > budget) return;
  entries.set(key, entry); retained += entry.bytes.byteLength;
}
async function writeDisk(key: string, entry: Entry) {
  try {
    const cache = await caches.open(diskCache);
    await cache.put(diskRequest(key), new Response(entry.bytes, { headers: {
      'content-type': 'application/octet-stream', 'x-sha256': await digest(entry.bytes),
      'x-resolution': String(entry.resolution), 'x-mask-length': String(entry.maskLength),
      'x-compressed-length': String(entry.bytes.byteLength),
    } }));
    // UV-DISPLAY-DERIVED-CACHE/1.2: project hydration can legitimately visit
    // A/B/C resident combinations before settling. A two-entry FIFO makes the
    // next reload miss A, then evict B, then evict C forever. Keep a tiny LRU
    // window, bounded by both entry count and compressed bytes, and pin the
    // actually presented state while trimming legacy entries conservatively.
    const keys = await cache.keys();
    const pinned = entries.get(activeKey ?? '')?.persistentKey;
    const protectedUrls = new Set([diskRequest(key), diskRequest(pinned ?? '')]);
    const records = await Promise.all(keys.map(async request => {
      const response = await cache.match(request);
      const declared = Number(response?.headers.get('x-compressed-length'));
      return {
        request,
        // Missing legacy metadata is charged at the full budget so migration
        // cannot silently retain an unbounded old cache.
        bytes: Number.isFinite(declared) && declared > 0 ? declared : budget,
      };
    }));
    let diskBytes = records.reduce((total, record) => total + record.bytes, 0);
    let diskEntries = records.length;
    for (const record of records) {
      if (diskEntries <= diskEntryLimit && diskBytes <= budget) break;
      if (protectedUrls.has(record.request.url)) continue;
      if (await cache.delete(record.request)) {
        diskEntries--;
        diskBytes -= record.bytes;
      }
    }
    return `saved:${diskEntries}`;
  } catch (error) { return error instanceof Error ? error.name : 'storage-unavailable'; }
}
function persist(entry: Entry, presentedKey?: string) {
  const key = entry.persistentKey;
  if (!validDiskKey(key)) return Promise.resolve(undefined);
  const result = diskWrites.then(() => presentedKey && presentedKey !== activeKey ? undefined : writeDisk(key, entry));
  diskWrites = result.catch(() => undefined);
  return result;
}
self.onmessage = async ({ data }) => {
  const { id, key, type } = data;
  try {
    if (type === 'activate') {
      activeKey = key;
      const entry = entries.get(key);
      const diskWrite = entry ? await persist(entry, key) : undefined;
      self.postMessage({ id, diskWrite });
      return;
    }
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
        const entry = { bytes, resolution: data.resolution, maskLength: mask.length,
          persistentKey: validDiskKey(data.persistentKey) ? data.persistentKey : undefined };
        remember(key, entry);
        diskWrite = await persist(entry);
      }
      self.postMessage({ id, keys: [...entries.keys()], retained, diskWrite });
    } else {
      let miss = 'memory-miss';
      const existing = entries.get(key);
      const entry: Entry | undefined = existing ?? (validDiskKey(data.persistentKey) ? await readDisk(data.persistentKey, reason => { miss = reason; }) : undefined);
      if (!entry) {
        self.postMessage({ id, miss });
        return;
      }
      if (!existing && validDiskKey(data.persistentKey)) entry.persistentKey = data.persistentKey;
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
      remember(key, entry);
      self.postMessage({ id, output, resolution: entry.resolution, maskLength: entry.maskLength, keys: [...entries.keys()] }, [
        output,
      ]);
    }
  } catch (error) {
    self.postMessage({ id, error: String(error) });
  }
};
export {};
