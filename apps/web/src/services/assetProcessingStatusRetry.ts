import type { AssetProcessingStatus } from './assetProcessingApiClient';

const assetStatusRetryDelaysMs = [5_000, 15_000, 30_000] as const;

export function assetProcessingStatusNeedsRetry(status: AssetProcessingStatus) {
  return status.capacityCheckPassed !== true;
}

export function assetProcessingStatusRetryDelay(attempt: number) {
  const safeAttempt = Number.isFinite(attempt) ? Math.max(0, Math.floor(attempt)) : 0;
  return assetStatusRetryDelaysMs[
    Math.min(safeAttempt, assetStatusRetryDelaysMs.length - 1)
  ];
}
