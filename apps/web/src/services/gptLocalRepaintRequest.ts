import type { LiclickGenerateTextureSingleViewInput } from './liclickApiClient';
import type { Capture } from '@/types/capture';
import type { ReferenceImage } from '@/types/project';
import type { SceneObject } from '@/types/model';
import type { GptTextureModel } from '@/engine/generation/gptTextureModels';
import { getGptTextureRequestParameters } from '@/engine/generation/gptTextureModels';

/** Deliberately no mask/expanded selection in the provider contract. */
export function buildGptLocalRepaintRequest(input: {
  generationId: string; projectId: string; prompt: string; model: GptTextureModel;
  guideUrl: string; normalUrl: string; reference?: ReferenceImage; capture: Capture; object?: SceneObject;
  quality?: string;
  resolution: string;
  signal?: AbortSignal;
}): LiclickGenerateTextureSingleViewInput {
  if (!input.normalUrl) throw new Error('缺少同视角法线图，未提交 GPT 局部重绘任务。');
  const guide: ReferenceImage = { id: `${input.generationId}-guide`,
    name: 'image-1-current-view-clay-selection.png', url: input.guideUrl,
    width: input.capture.width, height: input.capture.height, isPrimary: true };
  const normal: ReferenceImage = { ...guide, id: `${input.generationId}-normal`,
    name: 'image-2-geometry-view-normal.png', url: input.normalUrl, isPrimary: false };
  const referenceImages = [guide, normal, ...(input.reference ? [{ ...input.reference }] : [])];
  return {
    clientGenerationId: input.generationId, projectId: input.projectId,
    workflow: 'local-repaint', mode: 'single', prompt: input.prompt,
    referenceIds: referenceImages.map((image) => image.id), referenceImages,
    pixelExactReferenceIds: [guide.id, normal.id],
    signal: input.signal,
    capture: input.capture, object: input.object, model: input.model,
    ...getGptTextureRequestParameters(input.resolution, input.quality, input.model), visibleOnly: true, upscale: false,
  };
}
