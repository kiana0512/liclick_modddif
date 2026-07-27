let activePointerCount = 0;
let lastInteractionAt = 0;

export function markViewportInteractionStart() {
  activePointerCount += 1;
  lastInteractionAt = performance.now();
}

export function markViewportInteractionActivity() {
  lastInteractionAt = performance.now();
}

export function markViewportInteractionEnd() {
  activePointerCount = Math.max(0, activePointerCount - 1);
  lastInteractionAt = performance.now();
}

export function isViewportInteractionBusy(quietWindowMs = 180) {
  return (
    activePointerCount > 0 ||
    (lastInteractionAt > 0 && performance.now() - lastInteractionAt < quietWindowMs)
  );
}
