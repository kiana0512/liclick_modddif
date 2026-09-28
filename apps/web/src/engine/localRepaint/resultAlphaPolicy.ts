// GPT-REPAINT-ALPHA/1.0.0: source alpha is independent of brush/visibility masks.
export const GPT_REPAINT_ALPHA_POLICY = 'gpt-source-alpha-v1';

export function preservesRepaintResultAlpha(metadata: Record<string, unknown>) {
  return metadata.repaintResultPolicy === GPT_REPAINT_ALPHA_POLICY ||
    metadata.modelSilhouetteClipVersion === 1 || metadata.modelSilhouetteClipVersion === 2;
}

export async function prepareRepaintResult(
  sourceUrl: string, depthUrl: string | undefined, isGpt: boolean, signal?: AbortSignal,
  originalUrl?: string, submittedMaskUrl?: string,
) {
  signal?.throwIfAborted();
  if (isGpt) {
    // Do not decode/re-encode, erode, crop, or overwrite the provider's RGBA.
    return { resultUrl: sourceUrl, metadata: {
      repaintResultPolicy: GPT_REPAINT_ALPHA_POLICY,
      modelSilhouetteClipVersion: undefined,
    } };
  }
  const { MODEL_SILHOUETTE_CLIP_VERSION, prepareModelClippedRepaint } =
    await import('./modelSilhouetteClip');
  if (!originalUrl || !submittedMaskUrl)
    throw new Error('局部重绘缺少原图或蒙版。');
  const resultUrl = await prepareModelClippedRepaint(
    sourceUrl, depthUrl, signal, originalUrl, submittedMaskUrl,
  );
  return { resultUrl, metadata: {
    repaintResultPolicy: 'model-silhouette-submitted-mask-v1',
    modelSilhouetteClipVersion: MODEL_SILHOUETTE_CLIP_VERSION,
  } };
}
