import { events } from '@react-three/fiber';

const paintPointers = new WeakMap<EventTarget, number | undefined>();
const navigationPointers = new WeakMap<EventTarget, number | undefined>();

/** ALG-VIEW-INPUT-001/1.3.2: both hover paths share pre-contact Alt ownership. */
export function isViewportNavigationPointer(target: EventTarget, event: Pick<PointerEvent, 'altKey' | 'pointerId' | 'buttons'>) {
  const pointerId = navigationPointers.get(target);
  return event.altKey || (pointerId !== undefined && pointerId === event.pointerId && event.buttons !== 0);
}

// Native brush ownership survives pointer capture release and tool changes
// until the next non-paint contact. No scene/store subscription is needed.
export function setViewportPaintPointer(target: EventTarget, pointerId?: number) {
  paintPointers.set(target, pointerId);
  if (pointerId !== undefined) navigationPointers.delete(target);
}

/**
 * M03 / ALG-VIEW-INPUT-001 v1.3.0.
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
    const pointerDown = handlers.onPointerDown;
    handlers.onPointerDown = (event) => {
      const pointer = event as PointerEvent;
      const navigates = pointer.altKey && pointer.button >= 0 && pointer.button <= 2 && pointer.pointerType !== 'touch';
      navigationPointers.set(event.target!, navigates ? pointer.pointerId : undefined);
      if (!navigates) pointerDown?.(event);
    };
    const pointerMove = handlers.onPointerMove;
    handlers.onPointerMove = (event) => {
      // Reserve the first held-Alt hover too, before pointerdown latches an id.
      // Ordinary hover resumes after both the modifier and buttons lift.
      if (isViewportNavigationPointer(event.target!, event as PointerEvent)) return;
      pointerMove?.(event);
    };
    for (const key of ['onPointerUp', 'onClick', 'onDoubleClick', 'onContextMenu'] as const) {
      const handle = handlers[key];
      handlers[key] = (event) => {
        const pointerId = navigationPointers.get(event.target!) ?? paintPointers.get(event.target!);
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
