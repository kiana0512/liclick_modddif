export type DurationSample = { durationMs: number };

export type DurationSummary = {
  count: number;
  average: number;
  p95: number;
  maximum: number;
  aboveThresholdPercent: number;
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
