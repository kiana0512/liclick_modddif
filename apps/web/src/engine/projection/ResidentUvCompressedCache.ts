/** Lossless derived UV cache. Disk entries require a verified, account-scoped source digest. */
export class ResidentUvCompressedCache {
  private worker?: Worker;
  private disabled = false;
  private encoding = false;
  private activeKey?: string;
  private queued?: { key: string; image: ImageData; mask?: Uint8Array; persistentKey?: string; scope?: string };
  private nextId = 0;
  private known = new Set<string>();
  private pending = new Map<
    number,
    (response: {
      output?: ArrayBuffer;
      resolution?: number;
      maskLength?: number;
      keys?: string[];
      persistentKey?: string;
    }) => void
  >();
  private getWorker() {
    if (this.disabled || typeof CompressionStream === 'undefined') return undefined;
    if (!this.worker) {
      try {
        this.worker = new Worker(
          new URL('../../workers/residentUvCache.worker.ts', import.meta.url),
          { type: 'module' },
        );
      } catch {
        this.disabled = true;
        return undefined;
      }
      this.worker.onmessage = ({ data }) => {
        if (data.miss) document.body.dataset.residentUvCacheMiss = data.miss;
        if (data.diskWrite) document.body.dataset.residentUvCacheWrite = data.diskWrite;
        const resolve = this.pending.get(data.id);
        this.pending.delete(data.id);
        if (data.keys) this.known = new Set(data.keys);
        resolve?.(data.error ? {} : data);
      };
      this.worker.onerror = () => this.dispose();
    }
    return this.worker;
  }
  async restore(key: string, persistentKey?: string, scope?: string, latest = false) {
    if (!latest && !this.known.has(key) && !persistentKey) return undefined;
    const worker = this.getWorker();
    if (!worker) return undefined;
    const id = ++this.nextId;
    const result = await new Promise<{
      output?: ArrayBuffer;
      resolution?: number;
      maskLength?: number;
      persistentKey?: string;
    }>((resolve) => {
      this.pending.set(id, resolve);
      try {
        worker.postMessage({ id, type: latest ? 'restore-latest' : 'restore', key, persistentKey, scope });
      } catch {
        this.pending.delete(id);
        resolve({});
      }
    });
    if (!result.output || !result.resolution) {
      this.known.delete(key);
      return undefined;
    }
    const size = result.resolution ** 2 * 4;
    return {
      imageData: new ImageData(
        new Uint8ClampedArray(result.output, 0, size),
        result.resolution,
        result.resolution,
      ),
      renderedColorMask: new Uint8Array(result.output, size, result.maskLength),
      persistentKey: result.persistentKey,
    };
  }
  /** Ownership of the completed CPU arrays transfers only after texture upload. */
  offer(key: string, image: ImageData, mask?: Uint8Array, persistentKey?: string, scope?: string) {
    if (this.known.has(key)) return;
    const worker = this.getWorker();
    if (!worker) return;
    // Only transfer complete owned buffers; callers with slices keep their data.
    if (
      image.data.byteOffset ||
      image.data.byteLength !== image.data.buffer.byteLength ||
      (mask && (mask.byteOffset || mask.byteLength !== mask.buffer.byteLength))
    )
      return;
    if (this.encoding) { this.queued = { key, image, mask, persistentKey, scope }; return; }
    const id = ++this.nextId;
    const color = image.data.buffer,
      maskBuffer = mask?.buffer ?? new ArrayBuffer(0);
    this.encoding = true;
    this.pending.set(id, () => {
      this.encoding = false;
      const queued = this.queued;
      this.queued = undefined;
      if (queued) this.offer(queued.key, queued.image, queued.mask, queued.persistentKey);
    });
    try {
      worker.postMessage(
        { id, type: 'store', key, color, mask: maskBuffer, resolution: image.width, persistentKey, scope },
        [color, maskBuffer],
      );
    } catch {
      this.encoding = false;
      this.pending.delete(id);
    }
  }
  activate(key: string) {
    if (this.activeKey === key) return;
    this.activeKey = key;
    try { this.getWorker()?.postMessage({ id: ++this.nextId, type: 'activate', key }); }
    catch { /* Optional disk retention never blocks the presented GPU buffer. */ }
  }
  dispose() {
    this.disabled = true;
    this.queued = undefined;
    this.worker?.terminate();
    this.worker = undefined;
    this.pending.forEach((resolve) => resolve({}));
    this.pending.clear();
    this.known.clear();
  }
}
