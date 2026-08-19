export type EraserPerformanceEvent = {
  sequence: number;
  unixMs: number;
  monotonicMs: number;
  name: string;
  durationMs?: number;
  detail?: Record<string, unknown>;
};

export type EraserPerformanceLog = {
  version: 1;
  pageLoadedAtUnixMs: number;
  latestSequence: number;
  events: EraserPerformanceEvent[];
};

type EraserPerformanceWindow = Window & {
  __LI3D_ERASER_PERF__?: EraserPerformanceLog;
};

const maximumEvents = 4_000;
const relevantWindowMs = 3_000;
const droppedFrameThresholdMs = 34;
const enabled = import.meta.env.DEV && typeof window !== 'undefined';

const log: EraserPerformanceLog | undefined = enabled
  ? (() => {
      const target = window as EraserPerformanceWindow;
      const existing = target.__LI3D_ERASER_PERF__;
      if (existing?.version === 1) return existing;
      const created: EraserPerformanceLog = {
        version: 1,
        pageLoadedAtUnixMs: Date.now(),
        latestSequence: 0,
        events: [],
      };
      target.__LI3D_ERASER_PERF__ = created;
      return created;
    })()
  : undefined;

let relevantUntil = 0;
let frameWatchId: number | undefined;
let previousFrameAt = 0;
let activeStrokeStartSequence = 0;
let latestLayerChangeSequence = 0;

function persistDiagnosticReport(payload: Record<string, unknown>) {
  if (!enabled) return;
  const body = JSON.stringify({
    receivedAtUnixMs: Date.now(),
    pageLoadedAtUnixMs: log?.pageLoadedAtUnixMs,
    ...payload,
  });
  const url = `${import.meta.env.BASE_URL}__li3d_eraser_perf`;
  if (navigator.sendBeacon?.(url, body)) return;
  void fetch(url, {
    method: 'POST',
    body,
    keepalive: true,
    headers: { 'content-type': 'text/plain;charset=UTF-8' },
  }).catch(() => undefined);
}

function writeDiagnosticReport(event: EraserPerformanceEvent) {
  if (!log) return;
  if (event.name === 'active-layer-change') {
    latestLayerChangeSequence = event.sequence;
    return;
  }
  if (event.name === 'eraser-stroke-start') {
    activeStrokeStartSequence = event.sequence;
    return;
  }
  if (event.name === 'frame-gap' || event.name === 'long-task') {
    console.warn('[LI3D Eraser Perf Stall]', JSON.stringify(event));
    persistDiagnosticReport({ type: 'stall', event });
    return;
  }
  if (
    event.name !== 'eraser-stroke-end' &&
    event.name !== 'eraser-commit-complete' &&
    event.name !== 'projected-refinement-complete' &&
    event.name !== 'projected-refinement-error'
  ) {
    return;
  }
  const fromSequence = Math.max(1, activeStrokeStartSequence || latestLayerChangeSequence);
  const events = log.events.filter((item) => item.sequence >= fromSequence);
  const report = {
    type: 'report',
    trigger: event.name,
    fromSequence,
    toSequence: event.sequence,
    events,
  };
  console.info('[LI3D Eraser Perf Report]', JSON.stringify(report));
  persistDiagnosticReport(report);
  if (event.name === 'eraser-commit-complete') activeStrokeStartSequence = 0;
}

function appendEvent(
  name: string,
  detail?: Record<string, unknown>,
  durationMs?: number,
) {
  if (!log) return;
  const event: EraserPerformanceEvent = {
    sequence: log.latestSequence + 1,
    unixMs: Date.now(),
    monotonicMs: performance.now(),
    name,
    durationMs,
    detail,
  };
  log.latestSequence = event.sequence;
  log.events.push(event);
  if (log.events.length > maximumEvents) {
    log.events.splice(0, log.events.length - maximumEvents);
  }
  writeDiagnosticReport(event);
}

function keepFrameWatchAlive() {
  if (!enabled) return;
  relevantUntil = Math.max(relevantUntil, performance.now() + relevantWindowMs);
  if (frameWatchId !== undefined) return;
  previousFrameAt = performance.now();
  const watchFrame = (frameAt: number) => {
    const frameGapMs = frameAt - previousFrameAt;
    previousFrameAt = frameAt;
    if (frameGapMs >= droppedFrameThresholdMs) {
      appendEvent(
        'frame-gap',
        { estimatedDroppedFrames: Math.max(1, Math.round(frameGapMs / 16.7) - 1) },
        frameGapMs,
      );
    }
    if (frameAt < relevantUntil) {
      frameWatchId = window.requestAnimationFrame(watchFrame);
    } else {
      frameWatchId = undefined;
    }
  };
  frameWatchId = window.requestAnimationFrame(watchFrame);
}

export function markEraserPerformanceEvent(
  name: string,
  detail?: Record<string, unknown>,
) {
  if (!enabled) return;
  keepFrameWatchAlive();
  appendEvent(name, detail);
}

export function measureEraserPerformanceEvent(
  name: string,
  startedAt: number,
  detail?: Record<string, unknown>,
) {
  if (!enabled) return;
  keepFrameWatchAlive();
  appendEvent(name, detail, Math.max(0, performance.now() - startedAt));
}

export function measureEraserNextFrame(
  name: string,
  startedAt: number,
  detail?: Record<string, unknown>,
) {
  if (!enabled) return;
  keepFrameWatchAlive();
  window.requestAnimationFrame((frameAt) => {
    appendEvent(name, detail, Math.max(0, frameAt - startedAt));
  });
}

if (enabled && typeof PerformanceObserver !== 'undefined') {
  console.info('[LI3D Eraser Perf Monitor] ready');
  try {
    const observer = new PerformanceObserver((list) => {
      if (performance.now() > relevantUntil) return;
      for (const entry of list.getEntries()) {
        appendEvent('long-task', { entryType: entry.entryType }, entry.duration);
      }
    });
    observer.observe({ entryTypes: ['longtask'] });
  } catch {
    // Long Task entries are unavailable in some browser/WebView builds. The
    // frame-gap watcher still captures the user-visible stall in those builds.
  }
}
