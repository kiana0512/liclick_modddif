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

export function shouldUploadSurfaceStrokeProjectionTexture(input: {
  operation?: 'brush' | 'eraser';
  target: SurfaceStrokeLatencyTarget;
}) {
  // Projected erasing is presented by the UV keep-mask. Its screen-space
  // projection canvas is retained only for the later seam-refinement bake, so
  // uploading that second 512px texture on every pointer frame is pure GPU
  // traffic and can halve interaction throughput on a large projected stack.
  return !(input.operation === 'eraser' && input.target === 'projected-mask');
}
