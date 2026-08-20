export type FrameBudgetSample = {
  frameMaximumMs: number;
  frameSampleCount: number;
  frameTargetMs: number;
  synchronousWorkMs: number;
  interactionBusy: boolean;
};

export type AdaptiveWorkBudget = {
  pixels: number;
  healthySamples: number;
};

export const MIN_TEXTURE_UPLOAD_PIXELS = 64 * 1024;
export const INITIAL_TEXTURE_UPLOAD_PIXELS = 128 * 1024;
// Real 4K S8 A/B rejected both larger budgets: 512K raised >20ms frames to
// 1.9-3.0%; 256K still measured 1.4-1.8% and one 133.4ms hitch. Production
// therefore never exceeds the proven 128K stripe and only throttles downward
// when presentation becomes congested.
export const MAX_TEXTURE_UPLOAD_PIXELS = INITIAL_TEXTURE_UPLOAD_PIXELS;

const FALLBACK_FRAME_TARGET_MS = 1000 / 60;
const HEALTHY_FRAME_BUDGET_RATIO = 1.11;
const CONGESTED_FRAME_BUDGET_RATIO = 1.2;
const HEALTHY_SYNCHRONOUS_BUDGET_RATIO = 0.06;
const CONGESTED_SYNCHRONOUS_BUDGET_RATIO = 0.12;
const HEALTHY_SAMPLES_TO_GROW = 3;

function normalizedFrameTargetMs(frameTargetMs: number) {
  return Number.isFinite(frameTargetMs) && frameTargetMs >= 4 && frameTargetMs <= 40
    ? frameTargetMs
    : FALLBACK_FRAME_TARGET_MS;
}

function clampTextureUploadPixels(pixels: number) {
  return Math.max(
    MIN_TEXTURE_UPLOAD_PIXELS,
    Math.min(MAX_TEXTURE_UPLOAD_PIXELS, Math.round(pixels)),
  );
}

export function createTextureUploadBudget(): AdaptiveWorkBudget {
  return { pixels: INITIAL_TEXTURE_UPLOAD_PIXELS, healthySamples: 0 };
}

/**
 * Keeps background texture throughput subordinate to frame pacing. A single
 * congested frame cuts the next upload in half, while growth requires several
 * consecutive healthy samples. The asymmetric ramp prevents an idle uploader
 * from oscillating between large and small submissions around the 60 Hz limit.
 */
export function updateTextureUploadBudget(
  budget: AdaptiveWorkBudget,
  sample: FrameBudgetSample,
): AdaptiveWorkBudget {
  const frameTargetMs = normalizedFrameTargetMs(sample.frameTargetMs);
  const frameCongested =
    sample.frameSampleCount > 0 &&
    sample.frameMaximumMs > frameTargetMs * CONGESTED_FRAME_BUDGET_RATIO;
  const synchronousWorkCongested =
    sample.synchronousWorkMs > frameTargetMs * CONGESTED_SYNCHRONOUS_BUDGET_RATIO;
  if (sample.interactionBusy || frameCongested || synchronousWorkCongested) {
    return {
      pixels: clampTextureUploadPixels(budget.pixels / 2),
      healthySamples: 0,
    };
  }

  const frameHealthy =
    sample.frameSampleCount > 0 &&
    sample.frameMaximumMs <= frameTargetMs * HEALTHY_FRAME_BUDGET_RATIO;
  const synchronousWorkHealthy =
    sample.synchronousWorkMs <= frameTargetMs * HEALTHY_SYNCHRONOUS_BUDGET_RATIO;
  if (!frameHealthy || !synchronousWorkHealthy) {
    return { pixels: budget.pixels, healthySamples: 0 };
  }

  const healthySamples = budget.healthySamples + 1;
  if (healthySamples < HEALTHY_SAMPLES_TO_GROW) {
    return { pixels: budget.pixels, healthySamples };
  }
  return {
    pixels: clampTextureUploadPixels(budget.pixels * 2),
    healthySamples: 0,
  };
}

export type FrameIntervalMonitor = {
  readAndReset: () => { maximumMs: number; sampleCount: number; targetMs: number };
  stop: () => void;
};

/**
 * Samples presentation cadence only while a background upload is active.
 * This gives the governor real frame data without installing a permanent
 * second render loop or synchronously polling the GPU.
 */
export function startFrameIntervalMonitor(): FrameIntervalMonitor {
  if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') {
    return {
      readAndReset: () => ({ maximumMs: 0, sampleCount: 0, targetMs: FALLBACK_FRAME_TARGET_MS }),
      stop: () => undefined,
    };
  }

  let stopped = false;
  let frameId = 0;
  let previousFrameAt: number | undefined;
  let maximumMs = 0;
  let sampleCount = 0;
  let targetMs = FALLBACK_FRAME_TARGET_MS;
  let hasMeasuredTarget = false;
  const sampleFrame = (frameAt: number) => {
    if (stopped) return;
    if (previousFrameAt !== undefined && document.visibilityState !== 'hidden') {
      const intervalMs = frameAt - previousFrameAt;
      maximumMs = Math.max(maximumMs, intervalMs);
      sampleCount += 1;
      // rAF timestamps advance in display-vsync quanta. The shortest credible
      // interval seen by this upload is therefore the best local estimate of
      // the active 60/90/120/144 Hz budget; long intervals are missed frames,
      // not a slower target to normalize away.
      if (intervalMs >= 4 && intervalMs <= 40) {
        targetMs = hasMeasuredTarget ? Math.min(targetMs, intervalMs) : intervalMs;
        hasMeasuredTarget = true;
      }
    }
    previousFrameAt = frameAt;
    frameId = window.requestAnimationFrame(sampleFrame);
  };
  frameId = window.requestAnimationFrame(sampleFrame);

  return {
    readAndReset: () => {
      const sample = { maximumMs, sampleCount, targetMs };
      maximumMs = 0;
      sampleCount = 0;
      return sample;
    },
    stop: () => {
      if (stopped) return;
      stopped = true;
      window.cancelAnimationFrame(frameId);
    },
  };
}
