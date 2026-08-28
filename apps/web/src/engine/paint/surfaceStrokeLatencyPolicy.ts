export type SurfaceStrokeLatencyTarget = 'uv-image' | 'projected-mask' | 'inpaint-mask';

export function shouldCollapseSurfaceStrokeToLatestSample(input: {
  isMaskStroke: boolean;
  isProjectedLayerEraser: boolean;
}) {
  return input.isMaskStroke || input.isProjectedLayerEraser;
}

export function shouldDeferSurfaceStrokeCommit(input: {
  operation?: 'brush' | 'eraser';
  target: SurfaceStrokeLatencyTarget;
}) {
  return input.operation === 'eraser' && input.target === 'projected-mask';
}
