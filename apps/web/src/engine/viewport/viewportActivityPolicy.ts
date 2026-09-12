export type RetainedViewportFrameloop = 'always' | 'demand' | 'never';
export type RetainedRuntimeFrameLeaseMode = 'none' | 'invalidate' | 'advance';

export function getRetainedViewportFrameloop(
  active: boolean,
  keepRuntimeActive = false,
): RetainedViewportFrameloop {
  if (active) return 'always';
  return keepRuntimeActive ? 'demand' : 'never';
}

export function shouldWakeRetainedViewport(previousActive: boolean, active: boolean) {
  return active && !previousActive;
}

export function shouldMountRetainedViewportRenderer(retained: boolean) {
  return retained;
}

export function getRetainedRuntimeFrameLeaseMode(
  workspaceActive: boolean,
  runtimeBackgrounded: boolean,
): RetainedRuntimeFrameLeaseMode {
  if (runtimeBackgrounded) return 'advance';
  return workspaceActive ? 'none' : 'invalidate';
}
