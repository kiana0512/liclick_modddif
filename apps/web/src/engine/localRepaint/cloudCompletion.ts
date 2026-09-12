import type { Generation } from '@/types/generation';
import type { Capture } from '@/types/capture';
import { prepareRepaintResult, preservesRepaintResultAlpha } from './resultAlphaPolicy';

/** Same postprocessing for foreground and restored GPT repaint jobs. Never re-submit. */
export async function prepareCloudRepaintCompletion(generation: Generation, captures: Capture[], signal?: AbortSignal): Promise<Generation> {
  if (generation.metadata.workflow !== 'local-repaint' || generation.metadata.provider !== 'liclick-atlas' || !generation.resultUrl)
    return generation;
  if (preservesRepaintResultAlpha(generation.metadata))
    return generation;
  const capture = captures.find((item) => item.id === generation.captureId);
  const maskUrl = generation.metadata.authoredMaskUrl ?? capture?.maskUrl;
  if (!capture?.depthUrl || typeof maskUrl !== 'string' || !maskUrl)
    throw new Error('局部重绘的相机、深度或原始选区尚未恢复，暂不发布回贴结果。');
  const prepared = await prepareRepaintResult(generation.resultUrl, capture.depthUrl, true, signal);
  return { ...generation, mode: 'inpaint', resultUrl: prepared.resultUrl, metadata: {
    ...generation.metadata, maskUrl, authoredMaskUrl: maskUrl,
    captureCamera: capture.camera, rawResultUrl: generation.resultUrl,
    ...prepared.metadata, resultComposition: 'direct-v1',
  } };
}
