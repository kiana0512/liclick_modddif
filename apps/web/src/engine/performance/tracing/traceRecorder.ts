import { pipelineTraceNames, type PipelineTraceContext, type PipelineTraceName, type PipelineTraceReport, type PipelineTraceSpan, type PipelineTraceStatus, type TraceAttributes, type WorkerTraceTiming } from '@/engine/performance/tracing/types';
const limit = 10_000;
export type TraceScope = { context: PipelineTraceContext; end: (status?: PipelineTraceStatus) => void };

/** Bounded recording-local references never enter the exported report. */
export function createTraceSession(now = () => performance.now()) {
  const traceId = crypto.randomUUID();
  const spans: PipelineTraceSpan[] = [];
  const handles = new Map<string, TraceScope>();
  const references = new Map<string, PipelineTraceContext>();
  const acknowledged = new Set<string>();
  const ackListeners = new Set<() => void>();
  const cleanup = new Set<() => void>();
  let recording = true, dropped = 0, nextId = 0;
  const lose = (count = 1) => { if (recording) dropped += Math.max(0, count); };
  const begin = (name: PipelineTraceName, parent?: PipelineTraceContext, kind: 'sync' | 'async' = 'async', _reference?: string, attributes?: TraceAttributes): TraceScope | undefined => {
    if (!recording) return;
    if (spans.length >= limit) { lose(); return; }
    try {
      if (!pipelineTraceNames.includes(name) || name.length > 128) return;
      if (parent?.traceId !== traceId || !handles.has(parent.spanId)) parent = undefined;
      const spanId = String(++nextId), context = { traceId, spanId, operationId: parent?.operationId ?? spanId };
      const span: PipelineTraceSpan = { ...context, name, parentSpanId: parent?.spanId, links: [], producerId: 'browser', kind, startMs: now(), endMs: null, status: null };
      if (attributes) {
        const safe: NonNullable<PipelineTraceSpan['attributes']> = {};
        if (attributes.functionName && /^[a-zA-Z0-9_./#-]{1,128}$/.test(attributes.functionName)) safe.functionName = attributes.functionName;
        for (const key of ['attempt', 'viewSlot'] as const) if (Number.isSafeInteger(attributes[key]) && attributes[key]! >= 0) safe[key] = attributes[key];
        if (attributes.lateAttach === true) safe.lateAttach = true;
        if (Object.keys(safe).length) span.attributes = safe;
      }
      const scope: TraceScope = { context, end(status = 'ok') {
        if (!recording || span.status !== null) return;
        try { span.endMs = now(); span.status = status; } catch { span.status = 'interrupted'; }
      } };
      spans.push(span); handles.set(spanId, scope);
      return scope;
    } catch { lose(); return; }
  };
  const snapshot = (): PipelineTraceReport => ({
    schema: 'LI3D-FUNCTION-TIMING', version: 1, traceId, unit: 'ms',
    spans: spans.map(s => ({ ...s, links: [...s.links], ...(s.attributes ? { attributes: { ...s.attributes } } : {}) })),
    dropped, completeness: dropped ? 'truncated' : spans.some(s => s.status === null || s.status === 'interrupted' || s.attributes?.lateAttach) ? 'partial' : 'complete',
  });
  return {
    begin, snapshot, lose,
    isRecording: () => recording,
    bindings: () => references.entries(),
    bind(reference: string, context: PipelineTraceContext) {
      if (recording && reference.length <= 512 && context.traceId === traceId && handles.has(context.spanId) && references.size < limit) references.set(reference, context);
    },
    lookup: (reference: string | undefined) => reference ? references.get(reference) : undefined,
    scopeFor: (reference: string) => handles.get(references.get(reference)?.spanId ?? ''),
    link(target: PipelineTraceContext, source: PipelineTraceContext) {
      if (!recording || target.traceId !== traceId || source.traceId !== traceId) return;
      const span = spans[Number(target.spanId) - 1];
      if (span && handles.has(source.spanId) && span.links.length < 16 && !span.links.includes(source.spanId)) span.links.push(source.spanId);
    },
    onStop(fn: () => void) { if (recording) cleanup.add(fn); else fn(); },
    acknowledge(reference: string) {
      if (!recording || reference.length > 512 || acknowledged.size >= limit) return;
      acknowledged.add(reference);
      for (const fn of ackListeners) { try { fn(); } catch { /* Diagnostic observers are isolated. */ } }
    },
    isAcknowledged: (reference: string) => acknowledged.has(reference),
    onAcknowledged(fn: () => void) { ackListeners.add(fn); return () => { ackListeners.delete(fn); }; },
    workerResult(timing: WorkerTraceTiming, _sent?: number, _received?: number, failed = false) {
      if (!recording || timing.traceId !== traceId || !handles.has(timing.spanId)) return;
      if (!Number.isFinite(timing.receivedMs) || !Number.isFinite(timing.sentMs) || timing.sentMs < timing.receivedMs || timing.receivedMs < 0) { lose(); return; }
      if (typeof timing.producerId !== 'string' || !/^[a-f0-9-]{36}$/.test(timing.producerId)) { lose(); return; }
      const scope = begin(timing.name ?? 'task.run', timing, timing.kind ?? 'async');
      if (!scope) return;
      const span = spans[Number(scope.context.spanId) - 1];
      span.producerId = timing.producerId; span.startMs = timing.receivedMs; span.endMs = timing.sentMs;
      span.status = failed ? 'error' : timing.status === 'cancelled' ? 'cancelled' : 'ok';
    },
    stop() {
      if (recording) {
        recording = false;
        for (const span of spans) if (span.status === null) span.status = 'interrupted';
        for (const fn of cleanup) { try { fn(); } catch { /* Cleanup cannot affect business work. */ } }
        cleanup.clear(); ackListeners.clear(); references.clear(); acknowledged.clear();
      }
      return snapshot();
    },
  };
}
export type TraceSession = ReturnType<typeof createTraceSession>;
