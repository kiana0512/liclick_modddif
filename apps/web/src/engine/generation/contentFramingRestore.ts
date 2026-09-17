import type { GenerationFraming } from '@liclick/contracts';
import { urlToImageData } from '@/engine/localRepaint/imageUtils';
import { yieldToBrowserTask } from '@/utils/browserScheduling';
import { restoredFrameLayout } from './contentFraming';
import { encode, load } from './contentFramingImages';
import {
  validateFramedSilhouette,
  type FramedSilhouettePolicy,
} from './contentFramingSilhouette';

/** Decode and QA are a return-only path; keep them out of the submission framing chunk. */
export async function restoreContentFraming(
  url: string,
  framing: GenerationFraming,
  signal?: AbortSignal,
  silhouettePolicy: FramedSilhouettePolicy = 'strict',
) {
  const image = await load(url, signal);
  const layout = restoredFrameLayout(framing, image.naturalWidth, image.naturalHeight);
  if (framing.version === 2) {
    const pixels = await urlToImageData(image.src, undefined, undefined, {
      cooperative: true,
      signal,
    });
    await validateFramedSilhouette(framing, pixels, async () => {
      signal?.throwIfAborted();
      await yieldToBrowserTask();
    }, silhouettePolicy);
    signal?.throwIfAborted();
  }
  const canvas = document.createElement('canvas');
  canvas.width = layout.width;
  canvas.height = layout.height;
  try {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('无法创建回贴画布。');
    ctx.drawImage(image, layout.left, layout.top, layout.patchWidth, layout.patchHeight);
    const result = await encode(canvas);
    signal?.throwIfAborted();
    return result;
  } finally {
    canvas.width = canvas.height = 0;
  }
}
