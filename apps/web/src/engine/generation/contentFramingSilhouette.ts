import type { GenerationFraming } from '@liclick/contracts';
import { cooperativeBounds, restoredFrameLayout } from './contentFraming';

export type FramedSilhouettePolicy = 'strict' | 'capture-mask';

/** GPT-RETURN-SILHOUETTE-QA/1.2.0. Conservative outer-bound check only. */
export async function validateFramedSilhouette(
  frame: GenerationFraming,
  image: Pick<ImageData, 'width' | 'height' | 'data'>,
  checkpoint?: () => Promise<void>,
  policy: FramedSilhouettePolicy = 'strict',
) {
  if (frame.version !== 2) return;
  const layout = restoredFrameLayout(frame, image.width, image.height),
    subject = frame.subject!;
  const [left, top, right, bottom] = await cooperativeBounds(image, true, 128, checkpoint);
  const sx = layout.width / frame.sourceWidth,
    sy = layout.height / frame.sourceHeight;
  const expected = [
    subject.left * sx - layout.left,
    subject.top * sy - layout.top,
    (subject.left + subject.width) * sx - layout.left,
    (subject.top + subject.height) * sy - layout.top,
  ];
  const actual = [left, top, right + 1, bottom + 1];
  // Capture-mask projection clips again by the immutable capture mask. The wider
  // edge tolerance accepts alpha feathering but still rejects empty/half/shifted returns.
  const relaxed = policy === 'capture-mask';
  const tolerance = Math.max(
    relaxed ? 32 : 16,
    Math.max(subject.width * sx, subject.height * sy) * (relaxed ? 0.12 : 0.02),
  );
  if (right < left || actual.some((value, index) => Math.abs(value - expected[index]) > tolerance)) {
    const mismatch = new Error('返图透明轮廓不对齐。') as Error & { code: string };
    mismatch.code = 'GPT_RETURN_SILHOUETTE_MISMATCH';
    throw mismatch;
  }
}
