const DEFAULT_FRAME_FALLBACK_MS = 120;

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
