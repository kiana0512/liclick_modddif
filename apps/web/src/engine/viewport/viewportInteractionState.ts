let activePointerCount = 0;
let lastInteractionAt = 0;
const listeners = new Set<() => void>();

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
  notifyInteractionChanged();
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
