export type SequentialCameraView = {
  id: string;
  viewDirection: [number, number, number];
};

/**
 * Keeps the active view first, then greedily chooses the nearest camera
 * direction. Adjacent projections therefore share as much visible surface as
 * possible, so each returned layer contributes to the next view's input.
 */
export function orderCameraViewsForSequentialGeneration<T extends SequentialCameraView>(
  views: readonly T[],
  preferredFirstViewId?: string,
) {
  if (views.length < 2) return [...views];
  const remaining = [...views];
  const preferredIndex = preferredFirstViewId
    ? remaining.findIndex((view) => view.id === preferredFirstViewId)
    : -1;
  const first = remaining.splice(preferredIndex >= 0 ? preferredIndex : 0, 1)[0];
  if (!first) return [];
  const ordered = [first];
  while (remaining.length > 0) {
    const previous = ordered[ordered.length - 1]!.viewDirection;
    let bestIndex = 0;
    let bestDot = Number.NEGATIVE_INFINITY;
    remaining.forEach((candidate, index) => {
      const candidateLength = Math.hypot(...candidate.viewDirection) || 1;
      const dot =
        (previous[0] * candidate.viewDirection[0] +
          previous[1] * candidate.viewDirection[1] +
          previous[2] * candidate.viewDirection[2]) /
        candidateLength;
      if (dot > bestDot) {
        bestDot = dot;
        bestIndex = index;
      }
    });
    ordered.push(remaining.splice(bestIndex, 1)[0]!);
  }
  return ordered;
}
