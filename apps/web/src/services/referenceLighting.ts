import { createLiclickApiClient, LiclickApiError } from './liclickApiClient';
import { urlToBlob } from './workspaceApiClient';
import { useAuthStore } from '@/stores/authStore';
import type { ReferenceImage } from '@/types/project';
import { sha256Hex } from '@/utils/sha256';

// REFERENCE-LIGHTING/2.0.1: stable server job is the private source/result binding.
// No component abort signal owns the shared processing request.
const pending = new Map<string, Promise<string>>();
const digests = new Map<string, Promise<string>>();
function contentDigest(url: string) {
  let task = digests.get(url);
  if (!task) {
    task = urlToBlob(url).then(sha256Hex);
    digests.set(url, task);
    void task.catch(() => digests.delete(url));
  }
  return task;
}
const active = new Map<string, { projectId: string; controller: AbortController }>();
const pausedProjects = new Set<string>();
window.addEventListener('beforeunload', event => {
  if (!active.size) return;
  event.preventDefault();
  event.returnValue = '';
});
export function hasReferenceLightingWork(projectId: string) {
  return [...active.values()].some(work => work.projectId === projectId);
}
export async function interruptReferenceLighting(projectId: string) {
  pausedProjects.add(projectId);
  await Promise.all([...active].filter(([, work]) => work.projectId === projectId).map(async ([id, work]) => {
    const result = await createLiclickApiClient().cancelGenerationJob(id);
    if (result.status === 'succeeded') return;
    work.controller.abort();
    pending.delete(id);
    const [key, attempt] = id.split('-g');
    localStorage.setItem(key!, String(Number(attempt ?? 0) + 1));
  }));
}
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

async function identity(projectId: string, reference: ReferenceImage) {
  const bytes = new TextEncoder().encode(JSON.stringify(['lighting-v2', useAuthStore.getState().user?.id, projectId, reference.id, await contentDigest(reference.url)]));
  const key = `reference-lighting-${await sha256Hex(bytes)}`;
  const attempt = Number(localStorage.getItem(key) ?? 0);
  let id = `${key}-g${attempt}`;
  if (!pending.has(id)) {
    // Only the old, explicit pre-upload failure is safe to migrate. Never
    // replay an accepted/ambiguous paid task or invalidate successful bindings.
    const job = await createLiclickApiClient().getGenerationJob(id).catch(() => undefined);
    if (job?.status === 'failed' && !job.taskId && job.error?.includes('当前服务未配置大图对象存储上传。未提交生成任务')) {
      localStorage.setItem(key, String(attempt + 1));
      id = `${key}-g${attempt + 1}`;
    }
  }
  return id;
}

async function processReference(projectId: string, reference: ReferenceImage, id: string, signal: AbortSignal) {
  const client = createLiclickApiClient();
  let job;
  try { job = await client.getGenerationJob(id, { signal }); }
  catch (error) {
    if (!(error instanceof LiclickApiError) || error.status !== 404) throw error;
    const submitted = await client.generateTextureSingleView({
      signal, clientGenerationId: id, projectId, workflow: 'liclick', mode: 'single', prompt: '',
      referenceIds: [reference.id], referenceImages: [reference], pixelExactReferenceIds: [reference.id],
      referencePipeline: 'delight-only-v1', backgroundReference: true,
      model: 'gpt-image-2.5-sunburst', quality: 'medium', aspectRatio: 'auto', imageSize: 'auto', count: 1,
      visibleOnly: true, upscale: false,
    });
    job = { id, status: submitted.status, resultUrl: submitted.resultUrl, error: String(submitted.metadata.error ?? '') };
  }
  while (job.status !== 'failed' && !job.resultUrl) {
    await pause(2500);
    signal.throwIfAborted();
    job = await client.getGenerationJob(id, { signal });
  }
  if (!job.resultUrl) throw new Error(job.error || '参考图处理失败，请重试。');
  return job.resultUrl;
}

export async function prepareReferenceLighting(projectId: string, reference: ReferenceImage, signal?: AbortSignal): Promise<ReferenceImage> {
  signal?.throwIfAborted();
  if (reference.lightingProcessed === 'reference-delight-v1') return { ...reference };
  const id = await identity(projectId, reference);
  let task = pending.get(id);
  if (!task) {
    const controller = new AbortController();
    active.set(id, { projectId, controller });
    task = (async () => {
      for (let attempt = 0; ; attempt++) {
        try { return await processReference(projectId, { ...reference }, id, controller.signal); }
        catch (error) {
          if (controller.signal.aborted || attempt >= 4 ||
              !(error instanceof TypeError || (error instanceof LiclickApiError && (error.status >= 500 || error.status === 429)))) throw error;
          await pause(Math.min(1000 * 2 ** attempt, 10000));
        }
      }
    })().finally(() => active.delete(id));
    pending.set(id, task);
    void task.catch(() => { if (pending.get(id) === task) pending.delete(id); });
  }
  // Cancel only this consumer; background work and other consumers keep running.
  let abort: (() => void) | undefined;
  try {
    const url = await Promise.race([task, new Promise<never>((_, reject) => {
      abort = () => reject(new DOMException('已取消等待图片处理。', 'AbortError'));
      if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
    })]);
    return { ...reference, url };
  } finally { if (abort) signal?.removeEventListener('abort', abort); }
}

export function warmReferenceLighting(projectId: string, references: ReferenceImage[]) {
  pausedProjects.delete(projectId);
  // Sequential warm-up avoids uploading every imported image at once.
  void (async () => {
    for (const reference of references) {
      if (pausedProjects.has(projectId)) break;
      try { await prepareReferenceLighting(projectId, reference); }
      catch (error) { console.warn('[Reference lighting] Background preparation pending', reference.id, error); }
    }
  })();
}
