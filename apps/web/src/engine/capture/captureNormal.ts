import type { CaptureRequest } from './captureTypes';
import { makeMockCapture } from './captureTypes';

export async function captureNormal(_request: CaptureRequest) {
  return makeMockCapture('normal', '#ec4899');
}
