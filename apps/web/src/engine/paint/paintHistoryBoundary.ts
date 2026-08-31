// One boundary for keyboard and toolbar history. Waiting never blocks the UI thread.
export class PaintHistoryBoundary {
  private pending = new Set<Promise<unknown>>();
  private actions: Array<() => void> = [];
  private draining = false;
  private epoch = 0;

  get busy() {
    return this.draining;
  }
  get version() {
    return this.epoch;
  }

  track(work: Promise<unknown>) {
    this.pending.add(work);
    void work.then(
      () => this.pending.delete(work),
      () => this.pending.delete(work),
    );
  }

  run(action: () => void) {
    if (!this.draining && this.pending.size === 0) {
      action();
      return;
    }
    this.actions.push(action);
    if (this.draining) return;
    this.draining = true;
    void this.drain(this.epoch);
  }

  reset() {
    this.epoch += 1;
    this.actions = [];
    this.pending.clear();
    this.draining = false;
  }

  private async drain(epoch: number) {
    try {
      while (this.actions.length && epoch === this.epoch) {
        while (this.pending.size && epoch === this.epoch)
          await Promise.allSettled([...this.pending]);
        if (epoch !== this.epoch) return;
        this.actions.shift()?.();
      }
    } finally {
      if (epoch === this.epoch) this.draining = false;
    }
  }
}

export const paintHistoryBoundary = new PaintHistoryBoundary();
