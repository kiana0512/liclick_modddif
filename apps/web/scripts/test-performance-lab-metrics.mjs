import assert from 'node:assert/strict';
import path from 'node:path';
import { stdout } from 'node:process';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const server = await createServer({
  root,
  appType: 'custom',
  logLevel: 'silent',
  server: { middlewareMode: true },
});

try {
  const metrics = await server.ssrLoadModule('/src/engine/performance/performanceLabMetrics.ts');
  const timeline = await server.ssrLoadModule('/src/engine/performance/performanceTimeline.ts');
  const labPolicy = await server.ssrLoadModule('/src/dev/performanceLabPolicy.ts');
  assert.equal(labPolicy.isPerformanceLabEnabled('?perfLab=1'), true);
  assert.equal(labPolicy.isPerformanceLabEnabled('?perfLab=0'), false);
  assert.equal(labPolicy.isPerformanceLabEnabled('?perfScenario=100-layers'), false);
  assert.equal(labPolicy.isPerformanceLabEnabled('?perfLab=1&perfScenario=100-models'), true);

  const editorSource = await import('node:fs/promises').then((fs) =>
    fs.readFile(path.join(root, 'src/routes/EditorPage.tsx'), 'utf8'),
  );
  const viewportSource = await import('node:fs/promises').then((fs) =>
    fs.readFile(path.join(root, 'src/engine/viewport/ViewportCanvas.tsx'), 'utf8'),
  );
  assert.doesNotMatch(editorSource, /PerfScenarioLoader|replaceCurrentProject\(.*perf/i);
  assert.match(
    viewportSource,
    /right-4 top-16 z-\[28\][^"\n]*2xl:top-4/,
    'the collapsed performance HUD must stay below the editor toolbar until an ultra-wide viewport',
  );
  const samples = Array.from({ length: 137 }, (_, index) => ({
    durationMs: ((index * 37) % 71) / 3,
  }));
  const durations = samples.map((sample) => sample.durationMs);
  const sorted = [...durations].sort((left, right) => left - right);
  const expected = {
    count: samples.length,
    average: durations.reduce((total, duration) => total + duration, 0) / samples.length,
    p95: sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? 0,
    maximum: Math.max(...durations),
    aboveThresholdPercent:
      (durations.filter((duration) => duration > 20).length / samples.length) * 100,
  };
  assert.deepEqual(metrics.summarizeDurationSamples(samples, 20), expected);
  assert.equal(
    metrics.sumDurationSamples(samples),
    durations.reduce((total, duration) => total + duration, 0),
  );
  assert.deepEqual(metrics.summarizeDurationSamples([], 20), {
    count: 0,
    average: 0,
    p95: 0,
    maximum: 0,
    aboveThresholdPercent: 0,
  });
  const pacing = metrics.summarizeFramePacing(samples, 20);
  const median = sorted[Math.max(0, Math.ceil(sorted.length * 0.5) - 1)] ?? 0;
  const deviations = sorted
    .map((duration) => Math.abs(duration - median))
    .sort((left, right) => left - right);
  assert.deepEqual(pacing, {
    ...expected,
    p99: sorted[Math.max(0, Math.ceil(sorted.length * 0.99) - 1)] ?? 0,
    median,
    jitterP95: deviations[Math.max(0, Math.ceil(deviations.length * 0.95) - 1)] ?? 0,
    missedFrameCount: metrics.estimateMissedFrameCount(samples, 20),
    missedFramePercent: metrics.estimateMissedFramePercent(samples, 20),
  });
  const refreshSamples = [16.7, 16.8, 33.4, 50.1].map((durationMs) => ({ durationMs }));
  assert.equal(metrics.estimateMissedFrameCount(refreshSamples, 16.7), 3);
  assert.equal(metrics.estimateMissedFramePercent(refreshSamples, 16.7), (3 / 7) * 100);
  assert.deepEqual(metrics.summarizeFramePacing([], 20), {
    count: 0,
    average: 0,
    p95: 0,
    maximum: 0,
    aboveThresholdPercent: 0,
    p99: 0,
    median: 0,
    jitterP95: 0,
    missedFrameCount: 0,
    missedFramePercent: 0,
  });
  timeline.clearPerformanceTimelineEvents();
  timeline.setPerformanceTimelineEnabled(true);
  const observed = [];
  const unsubscribe = timeline.subscribePerformanceTimeline((event) => observed.push(event));
  timeline.recordReactProfilerCommit('app-root', 'update', 12.5, 18, 100, 115);
  unsubscribe();
  timeline.setPerformanceTimelineEnabled(false);
  assert.equal(observed.length, 1);
  assert.deepEqual(
    {
      category: observed[0].category,
      name: observed[0].name,
      phase: observed[0].phase,
      detail: observed[0].detail,
    },
    {
      category: 'react',
      name: 'react-commit',
      phase: 'instant',
      detail: {
        profilerId: 'app-root',
        reactPhase: 'update',
        actualDurationMs: 12.5,
        baseDurationMs: 18,
        startTimeMs: 100,
        commitTimeMs: 115,
      },
    },
  );
  timeline.clearPerformanceTimelineEvents();
  stdout.write('Performance-lab metric parity test passed.\n');
} finally {
  await server.close();
}
