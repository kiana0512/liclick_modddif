type PendingRefresh = {
  ownerKey: string;
  run: () => Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
};

export type AssetHistoryRefreshCoordinator = {
  schedule(ownerKey: string, itemKey: string, run: () => Promise<void>): Promise<void>;
};

function positiveInteger(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return value;
}

export function createAssetHistoryRefreshCoordinator(options: {
  globalConcurrency: number;
  perOwnerConcurrency: number;
}): AssetHistoryRefreshCoordinator {
  const globalConcurrency = positiveInteger(options.globalConcurrency, 'globalConcurrency');
  const perOwnerConcurrency = positiveInteger(options.perOwnerConcurrency, 'perOwnerConcurrency');
  if (perOwnerConcurrency > globalConcurrency) {
    throw new Error('perOwnerConcurrency cannot exceed globalConcurrency.');
  }

  const pending: PendingRefresh[] = [];
  const activeByOwner = new Map<string, number>();
  const inFlight = new Map<string, Promise<void>>();
  let active = 0;

  const drain = () => {
    while (active < globalConcurrency) {
      const pendingIndex = pending.findIndex(
        (refresh) => (activeByOwner.get(refresh.ownerKey) ?? 0) < perOwnerConcurrency,
      );
      if (pendingIndex < 0) return;
      const [refresh] = pending.splice(pendingIndex, 1);
      active += 1;
      activeByOwner.set(refresh.ownerKey, (activeByOwner.get(refresh.ownerKey) ?? 0) + 1);

      void Promise.resolve()
        .then(refresh.run)
        .then(refresh.resolve, refresh.reject)
        .finally(() => {
          active -= 1;
          const ownerActive = (activeByOwner.get(refresh.ownerKey) ?? 1) - 1;
          if (ownerActive > 0) activeByOwner.set(refresh.ownerKey, ownerActive);
          else activeByOwner.delete(refresh.ownerKey);
          drain();
        });
    }
  };

  return {
    schedule(ownerKey, itemKey, run) {
      const normalizedOwnerKey = ownerKey.trim();
      const normalizedItemKey = itemKey.trim();
      if (!normalizedOwnerKey || !normalizedItemKey) {
        return Promise.reject(new Error('Refresh owner and item keys are required.'));
      }
      const sharedKey = `${normalizedOwnerKey}\u0000${normalizedItemKey}`;
      const existing = inFlight.get(sharedKey);
      if (existing) return existing;

      const scheduled = new Promise<void>((resolve, reject) => {
        pending.push({ ownerKey: normalizedOwnerKey, run, resolve, reject });
      });
      const tracked = scheduled.finally(() => {
        if (inFlight.get(sharedKey) === tracked) inFlight.delete(sharedKey);
      });
      inFlight.set(sharedKey, tracked);
      drain();
      return tracked;
    },
  };
}

export async function waitForAssetHistoryRefreshBudget(
  refreshes: Promise<void>[],
  budgetMs: number,
) {
  if (refreshes.length === 0) return;
  const normalizedBudgetMs = positiveInteger(budgetMs, 'budgetMs');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.allSettled(refreshes).then(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, normalizedBudgetMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
