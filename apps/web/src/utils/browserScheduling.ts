const DEFAULT_FRAME_FALLBACK_MS = 120;

type BrowserScheduler = {
  yield?: () => Promise<void>;
};

let taskYieldChannel: MessageChannel | undefined;
const taskYieldQueue: Array<() => void> = [];

/**
 * Yields to input/rendering without paying the nested-timer clamp of
 * `setTimeout(0)`. Texture streaming can yield thousands of times during a
 * cold 14-view bake, so even a 4ms timer floor turns cooperative scheduling
 * into seconds of artificial latency. Scheduler.yield keeps the continuation
 * ordered; MessageChannel is the unclamped task fallback.
 */
export function yieldToBrowserTask() {
  if (typeof window === 'undefined') return Promise.resolve();
  const scheduler = (globalThis as typeof globalThis & { scheduler?: BrowserScheduler }).scheduler;
  if (typeof scheduler?.yield === 'function') return scheduler.yield();
  return new Promise<void>((resolve) => {
    if (!taskYieldChannel) {
      taskYieldChannel = new MessageChannel();
      taskYieldChannel.port1.onmessage = () => taskYieldQueue.shift()?.();
    }
    taskYieldQueue.push(resolve);
    taskYieldChannel.port2.postMessage(0);
  });
}

function isDocumentVisible() {
  return typeof document === 'undefined' || document.visibilityState !== 'hidden';
}

/**
 * Runs work after a foreground paint, with a timer fallback for background tabs.
 * Chromium suspends requestAnimationFrame while a tab is hidden, so workflow
 * code must never await a bare rAF callback.
 */
export function scheduleAfterBrowserPaint(
  callback: () => void,
  fallbackMs = DEFAULT_FRAME_FALLBACK_MS,
) {
  if (typeof window === 'undefined') {
    queueMicrotask(callback);
    return () => undefined;
  }

  let settled = false;
  let frameId: number | undefined;
  let postPaintId: number | undefined;
  const finish = () => {
    if (settled) return;
    settled = true;
    if (frameId !== undefined) window.cancelAnimationFrame?.(frameId);
    if (fallbackId !== undefined) window.clearTimeout(fallbackId);
    if (postPaintId !== undefined) window.clearTimeout(postPaintId);
    callback();
  };

  if (isDocumentVisible() && typeof window.requestAnimationFrame === 'function') {
    frameId = window.requestAnimationFrame(() => {
      // Resume after every rAF subscriber has submitted its presentation work.
      postPaintId = window.setTimeout(finish, 0);
    });
  }
  const fallbackId = window.setTimeout(finish, isDocumentVisible() ? fallbackMs : 0);

  return () => {
    if (settled) return;
    settled = true;
    if (frameId !== undefined) window.cancelAnimationFrame?.(frameId);
    if (fallbackId !== undefined) window.clearTimeout(fallbackId);
    if (postPaintId !== undefined) window.clearTimeout(postPaintId);
  };
}

export function waitForBrowserPaint(fallbackMs = DEFAULT_FRAME_FALLBACK_MS) {
  return new Promise<void>((resolve) => scheduleAfterBrowserPaint(resolve, fallbackMs));
}

/**
 * Gives foreground rendering an idle slice without making background workflows
 * depend on requestIdleCallback, which may also be suspended in a hidden tab.
 */
export async function waitForBrowserIdle(timeoutMs = 800) {
  if (typeof window === 'undefined') return;
  await waitForBrowserPaint(Math.min(timeoutMs, DEFAULT_FRAME_FALLBACK_MS));
  if (!isDocumentVisible() || typeof window.requestIdleCallback !== 'function') {
    await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    return;
  }
  await new Promise<void>((resolve) => {
    let settled = false;
    const fallbackId = window.setTimeout(finish, timeoutMs);
    function finish() {
      if (settled) return;
      settled = true;
      window.clearTimeout(fallbackId);
      if (idleId !== undefined) window.cancelIdleCallback?.(idleId);
      resolve();
    }
    const idleId = window.requestIdleCallback(finish, { timeout: timeoutMs });
  });
}
