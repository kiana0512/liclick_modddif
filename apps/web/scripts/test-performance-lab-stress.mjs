import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
// Vite drops null overrides while merging vite.config.ts. Ignore every path
// instead, so this one-shot SSR test never opens native filesystem watchers.
const vite = await createServer({ root, appType: 'custom', logLevel: 'silent', server: { middlewareMode: true, watch: { ignored: () => true } } });
const saved = new Map(['window', 'document', 'MutationObserver', 'PerformanceObserver'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
const frames = new Map();
const timers = new Map();
let nextId = 1;
let listenerCount = 0;
let observers = 0;
function target() {
  const listeners = new Map();
  return {
    addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, new Set()); const set = listeners.get(type); if (!set.has(fn)) { set.add(fn); listenerCount++; } },
    removeEventListener(type, fn) { if (listeners.get(type)?.delete(fn)) listenerCount--; },
    emit(type, extra = {}) { for (const fn of listeners.get(type) ?? []) fn({ type, ...extra }); },
  };
}
const fakeWindow = { ...target(), innerWidth: 1280, innerHeight: 720,
  requestAnimationFrame(fn) { const id = nextId++; frames.set(id, fn); return id; },
  cancelAnimationFrame(id) { frames.delete(id); },
  setInterval(fn) { const id = nextId++; timers.set(id, fn); return id; },
  clearInterval(id) { timers.delete(id); },
};
const canvas = target();
Object.assign(globalThis, { window: fakeWindow, document: { ...target(), body: { dataset: {} }, visibilityState: 'visible', querySelector: () => canvas },
  MutationObserver: class { observe() { observers++; } disconnect() { observers--; } },
  PerformanceObserver: undefined,
});
const referenceQuantile = (values, ratio) => [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * ratio) - 1)] ?? 0;
try {
  const { PerformanceLabCollector } = await vite.ssrLoadModule('/src/features/performanceLab/performanceLabCollector.ts');
  const metrics = await vite.ssrLoadModule('/src/engine/performance/performanceLabMetrics.ts');
  const { performanceScenarioOccludingUvIds, performanceScenarioVisibleBindings } = await vite.ssrLoadModule('/src/engine/performance/performanceScenarioLayers.ts');
  const opacityBindings = [0, 1, 2, 3, 4].map(arrayIndex => ({ layerId: `${arrayIndex}`, opacityUniform: `opacity${arrayIndex}`, arrayIndex }));
  for (const values of [[1, 0, 0.5, 0.0001, 0.00011], [0, 0, 0, 0, 0], [1, 1, 1, 1, 1]]) {
    const expected = opacityBindings.filter((_, index) => values[index] > 0.0001);
    assert.deepEqual(performanceScenarioVisibleBindings(opacityBindings, { compactLayerOpacities: { value: values } }), expected);
    const ordinary = Object.fromEntries(values.map((value, index) => [`opacity${index}`, { value }]));
    assert.deepEqual(performanceScenarioVisibleBindings(opacityBindings, ordinary), expected);
    // Packed slots are authoritative even if a stale named uniform disagrees.
    assert.deepEqual(performanceScenarioVisibleBindings(opacityBindings, { ...ordinary, compactLayerOpacities: { value: [0, 0, 0, 0, 0] } }), []);
  }
  assert.deepEqual(performanceScenarioVisibleBindings(undefined, {}), []);
  const layers = Object.freeze([
    { id: 'merged', objectId: 'a', type: 'uv', role: 'merged-uv', visible: true },
    { id: 'ordinary', objectId: 'a', type: 'uv', visible: false },
    { id: 'repair', objectId: 'a', type: 'uv', role: 'content-aware-underlay', visible: true },
    { id: 'projection', objectId: 'a', type: 'projected', visible: true },
    { id: 'other', objectId: 'b', type: 'uv', visible: true },
    { id: 'legacy', type: 'uv', visible: true },
  ].map(Object.freeze));
  assert.deepEqual(performanceScenarioOccludingUvIds(layers, 'a'), ['merged', 'ordinary', 'legacy']);
  assert.deepEqual(performanceScenarioOccludingUvIds([], 'a'), []);
  assert.deepEqual(performanceScenarioOccludingUvIds(layers), ['merged', 'ordinary', 'other', 'legacy']);
  const timeline = await vite.ssrLoadModule('/src/engine/performance/performanceTimeline.ts');
  timeline.setPerformanceTimelineEnabled(true);
  // Repeated sessions, pending wheel input at stop, and disposal of every handle.
  for (let cycle = 0; cycle < 100; cycle++) {
    const chunks = [];
    const collector = new PerformanceLabCollector(`stress-${cycle}`, chunk => chunks.push(chunk));
    collector.start();
    for (let event = 0; event < 1000; event++) fakeWindow.emit('wheel', { deltaX: 1, deltaY: -2 });
    for (let event = 0; event < 2001; event++) timeline.markPerformanceEvent('system', 'boundary');
    const summary = collector.stop();
    assert.equal(summary.timelineEventCount, 2001);
    assert.equal(summary.timelineEventDroppedCount, 1);
    const wheel = chunks.flatMap(chunk => chunk.inputs).filter(input => input.type === 'wheel');
    assert.equal(wheel.length, 1, 'stop before rAF must not lose the final wheel burst');
    assert.equal(wheel[0].rawEventCount, 1000);
    assert.equal(wheel[0].deltaY, -2000);
    assert.equal(frames.size + timers.size + listenerCount + observers, 0, 'a stopped session must leave no sampler, timer, observer or input handler');
    assert.throws(() => collector.stop(), /already ended/);
  }
  const retainedChunks = [];
  const retention = new PerformanceLabCollector('retention', chunk => retainedChunks.push(chunk));
  retention.start();
  let timestamp = retention.previousFrameAt;
  for (let index = 0; index < 216010; index++) {
    timestamp += index === 216009 ? 32000 : 1000 / 60;
    const [id, callback] = frames.entries().next().value;
    frames.delete(id);
    callback(timestamp);
    if (index % 300 === 0) retention.flushChunk();
  }
  const retainedSummary = retention.stop();
  assert.equal(retainedSummary.frameCount, 216010);
  assert.equal(retainedSummary.summaryFrameSamplesRetained, 216000);
  assert.equal(retainedSummary.frameMaximumMs, 32000, 'catastrophic stalls after retention fills must remain in the report');
  assert.equal(retainedChunks.reduce((total, chunk) => total + chunk.frames.length, 0), 216010);
  assert.equal(frames.size + timers.size + listenerCount + observers, 0);
  // Exact quantiles at empty, singleton, HUD and full Cloud retention boundaries.
  for (const count of [0, 1, 2, 99, 100, 7200, 50000, 216000]) {
    const collector = new PerformanceLabCollector(`summary-${count}`, () => {});
    const values = Array.from({ length: count }, (_, index) => index % 101 === 0 ? 59999 : ((index * 7919) % 100003) / 31);
    const original = [...values];
    // Seed retained data without spending an hour waiting for rAF callbacks.
    collector.frameDurations = values;
    collector.reactCommitDurations = values.slice(0, 50000);
    collector.scriptDurations = values.slice(0, 50000);
    const start = performance.now();
    const summary = collector.stop();
    const elapsed = performance.now() - start;
    assert.equal(summary.frameP50Ms, referenceQuantile(original, 0.5));
    assert.equal(summary.frameP95Ms, referenceQuantile(original, 0.95));
    assert.equal(summary.frameP99Ms, referenceQuantile(original, 0.99));
    assert.equal(summary.reactCommitP95Ms, referenceQuantile(original.slice(0, 50000), 0.95));
    assert.equal(summary.scriptDurationP95Ms, referenceQuantile(original.slice(0, 50000), 0.95));
    assert.deepEqual(values, original, 'summary must not reorder chronological samples');
    for (const threshold of [1000 / 60, 1000 / 144, 0, Number.NaN]) {
      const pacing = metrics.summarizeFramePacing(values.map(durationMs => ({ durationMs })), threshold);
      const median = referenceQuantile(original, 0.5);
      const missed = Number.isFinite(threshold) && threshold > 0
        ? values.reduce((total, value) => total + Math.max(0, Math.round(value / threshold) - 1), 0) : 0;
      assert.equal(pacing.p95, referenceQuantile(original, 0.95));
      assert.equal(pacing.p99, referenceQuantile(original, 0.99));
      assert.equal(pacing.median, median);
      assert.equal(pacing.jitterP95, referenceQuantile(original.map(value => Math.abs(value - median)), 0.95));
      assert.equal(pacing.missedFrameCount, missed);
      assert.equal(pacing.missedFramePercent, count + missed > 0 ? missed / (count + missed) * 100 : 0);
    }
    if (count === 216000) console.log(`Full retention summary: ${elapsed.toFixed(2)} ms (informational; no machine-dependent timing assertion).`);
  }
  timeline.setPerformanceTimelineEnabled(false);
  timeline.clearPerformanceTimelineEvents();
  assert.deepEqual(vite.watcher.getWatched(), {}, 'one-shot regression must not retain filesystem watches');
  console.log('Performance Lab stress passed: 100 start/stop cycles, 100,000 wheel events, 200,100 timeline events, exact full-retention quantiles.');
} finally {
  for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; }
  await vite.close();
}
