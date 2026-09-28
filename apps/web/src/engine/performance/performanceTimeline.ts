import type { ProfilerOnRenderCallback } from 'react';
import { getPipelineTrace, type TraceScope } from './tracing/pipelineTrace';
import type { PipelineTraceName } from '@/engine/performance/tracing/types';

const pipelineNames: Readonly<Record<string, PipelineTraceName>> = {
  'fbx-main-thread-parse': 'model.prepare',
  'compose-uv-stack': 'uv.compose',
  'merge-layers-to-uv': 'uv.compose',
  'local-repaint-depth-capture': 'capture.depth',
};

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
    | 'react'
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

export const recordReactProfilerCommit: ProfilerOnRenderCallback = (
  profilerId,
  reactPhase,
  actualDurationMs,
  baseDurationMs,
  startTimeMs,
  commitTimeMs,
) => {
  markPerformanceEvent('react', 'react-commit', {
    profilerId,
    reactPhase,
    actualDurationMs,
    baseDurationMs,
    startTimeMs,
    commitTimeMs,
  });
};

export function markPerformanceEvent(
  category: PerformanceTimelineEvent['category'],
  name: string,
  detail?: Record<string, unknown>,
  phase: PerformanceTimelineEvent['phase'] = 'instant',
  durationMs?: number,
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
    durationMs,
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
  let pipeline: TraceScope | undefined;
  if (import.meta.env.VITE_LICLICK_PIPELINE_TRACE_ENABLED === 'true' && Object.hasOwn(pipelineNames, name)) {
    pipeline = getPipelineTrace()?.begin(pipelineNames[name]);
  }
  const started = markPerformanceEvent(category, name, detail, 'start');
  if (!started) {
    if (import.meta.env.VITE_LICLICK_PIPELINE_TRACE_ENABLED === 'true' && pipeline) {
      const scope = pipeline;
      return (phase: 'end' | 'error' = 'end') => scope.end(phase === 'error' ? 'error' : 'ok');
    }
    return () => {};
  }
  let ended = false;
  return (phase: 'end' | 'error' = 'end', endDetail?: Record<string, unknown>) => {
    if (ended) return;
    ended = true;
    if (import.meta.env.VITE_LICLICK_PIPELINE_TRACE_ENABLED === 'true') pipeline?.end(phase === 'error' ? 'error' : 'ok');
    markPerformanceEvent(category, name, endDetail, phase, performance.now() - started.monotonicMs);
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
