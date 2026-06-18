import type { CaptureRequest } from './captureTypes';
import { makeMockCapture } from './captureTypes';

export async function captureColor(_request: CaptureRequest) {
  return makeMockCapture('color', '#8b5cf6');
}
