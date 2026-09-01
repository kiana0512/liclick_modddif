import {
  captureCurrentColorPreview,
  snapshotCurrentCaptureCamera,
} from '@/engine/capture/captureCurrentView';
import type { SerializedCameraInput } from '@/engine/capture/captureTypes';
import { useSceneStore } from '@/stores/sceneStore';
import type { ReferenceImage } from '@/types/project';
import { revokeRegisteredObjectUrl } from '@/utils/blobUrlRegistry';
import { urlToDataUrl } from './workspaceApiClient';
import { prepareReferenceForPromptPolish } from './referenceImagePreprocessor';
import type { PromptPolishImageInput } from './liclickApiClient';

const promptPolishCaptureResolution = 2048;
// Changing empty-request diagnosis must not reuse prompts from the old policy.
export const LOCAL_REPAINT_AUTO_DIAGNOSIS_POLICY = 'one-sentence-diagnosis-to-klein-v2';
// Any local repaint result from an older conversion contract must miss the prompt cache once.
export const LOCAL_REPAINT_PROMPT_TEMPLATE_POLICY = 'qwen-to-klein-material-grounding-v7';

export type LocalRepaintPromptPolishInputs = {
  currentEffectImage: PromptPolishImageInput;
  maskImage: PromptPolishImageInput;
  referenceImage: PromptPolishImageInput;
  paintMaskRevision: number;
};

/**
 * Freezes the same authored BaseColor view and RGB selection mask used by the
 * local-repaint workflow, without archiving a Capture or mutating the project.
 * Image 2 is the complete reference image currently selected by the user.
 * The server derives a Qwen-only clean selection crop from Image 1 and this
 * original mask; the browser and ModelView request contracts stay unchanged.
 */
export async function prepareLocalRepaintPromptPolishInputs(input: {
  objectId: string;
  reference: ReferenceImage;
  cameraSnapshot?: SerializedCameraInput;
  currentEffectUrl?: string;
  maskUrl?: string;
  paintMaskRevision?: number;
}): Promise<LocalRepaintPromptPolishInputs> {
  const sceneState = useSceneStore.getState();
  if (!sceneState.paintMaskHasContent) throw new Error('请先绘制局部重绘蒙版。');
  if (!sceneState.paintMaskCapture) throw new Error('局部重绘蒙版尚未准备完成，请稍后重试。');

  const aspect = 1;
  const cameraSnapshot = input.cameraSnapshot ?? snapshotCurrentCaptureCamera(aspect);
  const paintMaskRevision = input.paintMaskRevision ?? sceneState.paintMaskRevision;
  const preparedReferencePromise = prepareReferenceForPromptPolish(input.reference);
  // Reference decoding may finish before the two GPU captures. Mark that
  // rejection as observed now; Promise.all below still propagates it.
  void preparedReferencePromise.catch(() => undefined);
  let maskUrl = input.maskUrl;
  let currentEffectUrl = input.currentEffectUrl;
  const ownsMaskUrl = !maskUrl;
  const ownsCurrentEffectUrl = !currentEffectUrl;
  try {
    maskUrl ??= await sceneState.paintMaskCapture({
      aspect,
      camera: cameraSnapshot.camera,
      resolution: promptPolishCaptureResolution,
    });
    if (!maskUrl) throw new Error('无法读取已绘制的局部重绘蒙版。');

    if (!currentEffectUrl) {
      const currentEffect = await captureCurrentColorPreview({
        objectId: input.objectId,
        resolution: promptPolishCaptureResolution,
        framing: 'current',
        colorMode: 'viewport-clean',
        aspect,
        cameraSnapshot,
      });
      currentEffectUrl = currentEffect.colorUrl;
    }
    const [currentEffectDataUrl, maskDataUrl, preparedReference] = await Promise.all([
      urlToDataUrl(currentEffectUrl),
      urlToDataUrl(maskUrl),
      preparedReferencePromise,
    ]);

    return {
      currentEffectImage: { name: 'current-effect.png', dataUrl: currentEffectDataUrl },
      maskImage: { name: 'white-edit-mask.png', dataUrl: maskDataUrl },
      referenceImage: {
        name: input.reference.name || 'material-reference',
        dataUrl: preparedReference.url,
      },
      paintMaskRevision,
    };
  } finally {
    if (ownsCurrentEffectUrl) revokeRegisteredObjectUrl(currentEffectUrl);
    if (ownsMaskUrl) revokeRegisteredObjectUrl(maskUrl);
  }
}
