export type DurationSample = { durationMs: number };

export type DurationSummary = {
  count: number;
  average: number;
  p95: number;
  maximum: number;
  aboveThresholdPercent: number;
};

export type FramePacingSummary = DurationSummary & {
  p99: number;
  median: number;
  jitterP95: number;
};

export function summarizeDurationSamples(
  samples: readonly DurationSample[],
  thresholdMs: number,
): DurationSummary {
  if (samples.length === 0) {
    return { count: 0, average: 0, p95: 0, maximum: 0, aboveThresholdPercent: 0 };
  }

  const durations = new Array<number>(samples.length);
  let total = 0;
  let maximum = 0;
  let aboveThreshold = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const duration = samples[index]?.durationMs ?? 0;
    durations[index] = duration;
    total += duration;
    if (duration > maximum) maximum = duration;
    if (duration > thresholdMs) aboveThreshold += 1;
  }
  durations.sort((left, right) => left - right);
  const p95Index = Math.max(0, Math.ceil(durations.length * 0.95) - 1);
  return {
    count: samples.length,
    average: total / samples.length,
    p95: durations[p95Index] ?? 0,
    maximum,
    aboveThresholdPercent: (aboveThreshold / samples.length) * 100,
  };
}

export function sumDurationSamples(samples: readonly DurationSample[]) {
  let total = 0;
  for (const sample of samples) total += sample.durationMs;
  return total;
}

/**
 * Measures cadence stability as well as latency. jitterP95 is the 95th
 * percentile absolute deviation from the median frame, so a nominal 60 FPS
 * run with intermittent hitches cannot look healthy through its average.
 */
export function summarizeFramePacing(
  samples: readonly DurationSample[],
  thresholdMs: number,
): FramePacingSummary {
  const summary = summarizeDurationSamples(samples, thresholdMs);
  if (samples.length === 0) {
    return { ...summary, p99: 0, median: 0, jitterP95: 0 };
  }
  const durations = samples.map((sample) => sample.durationMs).sort((left, right) => left - right);
  const percentile = (ratio: number) =>
    durations[Math.max(0, Math.ceil(durations.length * ratio) - 1)] ?? 0;
  const median = percentile(0.5);
  const deviations = durations
    .map((duration) => Math.abs(duration - median))
    .sort((left, right) => left - right);
  const jitterP95 = deviations[Math.max(0, Math.ceil(deviations.length * 0.95) - 1)] ?? 0;
  return { ...summary, p99: percentile(0.99), median, jitterP95 };
}
