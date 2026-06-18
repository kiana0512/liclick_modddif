import type { CaptureRequest } from './captureTypes';
import { makeMockCapture } from './captureTypes';

export async function captureMask(_request: CaptureRequest) {
  return makeMockCapture('mask', '#111827');
}
