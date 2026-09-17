import assert from 'node:assert/strict';
import {
  createAssetHistoryRefreshCoordinator,
  waitForAssetHistoryRefreshBudget,
} from '../dist/services/assetHistoryRefreshCoordinator.js';

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

assert.throws(
  () => createAssetHistoryRefreshCoordinator({ globalConcurrency: 0, perOwnerConcurrency: 1 }),
  /positive integer/,
);
assert.throws(
  () => createAssetHistoryRefreshCoordinator({ globalConcurrency: 2, perOwnerConcurrency: 3 }),
  /cannot exceed/,
);

const coordinator = createAssetHistoryRefreshCoordinator({
  globalConcurrency: 3,
  perOwnerConcurrency: 2,
});
const activeByOwner = new Map();
const calls = new Map();
let active = 0;
let maximumActive = 0;
const maximumByOwner = new Map();

function schedule(ownerKey, itemKey, options = {}) {
  return coordinator.schedule(ownerKey, itemKey, async () => {
    calls.set(`${ownerKey}:${itemKey}`, (calls.get(`${ownerKey}:${itemKey}`) ?? 0) + 1);
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    const ownerActive = (activeByOwner.get(ownerKey) ?? 0) + 1;
    activeByOwner.set(ownerKey, ownerActive);
    maximumByOwner.set(ownerKey, Math.max(maximumByOwner.get(ownerKey) ?? 0, ownerActive));
    try {
      await delay(options.delayMs ?? 20);
      if (options.fail) throw new Error(`refresh failed: ${itemKey}`);
    } finally {
      active -= 1;
      activeByOwner.set(ownerKey, (activeByOwner.get(ownerKey) ?? 1) - 1);
    }
  });
}

const firstShared = schedule('owner-a', 'shared-job', { delayMs: 35 });
const secondShared = coordinator.schedule('owner-a', 'shared-job', async () => {
  throw new Error('Duplicate refresh must not execute.');
});
assert.equal(secondShared, firstShared, 'Concurrent owner/job refreshes must share one Promise.');

const refreshes = [firstShared];
for (let index = 0; index < 6; index += 1) {
  refreshes.push(schedule('owner-a', `a-${index}`));
  refreshes.push(schedule('owner-b', `b-${index}`));
}
refreshes.push(schedule('owner-c', 'failure', { fail: true }));
refreshes.push(schedule('owner-c', 'after-failure'));

const results = await Promise.allSettled(refreshes);
assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
assert.equal(calls.get('owner-a:shared-job'), 1, 'Shared refresh must execute exactly once.');
assert.equal(maximumActive, 3, 'Coordinator must use but never exceed the global capacity.');
for (const [ownerKey, maximum] of maximumByOwner) {
  assert(
    maximum <= 2,
    `${ownerKey} exceeded the per-owner concurrency limit: ${maximum}`,
  );
}
assert.equal(calls.get('owner-c:after-failure'), 1, 'A failed refresh must release its slot.');

const slowRefresh = schedule('owner-budget', 'slow', { delayMs: 80 });
const waitStartedAt = Date.now();
await waitForAssetHistoryRefreshBudget([slowRefresh], 10);
const budgetElapsedMs = Date.now() - waitStartedAt;
assert(budgetElapsedMs < 70, `Wait budget did not return promptly: ${budgetElapsedMs}ms.`);
await slowRefresh;

console.log(
  `Asset history refresh coordinator passed: global ${maximumActive}/3, ` +
  `per-owner <=2, shared in-flight, failure recovery and ${budgetElapsedMs}ms budget wait.`,
);
