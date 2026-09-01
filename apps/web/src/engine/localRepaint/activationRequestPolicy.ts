export type LocalRepaintActivationDisposition =
  | 'activate-now'
  | 'queue-until-unlocked'
  | 'blocked-generation-running'
  | 'blocked-no-result'
  | 'blocked-operation';

export function resolveLocalRepaintActivationDisposition(input: {
  localRepaintReady: boolean;
  operationLocked: boolean;
  localGenerationRunning: boolean;
  canQueueDuringTransition: boolean;
}): LocalRepaintActivationDisposition {
  if (!input.localRepaintReady) {
    if (input.canQueueDuringTransition) return 'queue-until-unlocked';
    return input.localGenerationRunning ? 'blocked-generation-running' : 'blocked-no-result';
  }
  if (!input.operationLocked) return 'activate-now';
  return input.canQueueDuringTransition ? 'queue-until-unlocked' : 'blocked-operation';
}
