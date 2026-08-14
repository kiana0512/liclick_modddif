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
      document.body.dataset.localRepaintGenerationBusy === '1') ||
    (lastInteractionAt > 0 && performance.now() - lastInteractionAt < quietWindowMs)
  );
}

export function subscribeViewportInteraction(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
