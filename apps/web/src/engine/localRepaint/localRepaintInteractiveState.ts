export const LOCAL_REPAINT_INTERACTIVE_STATE_EVENT = 'liclick:local-repaint-interactive-state';

export type LocalRepaintInteractiveStatus = 'preparing' | 'ready' | 'failed';

export type LocalRepaintSessionPhase =
  | 'idle'
  | 'loading-assets'
  | 'restoring-mask'
  | 'building-resident-material'
  | 'verifying-render-frame'
  | 'ready'
  | 'painting'
  | 'committing'
  | 'failed'
  | 'cancelled';

export type LocalRepaintInteractiveStateDetail = {
  sessionId?: string;
  generationId: string;
  targetLayerId?: string;
  status: LocalRepaintInteractiveStatus;
  phase?: LocalRepaintSessionPhase;
  activationRequested?: boolean;
  error?: string;
  updatedAt?: number;
};

type LocalRepaintSessionUpdate = {
  sessionId?: string;
  generationId: string;
  targetLayerId?: string;
  status: LocalRepaintInteractiveStatus;
  phase?: LocalRepaintSessionPhase;
  activationRequested?: boolean;
  error?: string;
};

let revision = 0;
let current: LocalRepaintInteractiveStateDetail | undefined;
const listeners = new Set<() => void>();
const activePreparations = new Map<string, Set<symbol>>();

/** Track actual work, not a potentially abandoned `preparing` snapshot. */
export function trackLocalRepaintPreparation(sessionId: string | undefined) {
  if (!sessionId) return () => undefined;
  const tasks = activePreparations.get(sessionId) ?? new Set<symbol>();
  const task = Symbol();
  tasks.add(task);
  activePreparations.set(sessionId, tasks);
  return () => {
    tasks.delete(task);
    if (tasks.size === 0 && activePreparations.get(sessionId) === tasks) {
      activePreparations.delete(sessionId);
    }
  };
}

export function isLocalRepaintPreparationInFlight(generationId: string, targetLayerId?: string) {
  return Boolean(
    matchesIdentity(current, generationId, targetLayerId) &&
      current?.status === 'preparing' &&
      current.sessionId &&
      activePreparations.get(current.sessionId)?.size,
  );
}

function matchesIdentity(
  state: LocalRepaintInteractiveStateDetail | undefined,
  generationId: string,
  targetLayerId?: string,
) {
  return state?.generationId === generationId && state.targetLayerId === targetLayerId;
}

function phaseForStatus(status: LocalRepaintInteractiveStatus): LocalRepaintSessionPhase {
  if (status === 'ready') return 'ready';
  if (status === 'failed') return 'failed';
  return 'loading-assets';
}

function emit() {
  listeners.forEach((listener) => listener());
  if (typeof window !== 'undefined' && current) {
    window.dispatchEvent(
      new CustomEvent<LocalRepaintInteractiveStateDetail>(
        LOCAL_REPAINT_INTERACTIVE_STATE_EVENT,
        { detail: current },
      ),
    );
  }
}

export function getLocalRepaintSessionSnapshot() {
  return current;
}

export function subscribeLocalRepaintSession(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function beginLocalRepaintSession(input: {
  generationId: string;
  targetLayerId?: string;
  activationRequested?: boolean;
}) {
  if (current && matchesIdentity(current, input.generationId, input.targetLayerId)) {
    if (input.activationRequested && !current.activationRequested) {
      current = { ...current, activationRequested: true, updatedAt: Date.now() };
      emit();
    }
    return current!;
  }
  revision += 1;
  current = {
    sessionId: `local-repaint-${revision}`,
    generationId: input.generationId,
    targetLayerId: input.targetLayerId,
    status: 'preparing',
    phase: 'loading-assets',
    activationRequested: input.activationRequested ?? false,
    updatedAt: Date.now(),
  };
  emit();
  return current;
}

export function requestLocalRepaintSessionActivation(
  generationId: string,
  targetLayerId?: string,
) {
  return beginLocalRepaintSession({ generationId, targetLayerId, activationRequested: true });
}

export function publishLocalRepaintInteractiveState(update: LocalRepaintSessionUpdate) {
  if (update.sessionId) {
    if (current?.sessionId !== update.sessionId) return false;
  } else if (!matchesIdentity(current, update.generationId, update.targetLayerId)) {
    // Only preparation can establish a new owner. Late completion from an old
    // generation is ignored instead of reviving a cancelled spinner.
    if (update.status !== 'preparing') return false;
    beginLocalRepaintSession(update);
  }
  if (!current) return false;
  current = {
    ...current,
    status: update.status,
    phase: update.phase ?? phaseForStatus(update.status),
    activationRequested: update.activationRequested ?? current.activationRequested,
    error: update.error,
    updatedAt: Date.now(),
  };
  emit();
  return true;
}

export function cancelLocalRepaintSession(sessionId?: string) {
  if (!current || (sessionId && current.sessionId !== sessionId)) return false;
  current = {
    ...current,
    status: 'failed',
    phase: 'cancelled',
    activationRequested: false,
    updatedAt: Date.now(),
  };
  emit();
  return true;
}

export async function withLocalRepaintSessionTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
) {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error(`${label}超时，请重试。`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}
