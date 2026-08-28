import {
  assetProcessingStatusNeedsRetry,
  assetProcessingStatusRetryDelay,
} from '../apps/web/src/services/assetProcessingStatusRetry.ts';

const expectedDelays = [5_000, 15_000, 30_000, 30_000];
for (const [attempt, expected] of expectedDelays.entries()) {
  const actual = assetProcessingStatusRetryDelay(attempt);
  if (actual !== expected) {
    throw new Error(`Unexpected retry delay for attempt ${attempt}: ${actual}`);
  }
}

if (assetProcessingStatusRetryDelay(-4) !== 5_000) {
  throw new Error('Negative retry attempts must use the initial delay.');
}

if (assetProcessingStatusNeedsRetry({ capacityCheckPassed: true }) !== false) {
  throw new Error('A successful capacity probe must stop automatic retries.');
}

for (const capacityCheckPassed of [false, undefined]) {
  if (assetProcessingStatusNeedsRetry({ capacityCheckPassed }) !== true) {
    throw new Error('A failed or missing capacity probe must be retried.');
  }
}

process.stdout.write('Asset status retry smoke passed.\n');
