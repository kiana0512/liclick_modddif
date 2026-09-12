import type { LiclickGenerateTextureSingleViewInput } from './liclickApiClient';
import type { Capture } from '@/types/capture';
import type { ReferenceImage } from '@/types/project';
import type { SceneObject } from '@/types/model';
import type { GptTextureModel } from '@/engine/generation/gptTextureModels';
import { getGptTextureRequestParameters } from '@/engine/generation/gptTextureModels';

/** Deliberately no mask/expanded selection in the provider contract. */
export function buildGptLocalRepaintRequest(input: {
  generationId: string; projectId: string; prompt: string; model: GptTextureModel;
  guideUrl: string; reference: ReferenceImage; capture: Capture; object?: SceneObject;
  quality?: string;
  resolution: string;
}): LiclickGenerateTextureSingleViewInput {
  const guide: ReferenceImage = { ...input.reference, id: `${input.generationId}-guide`,
    name: 'current-view-clay-selection.png', url: input.guideUrl };
  return {
    clientGenerationId: input.generationId, projectId: input.projectId,
    workflow: 'local-repaint', mode: 'single', prompt: input.prompt,
    referenceIds: [guide.id, input.reference.id], referenceImages: [guide, input.reference],
    capture: input.capture, object: input.object, model: input.model,
    ...getGptTextureRequestParameters(input.resolution, input.quality), visibleOnly: true, upscale: false,
  };
}
