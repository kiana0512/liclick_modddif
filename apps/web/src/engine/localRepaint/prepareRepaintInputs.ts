import type { Capture } from '@/types/capture';
import { revokeRegisteredObjectUrl } from '@/utils/blobUrlRegistry';
import { prepareLocalRepaintGenerationInput } from './generationInputWorker';

/** REPAINT-INPUT-PREPARE/1: overlap CPU input composition with the sole GPU normal capture. */
export async function prepareRepaintInputs(
  input: Parameters<typeof prepareLocalRepaintGenerationInput>[0],
  captureNormal: () => Promise<Capture>,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  // Drain both owners before returning, even if one rejects or cancellation arrives.
  const [prepared, normal] = await Promise.allSettled([
    Promise.resolve().then(() => prepareLocalRepaintGenerationInput(input)),
    Promise.resolve().then(captureNormal),
  ]);
  if (signal.aborted || prepared.status === 'rejected' || normal.status === 'rejected') {
    if (prepared.status === 'fulfilled') {
      for (const url of [prepared.value.compositeUrl, prepared.value.submittedMaskUrl, prepared.value.selectionMaskUrl]) {
        revokeRegisteredObjectUrl(url);
      }
    }
    if (normal.status === 'fulfilled') revokeRegisteredObjectUrl(normal.value.normalUrl);
    signal.throwIfAborted();
    throw prepared.status === 'rejected' ? prepared.reason : (normal as PromiseRejectedResult).reason;
  }
  return { prepared: prepared.value, capture: normal.value };
}
