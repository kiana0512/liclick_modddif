export type SequentialCameraView = {
  id: string;
  viewDirection: [number, number, number];
};

export const GPT_POLE_DIRECTION_THRESHOLD = 0.9;

function getCameraViewGenerationGroup(view: SequentialCameraView) {
  const [x, y, z] = view.viewDirection;
  const thresholdSquared = GPT_POLE_DIRECTION_THRESHOLD * GPT_POLE_DIRECTION_THRESHOLD;
  return y * y >= thresholdSquared * (x * x + y * y + z * z) ? Math.sign(y) : 0;
}

export function usesGptTextureGeneration(view: SequentialCameraView) {
  return getCameraViewGenerationGroup(view) !== 0;
}

/**
 * Custom views keep the same order used by the preview and execution pipeline:
 * ordinary remote views first, then GPT top views, then GPT bottom views.
 * Within the matching group a newly authored view is inserted at the nearest
 * angular path position without moving the established first tile.
 */
export function insertCameraViewByPreviewOrder<T extends SequentialCameraView>(
  views: readonly T[],
  nextView: T,
) {
  const targetGroup = getCameraViewGenerationGroup(nextView);
  if (targetGroup !== 0) {
    const firstBottom = views.findIndex((view) => getCameraViewGenerationGroup(view) < 0);
    const insertAt = targetGroup > 0 && firstBottom >= 0 ? firstBottom : views.length;
    return [...views.slice(0, insertAt), nextView, ...views.slice(insertAt)];
  }

  const firstPole = views.findIndex(usesGptTextureGeneration);
  const ordinaryEnd = firstPole < 0 ? views.length : firstPole;
  const nextDirection = nextView.viewDirection;
  let insertAt = 0;
  let nearestDot = -Infinity;
  for (let index = 0; index < ordinaryEnd; index += 1) {
    const direction = views[index]!.viewDirection;
    const dot =
      direction[0] * nextDirection[0] +
      direction[1] * nextDirection[1] +
      direction[2] * nextDirection[2];
    if (dot > nearestDot) {
      nearestDot = dot;
      insertAt = index + 1;
    }
  }
  // Keep the established first tile stable and leave GPT pole views at the tail.
  return [...views.slice(0, insertAt), nextView, ...views.slice(insertAt)];
}
