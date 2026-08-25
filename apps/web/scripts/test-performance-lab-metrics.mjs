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
  const metrics = await server.ssrLoadModule(
    '/src/engine/performance/performanceLabMetrics.ts',
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
  });
  assert.deepEqual(metrics.summarizeFramePacing([], 20), {
    count: 0,
    average: 0,
    p95: 0,
    maximum: 0,
    aboveThresholdPercent: 0,
    p99: 0,
    median: 0,
    jitterP95: 0,
  });
  stdout.write('Performance-lab metric parity test passed.\n');
} finally {
  await server.close();
}
