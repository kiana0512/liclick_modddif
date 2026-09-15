import type { Generation } from '@/types/generation';

const fields = ['id', 'prompt', 'referenceIds', 'captureId', 'resultUrl', 'status'] as const;
const metadataFields = ['clientGenerationId', 'serverJobId', 'projectId', 'workflow', 'taskId',
  'model', 'resultUrls', 'startedAt', 'completedAt', 'error', 'serverSubmitted'] as const;

function sameValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) => sameValue(value, right[index]));
  }
  return false;
}

/** GENERATION-RECOVERY-COMPARE/1.0.0: compare the original recovery fields
 * directly; never stringify megabytes of inline image data on each poll. */
export function sameGenerationRecovery(left: Generation | undefined, right: Generation | undefined) {
  if (left === right) return true;
  if (!left || !right) return false;
  return fields.every(key => sameValue(left[key], right[key])) &&
    metadataFields.every(key => sameValue(left.metadata[key], right.metadata[key]));
}
