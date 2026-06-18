export type CapturePassName = 'color' | 'mask' | 'depth' | 'normal';

export type CapturePipelineState = {
  requestedPasses: CapturePassName[];
  completedPasses: CapturePassName[];
};
