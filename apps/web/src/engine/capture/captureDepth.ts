import type { CaptureRequest } from './captureTypes';
import { makeMockCapture } from './captureTypes';

export async function captureDepth(_request: CaptureRequest) {
  return makeMockCapture('depth', '#334155');
}
