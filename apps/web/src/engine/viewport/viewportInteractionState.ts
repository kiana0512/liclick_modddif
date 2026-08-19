import { waitForBrowserPaint } from '@/utils/browserScheduling';

let activePointerCount = 0;
let lastInteractionAt = 0;
const listeners = new Set<() => void>();
const ACTIVITY_QUIET_WINDOW_MS = 180;
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
export async function waitForViewportInteractionIdle(quietWindowMs = 180) {
  while (isViewportInteractionBusy(quietWindowMs)) {
    // A hidden tab has no viewport presentation to protect. More importantly,
    // rAF is suspended there, so a stale pointer state must not freeze a queued
    // texture task until the user returns to this page.
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    await waitForBrowserPaint();
  }
}

export function subscribeViewportInteraction(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
