import type { PipelineTraceContext, WorkerTraceTiming, PipelineTraceName } from '@/engine/performance/tracing/types';
let producerId: string | undefined;
export function beginWorkerTrace(context: PipelineTraceContext, name: PipelineTraceName = 'capture.encode', kind: 'sync' | 'async' = 'sync') {
  try {
    producerId ??= crypto.randomUUID();
    const receivedMs = performance.now(), identity = producerId;
    return (): WorkerTraceTiming => ({ ...context, producerId: identity, name, kind, receivedMs, sentMs: performance.now() });
  } catch { return undefined; }
}

export function sendWorkerTiming(requestId: number, timing: WorkerTraceTiming) {
  try { self.postMessage({ id: 0, __pipelineTrace: 'result', requestId, timing }); } catch { /* Diagnostics never reject the business task. */ }
}
