/** Lossless derived UV cache. Disk entries require a verified, account-scoped source digest. */
export class ResidentUvCompressedCache {
  private worker?: Worker;
  private disabled = false;
  private encoding = false;
  private nextId = 0;
  private known = new Set<string>();
  private pending = new Map<
    number,
    (response: {
      output?: ArrayBuffer;
      resolution?: number;
      maskLength?: number;
      keys?: string[];
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
  async restore(key: string, persistentKey?: string) {
    if (!this.known.has(key) && !persistentKey) return undefined;
    const worker = this.getWorker();
    if (!worker) return undefined;
    const id = ++this.nextId;
    const result = await new Promise<{
      output?: ArrayBuffer;
      resolution?: number;
      maskLength?: number;
    }>((resolve) => {
      this.pending.set(id, resolve);
      try {
        worker.postMessage({ id, type: 'restore', key, persistentKey });
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
    };
  }
  /** Ownership of the completed CPU arrays transfers only after texture upload. */
  offer(key: string, image: ImageData, mask?: Uint8Array, persistentKey?: string) {
    if (this.encoding || this.known.has(key)) return;
    const worker = this.getWorker();
    if (!worker) return;
    // Only transfer complete owned buffers; callers with slices keep their data.
    if (
      image.data.byteOffset ||
      image.data.byteLength !== image.data.buffer.byteLength ||
      (mask && (mask.byteOffset || mask.byteLength !== mask.buffer.byteLength))
    )
      return;
    const id = ++this.nextId;
    const color = image.data.buffer,
      maskBuffer = mask?.buffer ?? new ArrayBuffer(0);
    this.encoding = true;
    this.pending.set(id, () => {
      this.encoding = false;
    });
    try {
      worker.postMessage(
        { id, type: 'store', key, color, mask: maskBuffer, resolution: image.width, persistentKey },
        [color, maskBuffer],
      );
    } catch {
      this.encoding = false;
      this.pending.delete(id);
    }
  }
  dispose() {
    this.disabled = true;
    this.worker?.terminate();
    this.worker = undefined;
    this.pending.forEach((resolve) => resolve({}));
    this.pending.clear();
    this.known.clear();
  }
}
