import type { PipelineTraceName, WorkerTraceTiming } from '@/engine/performance/tracing/types';
import { getPipelineTrace, type TraceSession, type TraceScope } from './pipelineTrace';

type Pending = { scope: TraceScope; sent: number; businessDone?: boolean; diagnosticDone?: boolean };
let recordings: WeakMap<TraceSession, WeakMap<Worker, Map<number, Pending>>> | undefined;

/** One listener per original Worker and recording; no diagnostic Worker is created here. */
export function prepareTracedWorkerRequest(worker: Worker, requestId: number, name: PipelineTraceName) {
  const trace = getPipelineTrace(), scope = trace?.begin(name);
  if (!trace || !scope) return undefined;
  recordings ??= new WeakMap();
  let workers = recordings.get(trace);
  if (!workers) { workers = new WeakMap(); recordings.set(trace, workers); }
  let pending = workers.get(worker);
  if (!pending) {
    pending = new Map(); workers.set(worker, pending);
    const owned = pending;
    const listener = (event: MessageEvent) => {
      const data = event.data;
      if (data?.__pipelineTrace === 'result') {
        const request = owned.get(data.requestId); if (!request) return;
        try { trace.workerResult(data.timing as WorkerTraceTiming, request.sent, performance.now(), data.timing?.status === 'error'); } catch { trace.lose(1); }
        request.diagnosticDone = true;
        if (request.businessDone) owned.delete(data.requestId); return;
      }
      const request = owned.get(data?.id);
      if (request) { request.scope.end(data.type === 'error' || 'error' in data ? 'error' : 'ok'); request.businessDone = true; if (request.diagnosticDone) owned.delete(data.id); }
    };
    const failure = () => { owned.forEach(request => request.scope.end('error')); trace.lose(owned.size); owned.clear(); };
    worker.addEventListener('message', listener);
    worker.addEventListener('error', failure); worker.addEventListener('messageerror', failure);
    trace.onStop(() => { owned.clear(); worker.removeEventListener('message', listener); worker.removeEventListener('error', failure); worker.removeEventListener('messageerror', failure); });
  }
  if (pending.size >= 2000) { scope.end('skipped'); trace.lose(1); return undefined; }
  pending.set(requestId, { scope, sent: performance.now() });
  return { traceContext: scope.context };
}
