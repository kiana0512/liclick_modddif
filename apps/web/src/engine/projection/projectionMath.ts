import type { ProjectionMatrixBundle } from './projectionTypes';

export function buildProjectionMatrixBundle(
  viewMatrix: number[],
  projectionMatrix: number[],
): ProjectionMatrixBundle {
  return {
    viewMatrix,
    projectionMatrix,
    inverseViewProjectionMatrix: [],
  };
}

export function projectWorldPointToUv(_worldPoint: [number, number, number], _bundle: ProjectionMatrixBundle) {
  // TODO: Implement perspective divide and UV remapping for projected layer preview.
  return [0.5, 0.5] as const;
}
