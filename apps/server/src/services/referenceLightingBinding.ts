import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { projectRepository } from '../repositories/projectRepository.js';
import { getUserProjectDir } from './workspaceService.js';
import { serverConfig } from '../config.js';
import { writeFileAtomically } from './atomicFileService.js';
import { saveRemoteImageAsset } from './assetFileService.js';
import type { GenerationJob } from '../routes/liclick.js';

function bindingPath(userId: string, jobId: string) {
  const key = createHash('sha256').update(JSON.stringify([userId, jobId])).digest('hex');
  return path.join(serverConfig.workspaceDir, 'reference-lighting', `${key}.json`);
}
export async function readReferenceLightingBinding(userId: string, jobId: string): Promise<GenerationJob | undefined> {
  try {
    const job = JSON.parse(await fs.readFile(bindingPath(userId, jobId), 'utf8')) as GenerationJob;
    if (!(await projectRepository.findSlug(userId, job.projectId))) return undefined;
    return job.userId === userId && job.id === jobId && job.status === 'succeeded' ? job : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}
export async function bindReferenceLightingResult(job: GenerationJob) {
  if (!job.input.backgroundReference || !job.resultUrl) return;
  const asset = await saveRemoteImageAsset({ userId: job.userId, projectId: job.projectId,
    category: 'references', url: job.resultUrl, filename: `${job.id}.png` });
  if (!asset) throw new Error('参考图处理结果保存失败。');
  job.resultUrl = asset.url;
  job.resultUrls = [asset.url];
  const file = bindingPath(job.userId, job.id);
  await fs.mkdir(path.dirname(file), { recursive: true });
  // Keep only the durable private binding, never data URLs or credentials.
  const binding = { id: job.id, userId: job.userId, projectId: job.projectId, workflow: job.workflow,
    input: { backgroundReference: true, referencePipeline: 'delight-only-v1' },
    status: 'succeeded', resultUrl: asset.url, resultUrls: [asset.url],
    startedAt: job.startedAt, updatedAt: job.updatedAt };
  const slug = await projectRepository.findSlug(job.userId, job.projectId);
  if (slug) {
    const retained = path.join(getUserProjectDir(job.userId, slug), '.reference-lighting');
    await fs.mkdir(retained, { recursive: true });
    await writeFileAtomically(path.join(retained, path.basename(file)), JSON.stringify(binding));
  }
  await writeFileAtomically(file, JSON.stringify(binding));
}
