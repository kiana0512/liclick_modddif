type LocalRepaintPreview = {
  id: string;
  generationId?: string;
  replacementTargetLayerId?: string;
  maskUrl?: string;
};

type LocalRepaintSource = {
  generationId?: string;
  targetLayerId?: string;
};

export type LocalRepaintPreviewActivationInput = {
  consumedKey: string;
  paintTool: string;
  preview?: LocalRepaintPreview;
  currentPreview?: LocalRepaintPreview;
  currentSource?: LocalRepaintSource;
  processedLayerIds: readonly string[];
};

export type LocalRepaintPreviewActivationResult = {
  nextConsumedKey: string;
  shouldActivate: boolean;
};

export function resolveLocalRepaintPreviewActivation(
  input: LocalRepaintPreviewActivationInput,
): LocalRepaintPreviewActivationResult {
  const preview = input.preview;
  if (!preview) return { nextConsumedKey: '', shouldActivate: false };

  // A different active paint tool is an explicit user choice. Keep the
  // consumed key warm so material refreshes do not steal the tool back.
  if (input.paintTool !== 'none') {
    return { nextConsumedKey: input.consumedKey, shouldActivate: false };
  }

  const sourceMatches =
    input.currentPreview?.id === preview.id &&
    input.currentSource?.generationId === preview.generationId &&
    input.currentSource?.targetLayerId === preview.replacementTargetLayerId;
  const materialReady = input.processedLayerIds.includes(preview.id);
  if (!sourceMatches || !materialReady) {
    // Do not consume an activation key before both the source and renderer are
    // ready. A later material pass must still be allowed to activate it.
    return { nextConsumedKey: '', shouldActivate: false };
  }

  const activationKey = [
    preview.id,
    preview.generationId ?? '',
    preview.replacementTargetLayerId ?? '',
    preview.maskUrl ?? '',
  ].join('|');
  return {
    nextConsumedKey: activationKey,
    shouldActivate: input.consumedKey !== activationKey,
  };
}
