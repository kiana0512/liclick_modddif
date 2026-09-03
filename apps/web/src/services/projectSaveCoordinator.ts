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

type ProjectSaveExecutionRequest = {
  snapshot: { id: string };
  editVersion: number;
};

type PendingProjectSave<Request, Result> = {
  request: Request;
  waiters: Array<{
    resolve: (result: Result) => void;
    reject: (error: unknown) => void;
  }>;
};

/**
 * Serializes project saves without preserving obsolete intermediate snapshots.
 * An active write is allowed to finish because it may already have uploaded
 * assets, while every request arriving behind it shares one latest-pending
 * execution. This keeps Ctrl+S from waiting behind a backlog of autosaves.
 */
export class LatestProjectSaveExecutor<
  Request extends ProjectSaveExecutionRequest,
  Result,
> {
  private active?: { request: Request; promise: Promise<Result> };
  private pending?: PendingProjectSave<Request, Result>;

  constructor(private readonly execute: (request: Request) => Promise<Result>) {}

  enqueue(request: Request): Promise<Result> {
    if (!this.active) return this.start(request);

    const sameProject = this.active.request.snapshot.id === request.snapshot.id;
    if (
      sameProject &&
      request.editVersion <= this.active.request.editVersion &&
      !this.pending
    ) {
      return this.active.promise;
    }

    return new Promise<Result>((resolve, reject) => {
      if (!this.pending) {
        this.pending = { request, waiters: [{ resolve, reject }] };
        return;
      }
      const pendingSameProject = this.pending.request.snapshot.id === request.snapshot.id;
      if (!pendingSameProject || request.editVersion >= this.pending.request.editVersion) {
        this.pending.request = request;
      }
      this.pending.waiters.push({ resolve, reject });
    });
  }

  private start(request: Request): Promise<Result> {
    const promise = Promise.resolve().then(() => this.execute(request));
    this.active = { request, promise };
    void promise.then(
      () => this.drain(),
      () => this.drain(),
    );
    return promise;
  }

  private drain() {
    this.active = undefined;
    const pending = this.pending;
    this.pending = undefined;
    if (!pending) return;
    const promise = this.start(pending.request);
    void promise.then(
      (result) => pending.waiters.forEach((waiter) => waiter.resolve(result)),
      (error) => pending.waiters.forEach((waiter) => waiter.reject(error)),
    );
  }
}
