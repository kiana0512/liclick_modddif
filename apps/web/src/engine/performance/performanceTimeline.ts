export type PerformanceTimelineEvent = {
  id: number;
  unixMs: number;
  monotonicMs: number;
  category:
    | 'interaction'
    | 'layers'
    | 'uv-composite'
    | 'uv-merge'
    | 'model-load'
    | 'projection'
    | 'local-repaint'
    | 'system';
  name: string;
  phase: 'instant' | 'start' | 'end' | 'error';
  durationMs?: number;
  detail?: Record<string, unknown>;
};

const maximumEvents = 2_000;
const events: PerformanceTimelineEvent[] = [];
const listeners = new Set<(event: PerformanceTimelineEvent) => void>();
let nextEventId = 1;
let enabled = false;

export function setPerformanceTimelineEnabled(nextEnabled: boolean) {
  enabled = nextEnabled;
}

export function markPerformanceEvent(
  category: PerformanceTimelineEvent['category'],
  name: string,
  detail?: Record<string, unknown>,
  phase: PerformanceTimelineEvent['phase'] = 'instant',
) {
  if (!enabled) return undefined;
  const event: PerformanceTimelineEvent = {
    id: nextEventId++,
    unixMs: Date.now(),
    monotonicMs: performance.now(),
    category,
    name,
    phase,
    detail,
  };
  events.push(event);
  if (events.length > maximumEvents) events.splice(0, events.length - maximumEvents);
  listeners.forEach((listener) => listener(event));
  return event;
}

export function startPerformanceSpan(
  category: PerformanceTimelineEvent['category'],
  name: string,
  detail?: Record<string, unknown>,
) {
  const started = markPerformanceEvent(category, name, detail, 'start');
  if (!started) return () => {};
  let ended = false;
  return (phase: 'end' | 'error' = 'end', endDetail?: Record<string, unknown>) => {
    if (ended) return;
    ended = true;
    const finished = markPerformanceEvent(category, name, endDetail, phase);
    if (finished) finished.durationMs = finished.monotonicMs - started.monotonicMs;
  };
}

export function getPerformanceTimelineEvents() {
  return events.slice();
}

export function clearPerformanceTimelineEvents() {
  events.length = 0;
}

export function subscribePerformanceTimeline(
  listener: (event: PerformanceTimelineEvent) => void,
) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
