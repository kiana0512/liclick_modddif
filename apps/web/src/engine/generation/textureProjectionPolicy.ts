import type { Generation } from '@/types/generation';

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
