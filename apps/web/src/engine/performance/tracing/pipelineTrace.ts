import type { PipelineTraceContext, PipelineTraceName, PipelineTraceReport, PipelineTraceSpan, TraceAttributes } from '@/engine/performance/tracing/types';
import type { TraceSession, TraceScope } from './traceRecorder';
export type { TraceSession, TraceScope } from './traceRecorder';

let active: TraceSession | undefined;
let projectId: string | undefined;
let ownerId: string | undefined;
let epoch = 0;
let starting: Promise<TraceSession | undefined> | undefined;
let last: { report: PipelineTraceReport; reports: PipelineTraceReport[] } | undefined;

export function getPipelineTrace(project?: string) { return project && projectId && project !== projectId ? undefined : active; }
export function startPipelineTrace(options?: { projectId?: string; ownerId?: string }) {
  if (import.meta.env.VITE_LICLICK_PIPELINE_TRACE_ENABLED !== 'true') return Promise.resolve(undefined);
  if (active) {
    if (projectId === options?.projectId && ownerId === options?.ownerId) return Promise.resolve(active);
    clearPipelineTrace();
  }
  if (starting) return starting;
  const generation = ++epoch;
  last = undefined;
  projectId = options?.projectId; ownerId = options?.ownerId;
  const pending = (async () => {
    const { createTraceSession } = await import('./traceRecorder');
    const { observeGenerationPipeline } = await import('./generationTrace');
    if (generation !== epoch) return undefined;
    active = createTraceSession();
    try { if (projectId) active.onStop(observeGenerationPipeline(active, projectId)); } catch { /* Optional observers cannot prevent recording. */ }
    return active;
  })();
  starting = pending;
  void pending.finally(() => { if (starting === pending) starting = undefined; }).catch(() => undefined);
  return pending;
}
export function bindPipelineTraceProject(nextProjectId: string) {
  if (!active || projectId) return;
  projectId = nextProjectId;
  const session = active, generation = epoch;
  void import('./generationTrace').then(({ observeGenerationPipeline }) => {
    if (generation === epoch && active === session) session.onStop(observeGenerationPipeline(session, nextProjectId));
  }).catch(() => undefined);
}
export function stopPipelineTrace() {
  ++epoch;
  starting = undefined;
  const session = active;
  active = undefined; projectId = undefined; ownerId = undefined;
  if (session) { const report = session.stop(); last = { report, reports: [report] }; }
  return last;
}
/** Owner changes discard even stopped snapshots; caller can only read its own session. */
export function clearPipelineTrace() { stopPipelineTrace(); last = undefined; }
export function getPipelineTraceReports() { return active ? [active.snapshot()] : last?.reports ?? []; }

export async function traceAsync<T>(session: TraceSession, name: PipelineTraceName, task: (context?: PipelineTraceContext) => Promise<T>, parent?: PipelineTraceContext, reference?: string, attributes?: TraceAttributes): Promise<T> {
  const scope = session.begin(name, parent, 'async', reference, attributes);
  try { const value = await task(scope?.context); scope?.end(); return value; }
  catch (error) { scope?.end(error instanceof Error && error.name === 'AbortError' ? 'cancelled' : 'error'); throw error; }
}
export function traceSync<T>(session: TraceSession, name: PipelineTraceName, task: () => T, parent?: PipelineTraceContext): T {
  const scope = session.begin(name, parent, 'sync');
  try { const value = task(); scope?.end(); return value; }
  catch (error) { scope?.end('error'); throw error; }
}
export function traceDuration(span: PipelineTraceSpan) {
  return span.endMs === null || span.status === 'interrupted' ? null : span.endMs - span.startMs;
}

/** Observe native Promise completion without replacing it or changing business awaits. */
export function finishTraceReturn<T>(scope: TraceScope, value: T): T {
  try {
    if (value instanceof Promise) {
      void Promise.prototype.then.call(value, () => scope.end(), (error: unknown) => scope.end(error instanceof Error && error.name === 'AbortError' ? 'cancelled' : 'error'));
    } else scope.end();
  } catch { scope.end('interrupted'); }
  return value;
}
