import { waitForBrowserPaint } from '@/utils/browserScheduling';

let activePointerCount = 0;
let lastInteractionAt = 0;
const listeners = new Set<() => void>();
const ACTIVITY_QUIET_WINDOW_MS = 180;
const PAYLOAD_WORKER_THRESHOLD = 262_144;
let activityBurstActive = false;
let activityQuietTimer: ReturnType<typeof setTimeout> | undefined;

function notifyInteractionChanged() {
  listeners.forEach((listener) => listener());
}

export function markViewportInteractionStart() {
  activePointerCount += 1;
  lastInteractionAt = performance.now();
  notifyInteractionChanged();
}

export function markViewportInteractionActivity() {
  lastInteractionAt = performance.now();
  // Pointer drag already has explicit start/end notifications. Its move events
  // only refresh the quiet timestamp and must not post worker budget messages.
  if (activePointerCount > 0) return;

  // Wheel/trackpad input is a burst rather than a pointer capture. Notify
  // subscribers once when the burst starts, then once when it becomes quiet.
  // Raw events in between only update lastInteractionAt, so a 120/144Hz wheel
  // cannot compete with camera rendering by posting to every background worker.
  if (!activityBurstActive) {
    activityBurstActive = true;
    notifyInteractionChanged();
  }
  if (activityQuietTimer !== undefined) return;
  const settleActivityBurst = () => {
    const remainingMs = ACTIVITY_QUIET_WINDOW_MS - (performance.now() - lastInteractionAt);
    if (remainingMs > 0) {
      activityQuietTimer = setTimeout(settleActivityBurst, remainingMs);
      return;
    }
    activityQuietTimer = undefined;
    activityBurstActive = false;
    notifyInteractionChanged();
  };
  activityQuietTimer = setTimeout(settleActivityBurst, ACTIVITY_QUIET_WINDOW_MS);
}

export function markViewportInteractionEnd() {
  activePointerCount = Math.max(0, activePointerCount - 1);
  lastInteractionAt = performance.now();
  notifyInteractionChanged();
}

export function isViewportInteractionBusy(quietWindowMs = 180) {
  return (
    activePointerCount > 0 ||
    (typeof document !== 'undefined' &&
      (document.body.dataset.perfSimulatedViewportInteraction === '1' ||
        document.body.dataset.perfAutoOrbit === '1')) ||
    (lastInteractionAt > 0 && performance.now() - lastInteractionAt < quietWindowMs)
  );
}

/**
 * Gives camera input absolute priority over background GPU/CPU work. Heavy
 * jobs call this at safe boundaries; they keep their exact state and resume
 * after the pointer/wheel quiet window instead of competing for a frame.
 */
export async function waitForViewportInteractionIdle(quietWindowMs = 180, checkCancelled?: () => void) {
  checkCancelled?.();
  while (isViewportInteractionBusy(quietWindowMs)) {
    // A hidden tab has no viewport presentation to protect. More importantly,
    // rAF is suspended there, so a stale pointer state must not freeze a queued
    // texture task until the user returns to this page.
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    await waitForBrowserPaint();
    checkCancelled?.();
  }
}

async function runInteractionPayload<T>(
  request: Record<string, unknown>,
  transfer: Transferable[] = [],
) {
  await waitForViewportInteractionIdle();
  const worker = new Worker(
    new URL('../../workers/interactionPayload.worker.ts', import.meta.url),
    { type: 'module' },
  );
  return new Promise<T>((resolve, reject) => {
    const fail = () => {
      worker.terminate();
      reject();
    };
    worker.onerror = worker.onmessageerror = fail;
    worker.onmessage = ({ data }: MessageEvent<{ type: string; result?: unknown }>) => {
      if (data.type === 'ready') {
        void waitForViewportInteractionIdle().then(() => worker.postMessage({ type: 'release' }));
        return;
      }
      if (data.type === 'result') {
        worker.terminate();
        resolve(data.result as T);
      } else {
        fail();
      }
    };
    worker.postMessage(request, transfer);
  });
}

export async function interactionSafeJsonResponse<T>(response: Response): Promise<T | undefined> {
  const declared = +(response.headers.get('content-length') ?? Infinity);
  if (declared < PAYLOAD_WORKER_THRESHOLD) {
    return response.json().catch(() => undefined) as Promise<T | undefined>;
  }
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength < PAYLOAD_WORKER_THRESHOLD || typeof Worker === 'undefined') {
    try {
      if (bytes.byteLength >= PAYLOAD_WORKER_THRESHOLD) await waitForViewportInteractionIdle();
      return JSON.parse(new TextDecoder().decode(bytes)) as T;
    } catch {
      return undefined;
    }
  }
  try {
    return await runInteractionPayload<T>({ type: 'parse', bytes }, [bytes]);
  } catch {
    return undefined;
  }
}

export async function interactionSafeBlobDataUrl(blob: Blob) {
  const read = () =>
    new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error || new Error());
      reader.readAsDataURL(blob);
    });
  if (blob.size < PAYLOAD_WORKER_THRESHOLD) return read();
  if (typeof Worker === 'undefined') {
    await waitForViewportInteractionIdle();
    return read();
  }
  try {
    return await runInteractionPayload<string>({ type: 'data-url', blob });
  } catch {
    await waitForViewportInteractionIdle();
    return read();
  }
}

export function subscribeViewportInteraction(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
