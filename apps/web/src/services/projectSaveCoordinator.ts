export const PROJECT_AUTOSAVE_TRAILING_MS = 2_000;
export const PROJECT_AUTOSAVE_MAX_WAIT_MS = 10_000;
export const PROJECT_AUTOSAVE_BLOCKED_RETRY_MS = 1_000;

type TimerHandle = ReturnType<typeof globalThis.setTimeout>;

export type ProjectSaveClock = {
  now: () => number;
  setTimeout: (callback: () => void, delayMs: number) => TimerHandle;
  clearTimeout: (handle: TimerHandle) => void;
};

const defaultClock: ProjectSaveClock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: (handle) => globalThis.clearTimeout(handle),
};

export class ProjectSaveCoordinator {
  private trailingTimer?: TimerHandle;
  private maxWaitTimer?: TimerHandle;
  private firstPendingAt?: number;

  constructor(
    private readonly onSaveDue: () => void,
    private readonly clock: ProjectSaveClock = defaultClock,
    private readonly trailingMs = PROJECT_AUTOSAVE_TRAILING_MS,
    private readonly maxWaitMs = PROJECT_AUTOSAVE_MAX_WAIT_MS,
  ) {}

  scheduleEdit() {
    const now = this.clock.now();
    if (this.firstPendingAt === undefined) {
      this.firstPendingAt = now;
      this.maxWaitTimer = this.clock.setTimeout(() => this.runDueSave(), this.maxWaitMs);
    }

    if (this.trailingTimer !== undefined) this.clock.clearTimeout(this.trailingTimer);
    const remainingMaxWait = Math.max(0, this.maxWaitMs - (now - this.firstPendingAt));
    this.trailingTimer = this.clock.setTimeout(
      () => this.runDueSave(),
      Math.min(this.trailingMs, remainingMaxWait),
    );
  }

  retryAfter(delayMs = PROJECT_AUTOSAVE_BLOCKED_RETRY_MS) {
    this.clearTimers();
    this.firstPendingAt = this.clock.now();
    this.trailingTimer = this.clock.setTimeout(() => this.runDueSave(), delayMs);
    this.maxWaitTimer = this.clock.setTimeout(() => this.runDueSave(), this.maxWaitMs);
  }

  flush() {
    if (this.firstPendingAt === undefined) return;
    this.runDueSave();
  }

  cancel() {
    this.clearTimers();
    this.firstPendingAt = undefined;
  }

  dispose() {
    this.cancel();
  }

  private runDueSave() {
    this.clearTimers();
    this.firstPendingAt = undefined;
    this.onSaveDue();
  }

  private clearTimers() {
    if (this.trailingTimer !== undefined) this.clock.clearTimeout(this.trailingTimer);
    if (this.maxWaitTimer !== undefined) this.clock.clearTimeout(this.maxWaitTimer);
    this.trailingTimer = undefined;
    this.maxWaitTimer = undefined;
  }
}
