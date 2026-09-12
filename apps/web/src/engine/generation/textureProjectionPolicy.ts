import type { Generation } from '@/types/generation';

/** GPT-TRANSPARENT-TEXTURE/1.0.0: use the recorded request, never migrate by model name. */
export function preservesGeneratedSourceAlpha(generation: Pick<Generation, 'metadata'>) {
  const metadata = generation.metadata;
  if (metadata.workflow === 'local-repaint' &&
      metadata.repaintResultPolicy === 'gpt-source-alpha-v1') return true;
  const params = metadata.extraParams;
  return metadata.provider === 'liclick-atlas' &&
    (metadata.workflow === 'texture-map' || metadata.workflow === 'local-repaint') &&
    typeof params === 'object' && params !== null &&
    'background' in params && params.background === 'transparent';
}

export function textureProjectionIgnoresSourceAlpha(generation: Pick<Generation, 'mode' | 'metadata'>) {
  return usesCaptureMaskTextureProjection(generation)
    ? !preservesGeneratedSourceAlpha(generation) : undefined;
}

/** Each texture-map result is one captured camera, even in a multiview batch.
 * Batch scheduling must not select a different projection footprint.
 * Excludes material-reference generation and surface-locked local repaint.
 */
export function usesCaptureMaskTextureProjection(
  generation: Pick<Generation, 'mode' | 'metadata'>,
) {
  return (
    generation.metadata.workflow === 'texture-map' &&
    (generation.mode === 'single' || generation.mode === 'multiview')
  );
}
