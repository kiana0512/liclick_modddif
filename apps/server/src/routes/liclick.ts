import type { IncomingMessage, ServerResponse } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { checkLiclickApiAccess, getAtlasIdentity } from '../auth/atlasAuthService.js';
import type { AuthUser } from '../auth/authTypes.js';
import { requireAuth } from '../auth/authMiddleware.js';
import {
  pollLiclickImageTask,
  submitLiclickImageEdit,
  submitLiclickImageJob,
  type EditImageInput,
  type GenerateImageInput,
  type LiclickImageSubmission,
} from '../services/liclickGenerationService.js';
import { serverConfig } from '../config.js';
import { getPathSegments, readJsonBody, sendJson } from './httpUtils.js';

type GenerationJob = {
  id: string;
  userId: string;
  projectId: string;
  workflow: 'liclick' | 'texture-map';
  atlasHomeDir?: string;
  input: GenerateImageInput;
  status: 'submitting' | 'running' | 'succeeded' | 'failed';
  startedAt: string;
  updatedAt: string;
  taskId?: string;
  model?: string;
  extraParams?: Record<string, unknown>;
  uploadedReferences?: unknown[];
  resultUrl?: string;
  resultUrls?: string[];
  raw?: unknown;
  error?: string;
  promise?: Promise<void>;
};

type EditImageJob = {
  id: string;
  userId: string;
  projectId: string;
  atlasHomeDir?: string;
  input: EditImageInput;
  status: 'submitting' | 'running' | 'succeeded' | 'failed';
  startedAt: string;
  updatedAt: string;
  taskId?: string;
  model?: string;
  extraParams?: Record<string, unknown>;
  uploadedReferences?: unknown[];
  resultUrl?: string;
  resultUrls?: string[];
  raw?: unknown;
  error?: string;
  promise?: Promise<void>;
};

const generationJobs = new Map<string, GenerationJob>();
const editImageJobs = new Map<string, EditImageJob>();
let jobsLoaded = false;
let writeQueue = Promise.resolve();
const transientWriteErrorCodes = new Set(['UNKNOWN', 'EPERM', 'EBUSY', 'EACCES', 'EMFILE', 'ENFILE']);
const maxPersistedJobs = 50;
const maxPersistedStringLength = 2000;

function jobsFile() {
  return path.join(serverConfig.workspaceDir, 'generation-jobs.json');
}

function isTransientWriteError(error: unknown) {
  const code = (error as NodeJS.ErrnoException).code;
  return Boolean(code && transientWriteErrorCodes.has(code));
}

