export type ModelImportPhase =
  | 'preparing'
  | 'reading'
  | 'parsing'
  | 'materials'
  | 'persisting'
  | 'registering'
  | 'complete';

export type ModelImportProgressEvent = {
  phase: ModelImportPhase;
  phaseProgress?: number;
  loadedBytes?: number;
  totalBytes?: number;
};

export type ModelImportProgressCallback = (event: ModelImportProgressEvent) => void;

const phaseRanges: Record<ModelImportPhase, readonly [number, number]> = {
  preparing: [0, 0.03],
  reading: [0.03, 0.52],
  parsing: [0.52, 0.7],
  materials: [0.7, 0.76],
  persisting: [0.76, 0.9],
  registering: [0.9, 1],
  complete: [1, 1],
};

function clampUnit(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

export function getModelImportPhaseProgress(event: ModelImportProgressEvent) {
  if (event.phaseProgress !== undefined) return clampUnit(event.phaseProgress);
  if (
    event.loadedBytes !== undefined &&
    event.totalBytes !== undefined &&
    event.totalBytes > 0
  ) {
    return clampUnit(event.loadedBytes / event.totalBytes);
  }
  return 0;
}

export function getModelImportFileProgress(event: ModelImportProgressEvent) {
  const [start, end] = phaseRanges[event.phase];
  return start + (end - start) * getModelImportPhaseProgress(event);
}

export function getModelImportBatchProgress(
  fileIndex: number,
  fileCount: number,
  event: ModelImportProgressEvent,
) {
  const safeCount = Math.max(1, Math.floor(fileCount));
  const safeIndex = Math.min(safeCount - 1, Math.max(0, Math.floor(fileIndex)));
  return clampUnit((safeIndex + getModelImportFileProgress(event)) / safeCount);
}

export function isModelImportProgressIndeterminate(event: ModelImportProgressEvent) {
  return (
    event.phase !== 'complete' &&
    event.phaseProgress === undefined &&
    !(event.totalBytes !== undefined && event.totalBytes > 0)
  );
}

export async function yieldForModelImportProgressPaint() {
  if (typeof requestAnimationFrame === 'function') {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    return;
  }
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}
