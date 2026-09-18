import type { Capture } from '@/types/capture';
import { captureCurrentNormalGuide } from '../capture/captureCurrentView';
import type { SerializedCameraInput } from '../capture/captureTypes';

/** MODELVIEW-NORMAL-INPUT/1.0.0: raw geometry guide, never masked or filtered. */
export async function captureLocalRepaintNormal(
  capture: Capture,
  cameraSnapshot: SerializedCameraInput,
  signal: AbortSignal,
): Promise<Capture> {
  signal.throwIfAborted();
  const normal = await captureCurrentNormalGuide({
    objectId: capture.objectId,
    resolution: 2048,
    framing: 'current',
    aspect: capture.width / capture.height,
    cameraSnapshot,
    signal,
  });
  signal.throwIfAborted();
  if (normal.width !== capture.width || normal.height !== capture.height)
    throw new Error('法线图与效果图尺寸不一致，未提交局部重绘。');
  return { ...capture, normalUrl: normal.normalUrl };
}
