import type { PipelineTraceContext } from '@/engine/performance/tracing/types';
import { getPipelineTrace, traceSync } from './pipelineTrace';

/** Per-loader hooks preserve callbacks and data; no global LoadingManager mutation. */
export function traceSyncModelLoader<Args extends unknown[], Result>(loader: {
  parse: (...args: Args) => Result;
  load: (url: string, onLoad: (result: Result) => void, onProgress?: (event: ProgressEvent) => void, onError?: (error: unknown) => void) => unknown;
}, parent?: PipelineTraceContext) {
  const trace = getPipelineTrace();
  if (!trace) return;
  const parse = loader.parse, load = loader.load;
  let reading: ReturnType<typeof trace.begin>;
  loader.parse = (...args) => {
    reading?.end();
    return traceSync(trace, 'model.parse', () => parse.apply(loader, args), parent);
  };
  loader.load = (url, onLoad, onProgress, onError) => {
    reading = trace.begin('model.read', parent);
    try { return load.call(loader, url, onLoad, onProgress, error => { reading?.end('error'); onError?.(error); }); }
    catch (error) { reading?.end('error'); throw error; }
  };
}
