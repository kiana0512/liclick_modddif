import { renderSceneToPngUrl } from './renderTargetUtils';
import type { CapturePassRequest, CapturePassOutput } from './captureTypes';

export async function captureColor(request: CapturePassRequest): Promise<CapturePassOutput> {
  return {
    url: await renderSceneToPngUrl(request),
    warnings: [],
  };
}
