export type RetainedViewportFrameloop = 'always' | 'demand';

export function getRetainedViewportFrameloop(active: boolean): RetainedViewportFrameloop {
  return active ? 'always' : 'demand';
}

export function shouldWakeRetainedViewport(previousActive: boolean, active: boolean) {
  return active && !previousActive;
}

export function shouldMountRetainedViewportRenderer(active: boolean) {
  return active;
}
