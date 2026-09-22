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
  let cleanedPixels: ImageData | undefined;
  if (framing.version === 2) {
    const pixels = await urlToImageData(image.src, undefined, undefined, {
      cooperative: true,
      signal,
    });
    const checkpoint = async () => {
      signal?.throwIfAborted();
      await yieldToBrowserTask();
      signal?.throwIfAborted();
    };
    try {
      await validateFramedSilhouette(framing, pixels, checkpoint, silhouettePolicy);
    } catch (error) {
      if ((error as { code?: string }).code !== 'GPT_RETURN_SILHOUETTE_MISMATCH') throw error;
      const { cleanReturnBackground } = await import('./returnBackgroundCleanup');
      if (!await cleanReturnBackground(framing, pixels, checkpoint)) throw error;
      await validateFramedSilhouette(framing, pixels, checkpoint, silhouettePolicy);
      cleanedPixels = pixels;
    }
    signal?.throwIfAborted();
  }
  const canvas = document.createElement('canvas');
  canvas.width = layout.width;
  canvas.height = layout.height;
  try {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('无法创建回贴画布。');
    if (cleanedPixels) ctx.putImageData(cleanedPixels, layout.left, layout.top);
    else ctx.drawImage(image, layout.left, layout.top, layout.patchWidth, layout.patchHeight);
    const result = await encode(canvas);
    signal?.throwIfAborted();
    return result;
  } finally {
    canvas.width = canvas.height = 0;
  }
}