async function delay(milliseconds: number) {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function writeJobsFileWithRetry(filePath: string, content: string) {
  let lastError: unknown;

  for (let attempt = 0; attempt < 6; attempt += 1) {
    const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.${attempt}.tmp`;
    try {
      await fs.promises.writeFile(temporaryPath, content, 'utf8');
      await fs.promises.rename(temporaryPath, filePath);
      return;
    } catch (error) {
      lastError = error;
      await fs.promises.rm(temporaryPath, { force: true }).catch(() => undefined);
      if (!isTransientWriteError(error)) break;
      await delay(35 * (attempt + 1));
    }
  }

  throw lastError;
}

function trimPersistedString(value: string) {
  if (value.startsWith('data:')) return `[data-url:${value.length}]`;
  if (value.length <= maxPersistedStringLength) return value;
  return `${value.slice(0, maxPersistedStringLength)}...[trimmed:${value.length}]`;
}

function sanitizeForPersistence(value: unknown, depth = 0): unknown {
  if (depth > 5) return '[max-depth]';
  if (typeof value === 'string') return trimPersistedString(value);
  if (typeof value !== 'object' || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => sanitizeForPersistence(item, depth + 1));
  const record = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(record)) {
    if (/raw|content|base64|buffer/i.test(key)) {
      output[key] = '[omitted]';
      continue;
    }
    output[key] = sanitizeForPersistence(child, depth + 1);
  }
  return output;
}

function getPersistableJob(job: GenerationJob) {
  const persisted: Partial<GenerationJob> = { ...job };
  delete persisted.promise;
  return sanitizeForPersistence(persisted) as Omit<GenerationJob, 'promise'>;
}

async function loadGenerationJobs() {
  if (jobsLoaded) return;
  jobsLoaded = true;
  const file = jobsFile();
  if (!fs.existsSync(file)) return;
  const content = await fs.promises.readFile(file, 'utf8').catch(() => '');
  if (!content.trim()) return;
  const jobs = JSON.parse(content) as GenerationJob[];
  for (const job of jobs) {
    job.workflow = job.workflow === 'texture-map' ? 'texture-map' : 'liclick';
    generationJobs.set(job.id, job);
  }
}

async function saveGenerationJobs() {
  await fs.promises.mkdir(serverConfig.workspaceDir, { recursive: true });
  const jobs = [...generationJobs.values()]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, maxPersistedJobs)
    .map(getPersistableJob);
  const task = writeQueue
    .then(() => writeJobsFileWithRetry(jobsFile(), `${JSON.stringify(jobs, null, 2)}\n`))
    .catch((error: unknown) => {
      console.warn('[Liclick Workspace Server] Could not persist generation jobs.', error);
    });
  writeQueue = task.then(
    () => undefined,
    () => undefined,
  );
  return task;
}

function isActiveJob(job: { status: 'submitting' | 'running' | 'succeeded' | 'failed' }) {
  return job.status === 'submitting' || job.status === 'running';
}

function getJobResponse(job: GenerationJob) {
  if (job.status === 'succeeded') {
    return {
      id: job.id,
      status: 'succeeded',
      resultUrl: job.resultUrl,
      resultUrls: job.resultUrls,
      taskId: job.taskId,
      workflow: job.workflow,
      model: job.model,
      extraParams: job.extraParams,
      uploadedReferences: job.uploadedReferences,
      startedAt: job.startedAt,
      updatedAt: job.updatedAt,
      raw: job.raw,
    };
  }
  if (job.status === 'failed') {
    return {
      id: job.id,
      status: 'failed',
      error: job.error ?? '莉刻图片生成任务失败。',
      taskId: job.taskId,
      workflow: job.workflow,
      startedAt: job.startedAt,
      updatedAt: job.updatedAt,
    };
  }
  return {
    id: job.id,
    status: 'running',
    taskId: job.taskId,
    workflow: job.workflow,
    model: job.model,
    extraParams: job.extraParams,
    uploadedReferences: job.uploadedReferences,
    startedAt: job.startedAt,
    updatedAt: job.updatedAt,
  };
}

async function getEditJobResponse(job: EditImageJob) {
  if (job.status === 'succeeded') {
    return {
      id: job.id,
      status: 'succeeded',
      outputImage: job.resultUrl ? await remoteImageToDataUrl(job.resultUrl) : undefined,
      resultUrl: job.resultUrl,
      resultUrls: job.resultUrls,
      taskId: job.taskId,
      model: job.model,
      extraParams: job.extraParams,
      uploadedReferences: job.uploadedReferences,
      startedAt: job.startedAt,
      updatedAt: job.updatedAt,
      raw: job.raw,
    };
  }
  if (job.status === 'failed') {
    return {
      id: job.id,
      status: 'failed',
      error: job.error ?? '莉刻局部重绘任务失败。',
      taskId: job.taskId,
      startedAt: job.startedAt,
      updatedAt: job.updatedAt,
    };
  }
  return {
    id: job.id,
    status: 'running',
    taskId: job.taskId,
    model: job.model,
    extraParams: job.extraParams,
    uploadedReferences: job.uploadedReferences,
    startedAt: job.startedAt,
    updatedAt: job.updatedAt,
  };
}

async function cancelGenerationJob(job: GenerationJob) {
  if (job.status === 'succeeded' || job.status === 'failed') return;
  job.status = 'failed';
  job.error = '用户已终止莉刻生图任务。';
  job.updatedAt = new Date().toISOString();
  await saveGenerationJobs();
}

async function cancelEditImageJob(job: EditImageJob) {
  if (job.status === 'succeeded' || job.status === 'failed') return;
  job.status = 'failed';
  job.error = '用户已终止局部重绘任务。';
  job.updatedAt = new Date().toISOString();
}

function findJob(idOrTaskId: string) {
  return generationJobs.get(idOrTaskId) ?? [...generationJobs.values()].find((job) => job.taskId === idOrTaskId);
}

function findEditImageJob(idOrTaskId: string) {
  return editImageJobs.get(idOrTaskId) ?? [...editImageJobs.values()].find((job) => job.taskId === idOrTaskId);
}

function findActiveProjectJob(user: AuthUser, projectId: string, workflow: GenerationJob['workflow']) {
  return [...generationJobs.values()].find(
    (job) => job.userId === user.id && job.projectId === projectId && job.workflow === workflow && isActiveJob(job),
  );
}

function findActiveProjectEditJob(user: AuthUser, projectId: string) {
  return [...editImageJobs.values()].find(
    (job) => job.userId === user.id && job.projectId === projectId && isActiveJob(job),
  );
}

async function applySubmission(job: GenerationJob, submission: LiclickImageSubmission) {
  job.taskId = submission.taskId;
  job.model = submission.model;
  job.extraParams = submission.extraParams;
  job.uploadedReferences = submission.uploadedReferences;
  job.raw = submission.raw;
  job.updatedAt = new Date().toISOString();
  if (submission.resultUrl) {
    job.status = 'succeeded';
    job.resultUrl = submission.resultUrl;
    job.resultUrls = submission.resultUrls;
  } else {
    job.status = 'running';
  }
  await saveGenerationJobs();
}

async function applyEditSubmission(job: EditImageJob, submission: LiclickImageSubmission) {
  job.taskId = submission.taskId;
  job.model = submission.model;
  job.extraParams = submission.extraParams;
  job.uploadedReferences = submission.uploadedReferences;
  job.raw = submission.raw;
  job.updatedAt = new Date().toISOString();
  if (submission.resultUrl) {
    job.status = 'succeeded';
    job.resultUrl = submission.resultUrl;
    job.resultUrls = submission.resultUrls;
  } else {
    job.status = 'running';
  }
}

async function pollAndUpdateJob(job: GenerationJob) {
  if (!job.taskId || job.status !== 'running') return job;
  const result = await pollLiclickImageTask(job.taskId, { atlasHomeDir: job.atlasHomeDir });
  job.updatedAt = new Date().toISOString();
  job.raw = result.raw;
  if (result.resultUrl) {
    job.status = 'succeeded';
    job.resultUrl = result.resultUrl;
    job.resultUrls = result.resultUrls;
  } else if (result.terminalWithoutResult) {
    job.status = 'failed';
    job.error = '莉刻后台任务已结束，但没有返回图片 URL，已停止等待。';
  }
  await saveGenerationJobs();
  return job;
}

async function pollAndUpdateEditJob(job: EditImageJob) {
  if (!job.taskId || job.status !== 'running') return job;
  const result = await pollLiclickImageTask(job.taskId, { atlasHomeDir: job.atlasHomeDir });
  job.updatedAt = new Date().toISOString();
  job.raw = result.raw;
  if (result.resultUrl) {
    job.status = 'succeeded';
    job.resultUrl = result.resultUrl;
    job.resultUrls = result.resultUrls;
  } else if (result.terminalWithoutResult) {
    job.status = 'failed';
    job.error = '莉刻局部重绘任务已结束，但没有返回图片。';
  }
  return job;
}

function startGenerationJob(job: GenerationJob) {
  if (job.promise || job.status === 'succeeded' || job.status === 'failed') return;
  job.promise = (async () => {
    try {
      if (!job.taskId && job.status === 'submitting') {
        const submission = await submitLiclickImageJob(job.input, { atlasHomeDir: job.atlasHomeDir });
        if (job.status !== 'submitting') return;
        await applySubmission(job, submission);
      }
      const startedPollingAt = Date.now();
      while (job.status === 'running' && Date.now() - startedPollingAt < 30 * 60 * 1000) {
        await new Promise((resolve) => setTimeout(resolve, 5000));
        await pollAndUpdateJob(job);
      }
    } catch (error) {
      job.status = 'failed';
      job.error = error instanceof Error ? error.message : '莉刻图片生成任务失败。';
      job.updatedAt = new Date().toISOString();
      await saveGenerationJobs();
    } finally {
      job.promise = undefined;
    }
  })();
}

function startEditImageJob(job: EditImageJob) {
  if (job.promise || job.status === 'succeeded' || job.status === 'failed') return;
  job.promise = (async () => {
    try {
      if (!job.taskId && job.status === 'submitting') {
        const submission = await submitLiclickImageEdit(job.input, { atlasHomeDir: job.atlasHomeDir });
        if (job.status !== 'submitting') return;
        await applyEditSubmission(job, submission);
      }
      const startedPollingAt = Date.now();
      while (job.status === 'running' && Date.now() - startedPollingAt < 30 * 60 * 1000) {
        await new Promise((resolve) => setTimeout(resolve, 5000));
        await pollAndUpdateEditJob(job);
      }
      if (job.status === 'running') {
        job.status = 'failed';
        job.error = '等待莉刻局部重绘超时。';
        job.updatedAt = new Date().toISOString();
      }
    } catch (error) {
      job.status = 'failed';
      job.error = error instanceof Error ? error.message : '莉刻局部重绘任务失败。';
      job.updatedAt = new Date().toISOString();
    } finally {
      job.promise = undefined;
    }
  })();
}

function createGenerationJob(jobId: string, user: AuthUser, input: GenerateImageInput): GenerationJob {
  const now = new Date().toISOString();
  const job: GenerationJob = {
    id: jobId,
    userId: user.id,
    projectId: input.projectId ?? 'default',
    workflow: input.workflow === 'texture-map' ? 'texture-map' : 'liclick',
    atlasHomeDir: user.atlasHomeDir,
    input,
    status: 'submitting',
    startedAt: now,
    updatedAt: now,
  };
  generationJobs.set(jobId, job);
  void saveGenerationJobs();
  startGenerationJob(job);
  return job;
}

function createEditImageJob(jobId: string, user: AuthUser, input: EditImageInput): EditImageJob {
  const now = new Date().toISOString();
  const job: EditImageJob = {
    id: jobId,
    userId: user.id,
    projectId: input.projectId ?? 'default',
    atlasHomeDir: user.atlasHomeDir,
    input,
    status: 'submitting',
    startedAt: now,
    updatedAt: now,
  };
  editImageJobs.set(jobId, job);
  startEditImageJob(job);
  return job;
}

async function waitForSubmitted(job: GenerationJob) {
  const startedAt = Date.now();
  while (job.status === 'submitting' && Date.now() - startedAt < 3 * 60 * 1000) {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

async function remoteImageToDataUrl(url: string) {
  const imageResponse = await fetch(url);
  if (!imageResponse.ok) throw new Error(`Could not download Liclick edit result: ${imageResponse.status}`);
  const contentType = imageResponse.headers.get('content-type') ?? 'image/png';
  const buffer = Buffer.from(await imageResponse.arrayBuffer());
  return `data:${contentType};base64,${buffer.toString('base64')}`;
}

export async function handleLiclickRoute(request: IncomingMessage, response: ServerResponse, url: URL) {
  await loadGenerationJobs();
  const segments = getPathSegments(url);
  const isLiclickRoute = segments[0] === 'api' && segments[1] === 'liclick';
  const isLegacyGenerateRoute = segments[0] === 'api' && segments[1] === 'generate-image';
  if (!isLiclickRoute && !isLegacyGenerateRoute) return false;
  const user = await requireAuth(request, response);
  if (!user) return true;

  if (isLiclickRoute && request.method === 'GET' && segments[2] === 'status') {
    const result = await checkLiclickApiAccess(user);
    sendJson(response, result.ok ? 200 : 503, result);
    return true;
  }

  const isGenerateImageRoute =
    isLegacyGenerateRoute ||
    (isLiclickRoute && ['generate-image', 'generate', 'generate_image'].includes(segments[2] ?? ''));

  if (request.method === 'GET' && isLiclickRoute && segments[2] === 'generate-image' && segments[3]) {
    const job = findJob(segments[3]);
    if (!job || job.userId !== user.id) {
      sendJson(response, 404, { error: 'Generation job not found.' });
      return true;
    }
    if (job.status === 'running' && job.taskId) {
      await pollAndUpdateJob(job).catch((error: unknown) => {
        job.status = 'failed';
        job.error = error instanceof Error ? error.message : '莉刻图片生成任务失败。';
        job.updatedAt = new Date().toISOString();
        void saveGenerationJobs();
      });
    }
    startGenerationJob(job);
    sendJson(response, 200, getJobResponse(job));
    return true;
  }

  if (request.method === 'DELETE' && isLiclickRoute && segments[2] === 'generate-image' && segments[3]) {
    const job = findJob(segments[3]);
    if (!job || job.userId !== user.id) {
      sendJson(response, 404, { error: 'Generation job not found.' });
      return true;
    }
    await cancelGenerationJob(job);
    sendJson(response, 200, getJobResponse(job));
    return true;
  }

  if (request.method === 'GET' && isLiclickRoute && segments[2] === 'edit-image' && segments[3]) {
    const job = findEditImageJob(segments[3]);
    if (!job || job.userId !== user.id) {
      try {
        const result = await pollLiclickImageTask(segments[3], { atlasHomeDir: user.atlasHomeDir });
        sendJson(response, 200, {
          id: segments[3],
          status: result.resultUrl ? 'succeeded' : 'running',
          outputImage: result.resultUrl ? await remoteImageToDataUrl(result.resultUrl) : undefined,
          resultUrl: result.resultUrl,
          resultUrls: result.resultUrls,
          taskId: segments[3],
          updatedAt: new Date().toISOString(),
          raw: result.raw,
        });
        return true;
      } catch {
        // Fall through to the normal not-found response when the id is not a remote Liclick task id.
      }
      sendJson(response, 404, { error: 'Edit image job not found.' });
      return true;
    }
    if (job.status === 'running' && job.taskId) {
      await pollAndUpdateEditJob(job).catch((error: unknown) => {
        job.status = 'failed';
        job.error = error instanceof Error ? error.message : '莉刻局部重绘任务失败。';
        job.updatedAt = new Date().toISOString();
      });
    }
    startEditImageJob(job);
    sendJson(response, 200, await getEditJobResponse(job));
    return true;
  }

  if (request.method === 'DELETE' && isLiclickRoute && segments[2] === 'edit-image' && segments[3]) {
    const job = findEditImageJob(segments[3]);
    if (!job || job.userId !== user.id) {
      sendJson(response, 404, { error: 'Edit image job not found.' });
      return true;
    }
    await cancelEditImageJob(job);
    sendJson(response, 200, await getEditJobResponse(job));
    return true;
  }

  if (request.method === 'POST' && isLiclickRoute && segments[2] === 'edit-image') {
    const atlasIdentity = getAtlasIdentity(user.atlasHomeDir);
    if (
      user.email &&
      atlasIdentity.email &&
      user.email.toLowerCase() !== atlasIdentity.email.toLowerCase()
    ) {
      sendJson(response, 403, {
        error: 'Current Atlas / Liclick account does not match this browser session. Please log in again.',
        sessionEmail: user.email,
        atlasEmail: atlasIdentity.email,
      });
      return true;
    }
    const input = await readJsonBody<EditImageInput>(request);
    if (!input.image || !input.mask || !input.prompt?.trim()) {
      sendJson(response, 400, { error: 'Image, mask, and prompt are required for local repaint.' });
      return true;
    }
    const projectId = input.projectId ?? 'default';
    const activeJob = findActiveProjectEditJob(user, projectId);
    if (activeJob) {
      startEditImageJob(activeJob);
      sendJson(response, 202, {
        ...(await getEditJobResponse(activeJob)),
        activeProjectJob: true,
        message: 'This project already has a running local repaint task.',
      });
      return true;
    }
    const jobId = input.clientEditId || `liclick-edit-${Date.now()}`;
    const job = createEditImageJob(jobId, user, { ...input, projectId });
    if (job.userId !== user.id) {
      sendJson(response, 403, { error: 'Edit image job belongs to another user.' });
      return true;
    }
    sendJson(response, 202, await getEditJobResponse(job));
    return true;
  }

  if (request.method === 'POST' && isGenerateImageRoute) {
    const atlasIdentity = getAtlasIdentity(user.atlasHomeDir);
    if (
      user.email &&
      atlasIdentity.email &&
      user.email.toLowerCase() !== atlasIdentity.email.toLowerCase()
    ) {
      sendJson(response, 403, {
        error: 'Current Atlas / Liclick account does not match this browser session. Please log in again.',
        sessionEmail: user.email,
        atlasEmail: atlasIdentity.email,
      });
      return true;
    }
    const input = await readJsonBody<GenerateImageInput>(request);
    const projectId = input.projectId ?? 'default';
    const workflow = input.workflow === 'texture-map' ? 'texture-map' : 'liclick';
    const activeJob = findActiveProjectJob(user, projectId, workflow);
    if (activeJob) {
      startGenerationJob(activeJob);
      sendJson(response, 202, {
        ...getJobResponse(activeJob),
        activeProjectJob: true,
        message: 'This project already has a running image generation task.',
      });
      return true;
    }
    const jobId = input.clientGenerationId || `liclick-image-${Date.now()}`;
    const job = createGenerationJob(jobId, user, { ...input, projectId, workflow });
    if (job.userId !== user.id) {
      sendJson(response, 403, { error: 'Generation job belongs to another user.' });
      return true;
    }
    await waitForSubmitted(job);
    if (job.status === 'failed') {
      sendJson(response, 500, getJobResponse(job));
      return true;
    }
    sendJson(response, job.status === 'succeeded' ? 200 : 202, getJobResponse(job));
    return true;
  }

  return false;
}
