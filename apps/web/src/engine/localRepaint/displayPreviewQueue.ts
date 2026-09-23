import { isViewportInteractionBusy } from '@/engine/viewport/input';

export type DisplayPreviewRequest = { signal?: AbortSignal; revision?: number };
type Preview = { alignedUrl: string; fittedUrl: string };
type Job = {
  controller: AbortController;
  users: number;
  run: (signal: AbortSignal) => Promise<Preview>;
  promise: Promise<Preview>;
  resolve: (preview: Preview) => void;
  reject: (error: unknown) => void;
};

// UI copies only; never evict in-flight shared work or retain decoded pixels.
// The byte limit bounds encoded strings (conservatively two bytes per char).
export function createDisplayPreviewQueue(maxBytes = 32 * 1024 * 1024, maxEntries = 64) {
  const cache = new Map<string, { preview: Preview; bytes: number }>();
  const pending = new Map<string, Job>();
  let bytes = 0;
  let running = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => {
    if (!running && timer === undefined && pending.size) timer = setTimeout(drain, 32);
  };
  const drain = async () => {
    timer = undefined;
    if (typeof document !== 'undefined' && document.visibilityState !== 'hidden' &&
        isViewportInteractionBusy()) { schedule(); return; }
    const next = pending.entries().next().value;
    if (!next) return;
    const [key, job] = next;
    running = true;
    try {
      job.controller.signal.throwIfAborted();
      const preview = await job.run(job.controller.signal);
      job.controller.signal.throwIfAborted();
      const size = 2 * (key.length + preview.alignedUrl.length +
        (preview.fittedUrl === preview.alignedUrl ? 0 : preview.fittedUrl.length));
      if (size <= maxBytes) {
        cache.set(key, { preview, bytes: size });
        bytes += size;
        while (cache.size > maxEntries || bytes > maxBytes) {
          const oldest = cache.entries().next().value!;
          bytes -= oldest[1].bytes;
          cache.delete(oldest[0]);
        }
      }
      job.resolve(preview);
    } catch (error) { job.reject(error); }
    finally {
      if (pending.get(key) === job) pending.delete(key);
      running = false;
      schedule();
    }
  };
  return (key: string, run: Job['run'], signal?: AbortSignal): Promise<Preview> => {
    if (signal?.aborted) return Promise.reject(signal.reason);
    const cached = cache.get(key);
    if (cached) {
      cache.delete(key);
      cache.set(key, cached);
      return Promise.resolve(cached.preview);
    }
    let job = pending.get(key);
    if (!job) {
      let resolve!: Job['resolve'];
      let reject!: Job['reject'];
      const promise = new Promise<Preview>((yes, no) => { resolve = yes; reject = no; });
      job = { controller: new AbortController(), users: 0, run, promise, resolve, reject };
      pending.set(key, job);
      schedule();
    }
    const shared = job;
    shared.users += 1;
    return new Promise<Preview>((resolve, reject) => {
      let settled = false;
      const finish = (error?: unknown, preview?: Preview) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', abort);
        shared.users -= 1;
        if (error !== undefined) reject(error); else resolve(preview!);
        if (!shared.users && pending.get(key) === shared) {
          pending.delete(key);
          shared.controller.abort();
          shared.reject(shared.controller.signal.reason);
          if (!pending.size && timer !== undefined) { clearTimeout(timer); timer = undefined; }
        }
      };
      const abort = () => finish(signal!.reason);
      signal?.addEventListener('abort', abort, { once: true });
      shared.promise.then((preview) => finish(undefined, preview), (error) => finish(error));
    });
  };
}

export const requestDisplayPreview = createDisplayPreviewQueue();
