import type { PipelineTraceName, PipelineTraceContext } from '@/engine/performance/tracing/types';
import { getPipelineTrace, traceAsync } from './pipelineTrace';

/** Classify only a pathname; neither URL nor payload enters diagnostics. */
export function traceRequestName(path: string, method = 'GET'): PipelineTraceName {
  const pathname = path.split('?')[0];
  if (pathname.endsWith('/asset-processing/import-decimate')) return 'decimate.request';
  if (pathname.endsWith('/asset-processing/import-uv-repair')) return 'uv.request';
  if (/\/commands$/.test(pathname)) return 'save.command';
  if (/\/assets\/intents\/[^/]+\/complete$/.test(pathname)) return 'asset.verify';
  if (/\/assets\/intents$/.test(pathname)) return 'asset.upload.intent';
  if (/\/projects\/[^/]+$/.test(pathname) && method === 'GET') return 'project.fetch';
  if (/\/projects$/.test(pathname) && method === 'POST') return 'project.create';
  if (/\/liclick\/generate-image\/[^/]+(?:\/cancel)?$/.test(pathname)) return method === 'GET' ? 'generation.poll.request' : 'generation.cancel';
  if (/\/liclick\/generate-image$/.test(pathname)) return method === 'POST' ? 'generation.submit' : 'generation.restore';
  if (/\/modelview\/(inpaint|generate)/.test(pathname)) return 'provider.opaque_wait';
  return 'http.request';
}

/** Explicit call-site adapter; never monkey-patches fetch or forwards baggage. */
export function traceFetch(url: string, init?: RequestInit, parent?: PipelineTraceContext): Promise<Response> {
  let session = getPipelineTrace();
  if (!session) return fetch(url, init);
  let destination: URL;
  try { destination = new URL(url, window.location.href); } catch { return fetch(url, init); }
  const project = /\/api\/projects\/([^/]+)/.exec(destination.pathname)?.[1];
  if (project) {
    try { session = getPipelineTrace(decodeURIComponent(project)); } catch { session = undefined; }
    if (!session) return fetch(url, init);
  }
  const scope = session.begin(traceRequestName(destination.pathname, init?.method), parent);
  return fetch(url, init).then(response => {
    scope?.end(response.ok ? 'ok' : 'error'); return response;
  }, error => {
    scope?.end(error instanceof Error && error.name === 'AbortError' ? 'cancelled' : 'error'); throw error;
  });
}


export function traceJson<T>(response: Response): Promise<T> {
  const session = getPipelineTrace();
  return session ? traceAsync(session, 'http.decode', () => response.json() as Promise<T>) : response.json() as Promise<T>;
}
