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

/**
 * A projected eraser stroke is first shown by a small live keep-mask and is
 * committed to the full-resolution resident mask asynchronously. UI actions
 * may rebuild the material stack while that commit is pending, so the shared
 * live authority must survive tool, layer and display-mode changes until the
 * resident mask is ready.
 */
export function shouldRetainProjectedEraserPreview(input: {
  target: SurfaceStrokeLatencyTarget;
  pendingPaintCommits: number;
  residentMaskBound?: boolean;
  layerVisible?: boolean;
}) {
  return (
    input.target === 'projected-mask' &&
    (input.pendingPaintCommits > 0 ||
      (input.layerVisible !== false && input.residentMaskBound === false))
  );
}
