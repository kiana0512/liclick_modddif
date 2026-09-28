type EncodeResponse = (
  | { id: number; png: ArrayBuffer }
  | { id: number; error: string }) & { traceTiming?: WorkerTraceTiming };

type PendingEncode = {
  trace?: TraceScope;
  traceSession?: TraceSession;
  sentMs?: number;
  resolve: (png: ArrayBuffer) => void;
  reject: (error: Error) => void;
};

let worker: Worker | undefined;
let nextRequestId = 1;
const pending = new Map<number, PendingEncode>();

function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('../../workers/encodeGpuReadbackPng.worker.ts', import.meta.url), {
    type: 'module',
  });
  worker.onmessage = (event: MessageEvent<EncodeResponse>) => {
    const request = pending.get(event.data.id);
    if (!request) return;
    pending.delete(event.data.id);
    if (import.meta.env.VITE_LICLICK_PIPELINE_TRACE_ENABLED === 'true') {
      try { if (event.data.traceTiming && request.sentMs !== undefined && request.traceSession?.isRecording()) request.traceSession.workerResult(event.data.traceTiming, request.sentMs, performance.now(), 'error' in event.data); } catch { /* A diagnostic envelope cannot strand a business promise. */ }
      request.trace?.end('error' in event.data ? 'error' : 'ok');
    }
    if ('error' in event.data) request.reject(new Error(event.data.error));
    else request.resolve(event.data.png);
  };
  worker.onerror = (event) => {
    const error = new Error(event.message || 'GPU readback PNG worker failed.');
    pending.forEach((request) => {
      if (import.meta.env.VITE_LICLICK_PIPELINE_TRACE_ENABLED === 'true') { request.trace?.end('error'); }
      request.reject(error);
    });
    pending.clear();
    worker?.terminate();
    worker = undefined;
  };
  return worker;
}

export function encodeFlippedGpuReadbackPngInWorker(
  pixels: Uint8Array,
  width: number,
  height: number,
  outputSize?: { width: number; height: number },
  pixelFormat: 'rgba' | 'grayscale' = 'rgba',
  traceContext?: PipelineTraceContext,
) {
  const id = nextRequestId++;
  const buffer =
    pixels.buffer instanceof ArrayBuffer &&
    pixels.byteOffset === 0 &&
    pixels.byteLength === pixels.buffer.byteLength
      ? pixels.buffer
      : pixels.slice().buffer;
  return new Promise<ArrayBuffer>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    if (import.meta.env.VITE_LICLICK_PIPELINE_TRACE_ENABLED === 'true') {
      const trace = getPipelineTrace();
      if (trace) {
        const request = pending.get(id)!;
        request.trace = trace.begin('capture.encode', traceContext);
        request.traceSession = trace; request.sentMs = performance.now();
      }
    }
    getWorker().postMessage(
      {
        id,
        pixels: buffer,
        width,
        height,
        outputWidth: outputSize?.width,
        outputHeight: outputSize?.height,
        pixelFormat,
        ...(import.meta.env.VITE_LICLICK_PIPELINE_TRACE_ENABLED === 'true' && pending.get(id)?.trace ? { traceContext: pending.get(id)!.trace!.context } : {}),
      },
      [buffer],
    );
  });
}
import { getPipelineTrace, type TraceScope, type TraceSession } from '@/engine/performance/tracing/pipelineTrace';
import type { WorkerTraceTiming, PipelineTraceContext } from '@/engine/performance/tracing/types';
