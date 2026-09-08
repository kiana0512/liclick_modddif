import { createHash, randomUUID } from 'node:crypto';

// MODELVIEW-IDEMPOTENCY v1.1.0: keep accepted legacy keys stable for retries.
export function createModelviewIdempotencyKey(jobId: string, suffix: string) {
  const stableId = jobId.replace(/[^a-z0-9._-]+/gi, '-').slice(0, 160) || randomUUID();
  const legacyKey = `${stableId}:${suffix}`;
  if (legacyKey.length <= 128) return legacyKey;
  // Hash the entire original ID, including its distinguishing trailing UUID.
  return `${createHash('sha256').update(jobId).digest('hex')}:${suffix}`;
}
