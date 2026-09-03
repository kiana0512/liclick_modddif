import { events } from '@react-three/fiber';

const paintPointers = new WeakMap<EventTarget, number | undefined>();

// Native brush ownership survives pointer capture release and tool changes
// until the next non-paint contact. No scene/store subscription is needed.
export function setViewportPaintPointer(target: EventTarget, pointerId?: number) {
  paintPointers.set(target, pointerId);
}

/**
 * M03 / ALG-VIEW-INPUT-001 v1.1.0.
 * Wheel navigation belongs to BlenderOrbitControls' native, frame-batched
 * listener. R3F otherwise raycasts every clickable model for every wheel
 * packet, even though the scene has no onWheel handlers.
 *
 * Native painting owns its up/click tail too; ordinary selection, hover and
 * R3F capture cleanup keep their existing dispatchers.
 * Do not cancel or stop the DOM event: camera controls, panel scrolling and
 * passive performance observers must still receive the original input.
 */
export const createViewportEvents: typeof events = (store) => {
  const manager = events(store);
  const handlers = manager.handlers;
  if (handlers) {
    handlers.onWheel = () => {};
    for (const key of ['onPointerUp', 'onClick', 'onDoubleClick', 'onContextMenu'] as const) {
      const handle = handlers[key];
      handlers[key] = (event) => {
        const pointerId = paintPointers.get(event.target!);
        if (
          pointerId !== undefined &&
          ((event as PointerEvent).pointerId ?? pointerId) === pointerId &&
          !store.getState().internal.capturedMap.has(pointerId)
        ) return;
        handle?.(event);
      };
    }
  }
  return manager;
};
