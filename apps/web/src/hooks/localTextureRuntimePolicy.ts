import type { LocalTextureRuntimeState } from '@/services/localTextureRuntimeClient';

export const localTextureRuntimeFailureThreshold = 3;

export type LocalTextureRuntimeMonitorState = {
  runtime: LocalTextureRuntimeState;
  hasReadySession: boolean;
  reconnecting: boolean;
  consecutiveFailures: number;
};

export function createLocalTextureRuntimeMonitorState(): LocalTextureRuntimeMonitorState {
  return {
    runtime: { status: 'checking' },
    hasReadySession: false,
    reconnecting: false,
    consecutiveFailures: 0,
  };
}

export function beginLocalTextureRuntimeProbeCycle(
  current: LocalTextureRuntimeMonitorState,
): LocalTextureRuntimeMonitorState {
  if (current.hasReadySession || current.runtime.status === 'checking') return current;
  return {
    ...current,
    runtime: { status: 'checking' },
    reconnecting: true,
    consecutiveFailures: 0,
  };
}

export function applyLocalTextureRuntimeProbe(
  current: LocalTextureRuntimeMonitorState,
  next: LocalTextureRuntimeState,
): LocalTextureRuntimeMonitorState {
  if (next.status === 'ready') {
    return {
      runtime: next,
      hasReadySession: true,
      reconnecting: false,
      consecutiveFailures: 0,
    };
  }

  if (next.status === 'outdated') {
    return {
      runtime: next,
      hasReadySession: current.hasReadySession,
      reconnecting: false,
      consecutiveFailures: 0,
    };
  }

  if (next.status === 'checking') {
    return {
      ...current,
      runtime: current.hasReadySession ? current.runtime : next,
      reconnecting: current.hasReadySession || current.reconnecting,
    };
  }

  const consecutiveFailures = current.consecutiveFailures + 1;
  if (!current.hasReadySession && consecutiveFailures < localTextureRuntimeFailureThreshold) {
    return {
      runtime: { status: 'checking' },
      hasReadySession: false,
      reconnecting: true,
      consecutiveFailures,
    };
  }

  return {
    runtime: next,
    hasReadySession: current.hasReadySession,
    reconnecting: current.hasReadySession,
    consecutiveFailures,
  };
}

export function getLocalTextureRuntimeRetryDelay(
  current: LocalTextureRuntimeMonitorState,
): number | undefined {
  if (current.runtime.status !== 'missing' && current.runtime.status !== 'checking') {
    return undefined;
  }
  if (!current.hasReadySession) {
    if (
      current.consecutiveFailures <= 0 ||
      current.consecutiveFailures >= localTextureRuntimeFailureThreshold
    ) {
      return undefined;
    }
    return current.consecutiveFailures === 1 ? 600 : 1_200;
  }
  if (!current.reconnecting) return undefined;
  return Math.min(5_000, 750 * 2 ** Math.max(0, current.consecutiveFailures - 1));
}

export function createSingleFlightProbe<T>(probe: () => Promise<T>) {
  let inFlight: Promise<T> | undefined;
  return () => {
    if (inFlight) return inFlight;
    const pending = probe();
    inFlight = pending;
    const clear = () => {
      if (inFlight === pending) inFlight = undefined;
    };
    void pending.then(clear, clear);
    return pending;
  };
}
