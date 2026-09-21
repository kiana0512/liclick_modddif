import { fileToDataUrl } from './workspaceApiClient';
import type { ModelviewInpaintInput } from './modelviewApiClient';

const endpoint = 'https://uu765793-78993043bdb0.bjb1.seetacloud.com:8443';
let accessCode = '';
let materialCache: { dataUrl: string; id: string } | undefined;
type Job = { id: string; status: string; workflow: string; error?: string; materialCacheId?: string; timings?: Record<string, number> };

async function request(path: string, init: RequestInit = {}) {
  const response = await fetch(`${endpoint}${path}`, {
    ...init, credentials: 'omit', redirect: 'error', cache: 'no-store',
    headers: { ...init.headers, 'Content-Type': 'application/json', Authorization: `Bearer ${accessCode}` },
  });
  if (!response.ok) {
    if (response.status === 401) { accessCode = ''; materialCache = undefined; }
    const error = await response.json().catch(() => ({}));
    throw Object.assign(new Error(error.error || `个人云端请求失败 (${response.status})`), { status: response.status });
  }
  return response;
}

export async function connectPersonalRepaint(signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (!accessCode) accessCode = window.prompt('输入个人云端访问码（仅用于当前页面）')?.trim() || '';
  if (!accessCode) throw new DOMException('已取消个人云端连接。', 'AbortError');
  const timeout = AbortSignal.timeout(15000);
  const health = await (await request('/health', { signal: signal ? AbortSignal.any([signal, timeout]) : timeout })).json();
  if (!health.ready) throw new Error('个人云端工作流尚未就绪。');
}

export async function generatePersonalRepaint(input: ModelviewInpaintInput, signal?: AbortSignal, onStatus?: (status: string) => void) {
  signal?.throwIfAborted();
  if (!accessCode) await connectPersonalRepaint(signal);
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', abort, { once: true });
  const timeout = window.setTimeout(() => controller.abort(new DOMException('个人云端生成超时。', 'TimeoutError')), 2_760_000);
  let job: Job | undefined;
  let lastStatus = '';
  const publishStatus = (status: string) => {
    if (status !== lastStatus) { lastStatus = status; onStatus?.(status); }
  };
  try {
    publishStatus('uploading');
    const startedAt = performance.now();
    let serializeMs = 0, compressionMs = 0, submitRoundtripMs = 0, uploadBytes = 0, uncompressedBytes = 0;
    let referenceCacheHit = materialCache?.dataUrl === input.materialImage.dataUrl;
    async function submit(useCache: boolean): Promise<Job> {
      const prepareAt = performance.now();
      const payload = useCache ? { ...input, materialImage: { path: input.materialImage.path, cacheId: materialCache!.id } } : input;
      const plain = new Blob([JSON.stringify(payload)], { type: 'application/json' });
      const serializedAt = performance.now();
      serializeMs += serializedAt - prepareAt;
      let body = plain;
      const headers: Record<string, string> = {};
      if (typeof CompressionStream !== 'undefined') {
        const compressed = await new Response(plain.stream().pipeThrough(new CompressionStream('gzip'))).blob();
        if (compressed.size < plain.size) { body = compressed; headers['Content-Encoding'] = 'gzip'; }
      }
      compressionMs += performance.now() - serializedAt;
      controller.signal.throwIfAborted();
      uploadBytes += body.size;
      uncompressedBytes += plain.size;
      const submittedAt = performance.now();
      try {
        return await (await request('/jobs', { method: 'POST', body, headers, signal: controller.signal })).json() as Job;
      } finally { submitRoundtripMs += performance.now() - submittedAt; }
    }
    try { job = await submit(referenceCacheHit); }
    catch (error) {
      // 428 means the server rejected a missing cache entry before queuing any work.
      if (!referenceCacheHit || (error as { status?: number }).status !== 428) throw error;
      materialCache = undefined;
      referenceCacheHit = false;
      job = await submit(false);
    }
    if (job.materialCacheId) materialCache = { dataUrl: input.materialImage.dataUrl, id: job.materialCacheId };
    const submittedAt = performance.now();
    while (job.status === 'queued' || job.status === 'running') {
      publishStatus(job.status);
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => { window.clearTimeout(timer); reject(controller.signal.reason); };
        const timer = window.setTimeout(() => { controller.signal.removeEventListener('abort', onAbort); resolve(); }, 1500);
        if (controller.signal.aborted) onAbort();
        else controller.signal.addEventListener('abort', onAbort, { once: true });
      });
      job = await (await request(`/jobs/${encodeURIComponent(job.id)}`, { signal: controller.signal })).json() as Job;
    }
    if (job.status !== 'succeeded') throw new Error(job.error || '个人云端任务未完成。');
    publishStatus('downloading');
    const readyAt = performance.now();
    const response = await request(`/jobs/${encodeURIComponent(job.id)}/result`, { signal: controller.signal });
    if (!response.headers.get('content-type')?.startsWith('image/png')) throw new Error('个人云端返回了非 PNG 内容。');
    const blob = await response.blob();
    const downloadedAt = performance.now();
    const resultUrl = await fileToDataUrl(new File([blob], 'repaint.png', { type: 'image/png' }));
    const convertedAt = performance.now();
    const timings = { serializeMs, compressionMs, submitRoundtripMs, uploadBytes, uncompressedBytes, referenceCacheHit,
      waitForJobMs: readyAt - submittedAt, downloadMs: downloadedAt - readyAt,
      dataUrlMs: convertedAt - downloadedAt, totalMs: convertedAt - startedAt, server: job.timings ?? {} };
    controller.signal.throwIfAborted();
    return { id: input.clientGenerationId, modelviewJobId: job.id, resultUrl, workflow: job.workflow, timings };
  } catch (error) {
    if (controller.signal.aborted && job) {
      void request(`/jobs/${encodeURIComponent(job.id)}`, { method: 'DELETE', signal: AbortSignal.timeout(5000) }).catch(() => undefined);
    }
    throw error;
  } finally {
    window.clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  }
}
