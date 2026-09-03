import { events } from '@react-three/fiber';

/**
 * M03 / ALG-VIEW-INPUT-001 v1.0.0.
 * Wheel navigation belongs to BlenderOrbitControls' native, frame-batched
 * listener. R3F otherwise raycasts every clickable model for every wheel
 * packet, even though the scene has no onWheel handlers.
 *
 * Keep the other R3F handlers intact (selection, hover and pointer capture).
 * Do not cancel or stop the DOM event: camera controls, panel scrolling and
 * passive performance observers must still receive the original input.
 */
export const createViewportEvents: typeof events = (store) => {
  const manager = events(store);
  if (manager.handlers) manager.handlers.onWheel = () => {};
  return manager;
};
