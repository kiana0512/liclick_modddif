import {
  ASSET_TRANSFER_PROTOCOL_VERSION,
  PROJECT_COMMAND_SCHEMA_VERSION,
  isProjectRevision,
  type AssetUploadIntent,
  type ProjectCommand,
  type ProjectRevision,
} from '@liclick/contracts';
import type { Project } from '@/types/project';
import { getProjectApiBase } from '@/platform/projectApiBase';
import { isCloudBuild } from '@/platform/runtimeCapabilities';
import { createId } from '@/utils/id';
import { getWorkspaceApiBase } from './workspaceApiBase';

const workspaceApiBase = getProjectApiBase();
const generationWorkspaceApiBase = getWorkspaceApiBase(import.meta.env.VITE_LICLICK_WORKSPACE_API);
const maxWorkspaceImageBytes = 160 * 1024 * 1024;
const projectMutationTails = new Map<string, Promise<void>>();
const loopbackHosts = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

function isIntegratedLoopbackWorkspace() {
  if (typeof window === 'undefined') return false;
  try {
    const apiBase = new URL(workspaceApiBase || '/', window.location.href);
    return apiBase.origin === window.location.origin && loopbackHosts.has(apiBase.hostname);
  } catch {
    return false;
  }
}

async function withProjectMutationLock<T>(projectId: string, task: () => Promise<T>): Promise<T> {
  const previous = projectMutationTails.get(projectId) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.catch(() => undefined).then(() => gate);
  projectMutationTails.set(projectId, tail);

  await previous.catch(() => undefined);
  try {
    return await task();
  } finally {
    release();
    if (projectMutationTails.get(projectId) === tail) projectMutationTails.delete(projectId);
  }
}

function waitForRevisionRetry(attempt: number) {
  const delayMs = Math.min(500, 40 * 2 ** attempt);
  return new Promise<void>((resolve) => window.setTimeout(resolve, delayMs));
}

export function workspacePathAtBase(url: string, base: string) {
  try {
    const baseUrl = new URL(base);
    const basePath = baseUrl.pathname.replace(/\/$/, '');
    const candidate = new URL(url, `${baseUrl.origin}${basePath || '/'}`);
    if (candidate.origin !== baseUrl.origin) return undefined;
    const workspacePrefix = `${basePath}/workspace/`;
    if (candidate.pathname.startsWith(workspacePrefix)) {
      return candidate.pathname.slice(basePath.length);
    }
    // Projects created before a public base path was configured contain
    // same-origin /workspace URLs. Keep recognizing them so Cloud can migrate
    // the bytes instead of treating the URL as an untrusted remote import.
    if (basePath && candidate.pathname.startsWith('/workspace/')) {
      return candidate.pathname;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

const trustedGenerationWorkspacePath =
  /^\/workspace\/(?:(?:(?:users\/[^/]+\/projects\/[^/]+|projects\/[^/]+)\/(?:assets|thumbnails|exports))\/.+|users\/[^/]+\/recoveries\/modelview-inpaint\/[^/]+)$/i;

export class WorkspaceApiError extends Error {
  status: number;
  code?: string;
  currentRevision?: ProjectRevision;

  constructor(
    status: number,
    message: string,
    details: { code?: string; currentRevision?: ProjectRevision } = {},
  ) {
    super(message);
    this.name = 'WorkspaceApiError';
    this.status = status;
    this.code = details.code;
    this.currentRevision = details.currentRevision;
  }
}

export type WorkspaceFolder = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  order: number;
};

export type ProjectSummary = {
  id: string;
  name: string;
  folderId?: string | null;
  createdAt: string;
  updatedAt: string;
  thumbnail: string;
  local: boolean;
  slug: string;
  localPath?: string;
  status?: 'local';
  revision?: ProjectRevision;
};

export type AssetCategory =
  | 'models'
  | 'references'
  | 'captures'
  | 'generations'
  | 'layers'
  | 'baked';

async function requestJson<T>(
  path: string,
  init?: RequestInit & { timeoutMs?: number },
): Promise<T> {
  const { timeoutMs = 3000, headers, ...fetchInit } = init ?? {};
  const requestHeaders = new Headers(headers);
  if (fetchInit.body && !requestHeaders.has('content-type')) {
    requestHeaders.set('content-type', 'application/json');
  }
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetch(`${workspaceApiBase}${path}`, {
      ...fetchInit,
      signal: controller.signal,
      headers: requestHeaders,
      credentials: 'include',
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new WorkspaceApiError(408, '本地工作区响应超时，请稍后重试。');
    }
    throw new WorkspaceApiError(0, '无法连接本地工作区服务，请确认应用服务已启动。');
  } finally {
    window.clearTimeout(timeout);
  }
  if (!response.ok) {
    const payload = await response.json().catch(() => undefined);
    const message =
      payload &&
      typeof payload === 'object' &&
      'error' in payload &&
      typeof payload.error === 'string'
        ? payload.error
        : `Workspace request failed: ${response.status}`;
    const code =
      payload &&
      typeof payload === 'object' &&
      'code' in payload &&
      typeof payload.code === 'string'
        ? payload.code
        : undefined;
    const currentRevisionCandidate =
      payload && typeof payload === 'object' && 'currentRevision' in payload
        ? payload.currentRevision
        : undefined;
    const currentRevision = isProjectRevision(currentRevisionCandidate)
      ? currentRevisionCandidate
      : undefined;
    throw new WorkspaceApiError(response.status, message, { code, currentRevision });
  }
  return response.json() as Promise<T>;
}

export async function getWorkspaceHealth() {
  return requestJson<{ ok: boolean; workspaceDir: string; workspaceVersion: string }>(
    '/api/health',
    {
      timeoutMs: 900,
    },
  );
}

export async function listProjects() {
  const result = await requestJson<{ projects?: unknown }>('/api/projects');
  return { projects: Array.isArray(result.projects) ? (result.projects as ProjectSummary[]) : [] };
}

export async function createProject(input: { name?: string; folderId?: string }) {
  return requestJson<{ project: Project; slug: string }>('/api/projects', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function loadProject(projectId: string) {
  const result = await requestJson<{ project: Project; slug: string }>(
    `/api/projects/${projectId}`,
    { cache: 'no-store' },
  );
  return {
    ...result,
    project: resolveCloudTransferredProjectAssets(result.project),
  };
}

function resolveCloudTransferredAssetUrl(projectId: string, url?: string) {
  if (!isCloudBuild || !url) return url;
  try {
    const candidate = new URL(url, window.location.href);
    const match = /\/objects\/(asset-[a-zA-Z0-9-]+)$/.exec(candidate.pathname);
    if (!match?.[1]) return url;
    return `${workspaceApiBase}/api/projects/${encodeURIComponent(projectId)}/assets/${encodeURIComponent(match[1])}/content`;
  } catch {
    return url;
  }
}

function resolveCloudTransferredProjectAssets(project: Project): Project {
  const resolve = (url?: string) => resolveCloudTransferredAssetUrl(project.id, url);
  return {
    ...project,
    thumbnail: resolve(project.thumbnail) ?? '',
    objects: project.objects.map((object) => ({
      ...object,
      sourcePath: resolve(object.sourcePath),
    })),
    references: project.references.map((reference) => ({
      ...reference,
      url: resolve(reference.url) ?? reference.url,
    })),
    captures: project.captures.map((capture) => ({
      ...capture,
      colorUrl: resolve(capture.colorUrl) ?? capture.colorUrl,
      maskUrl: resolve(capture.maskUrl) ?? capture.maskUrl,
      depthUrl: resolve(capture.depthUrl),
      normalUrl: resolve(capture.normalUrl),
    })),
    generations: project.generations.map((generation) => ({
      ...generation,
      resultUrl: resolve(generation.resultUrl),
    })),
    layers: project.layers.map((layer) => ({
      ...layer,
      imageUrl: resolve(layer.imageUrl) ?? layer.imageUrl,
      maskUrl: resolve(layer.maskUrl),
      depthUrl: resolve(layer.depthUrl),
      renderedColorMaskUrl: resolve(layer.renderedColorMaskUrl),
      localRepaintSourceUrl: resolve(layer.localRepaintSourceUrl),
      localRepaintMaskUrl: resolve(layer.localRepaintMaskUrl),
    })),
    bakedTextures: project.bakedTextures.map((texture) => ({
      ...texture,
      imageUrl: resolve(texture.imageUrl) ?? texture.imageUrl,
    })),
  };
}

export function directAssetPathAtBase(url: string, base: string) {
  try {
    const baseUrl = new URL(base);
    const basePath = baseUrl.pathname.replace(/\/$/, '');
    const candidate = new URL(url, `${baseUrl.origin}${basePath || '/'}`);
    if (candidate.origin !== baseUrl.origin) return undefined;
    const directAssetSuffix = '/api/projects/[^/]+/assets/[^/]+/content';
    const directAssetPattern = new RegExp(
      `^${basePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(${directAssetSuffix})$`,
    );
    const basedMatch = directAssetPattern.exec(candidate.pathname);
    if (basedMatch?.[1]) return basedMatch[1];
    // A base-path rollout must not turn an existing same-origin durable asset
    // into a "remote URL". Canonicalize the old root API path through the
    // current authenticated API base before resolving its signed download.
    if (basePath && new RegExp(`^${directAssetSuffix}$`).test(candidate.pathname)) {
      return candidate.pathname;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

type ProjectCommandResponse = {
  project: Project;
  slug: string;
  command: {
    id: string;
    kind: ProjectCommand['kind'];
    replayed: boolean;
    revision?: ProjectRevision;
  };
};

function createProjectCommandId() {
  return createId('command');
}

async function executeProjectCommand(command: ProjectCommand, timeoutMs = 3000) {
  const init = {
    method: 'POST',
    body: JSON.stringify(command),
    timeoutMs,
  };
  try {
    return await requestJson<ProjectCommandResponse>(
      `/api/projects/${command.projectId}/commands`,
      init,
    );
  } catch (error) {
    if (!(error instanceof WorkspaceApiError) || ![0, 408].includes(error.status)) throw error;
    return requestJson<ProjectCommandResponse>(`/api/projects/${command.projectId}/commands`, init);
  }
}

export async function renameProject(projectId: string, name: string, expectedRevisionId?: string) {
  if (isCloudBuild) {
    return executeProjectCommand({
      schemaVersion: PROJECT_COMMAND_SCHEMA_VERSION,
      id: createProjectCommandId(),
      projectId,
      expectedRevisionId,
      issuedAt: new Date().toISOString(),
      kind: 'rename-project',
      payload: { name },
    });
  }
  return requestJson<{ project: Project; slug: string }>(`/api/projects/${projectId}`, {
    method: 'PATCH',
    body: JSON.stringify({ name, expectedRevisionId }),
  });
}

export async function deleteProject(projectId: string) {
  return requestJson<{ deleted: true; projectId: string; slug: string; trashSlug: string }>(
    `/api/projects/${projectId}`,
    { method: 'DELETE' },
  );
}

export async function duplicateProject(projectId: string) {
  return requestJson<{ project: Project; slug: string }>(`/api/projects/${projectId}/duplicate`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export async function moveProject(
  projectId: string,
  folderId: string | null,
  expectedRevisionId?: string,
) {
  if (isCloudBuild) {
    return executeProjectCommand({
      schemaVersion: PROJECT_COMMAND_SCHEMA_VERSION,
      id: createProjectCommandId(),
      projectId,
      expectedRevisionId,
      issuedAt: new Date().toISOString(),
      kind: 'move-project',
      payload: { folderId },
    });
  }
  return requestJson<{ project: Project; slug: string }>(`/api/projects/${projectId}/move`, {
    method: 'POST',
    body: JSON.stringify({ folderId, expectedRevisionId }),
  });
}

async function saveProjectDirect(project: Project) {
  if (isCloudBuild) {
    const document = {
      ...project,
      workspaceVersion: project.workspaceVersion ?? '0.6.0',
    } as unknown as Record<string, unknown>;
    return executeProjectCommand(
      {
        schemaVersion: PROJECT_COMMAND_SCHEMA_VERSION,
        id: createProjectCommandId(),
        projectId: project.id,
        expectedRevisionId: project.revision?.id,
        issuedAt: new Date().toISOString(),
        kind: 'replace-project-document',
        payload: { document },
      },
      30_000,
    );
  }
  return requestJson<{ project: Project; slug: string }>(`/api/projects/${project.id}`, {
    method: 'PUT',
    body: JSON.stringify({ ...project, workspaceVersion: project.workspaceVersion ?? '0.6.0' }),
    timeoutMs: 30_000,
  });
}

export async function saveProject(project: Project) {
  return withProjectMutationLock(project.id, () => saveProjectDirect(project));
}

/**
 * Apply a project mutation to the newest server document and retry revision
 * conflicts. Long-running cloud tasks and direct asset uploads can advance a
 * project while a workflow page is still open, so handing an old React/store
 * snapshot straight to saveProject would correctly be rejected by the server.
 */
export async function updateLatestProject(
  projectId: string,
  update: (latest: Project) => Project,
  maxAttempts = 3,
) {
  return withProjectMutationLock(projectId, async () => {
    let lastConflict: WorkspaceApiError | undefined;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const latest = (await loadProject(projectId)).project;
      const candidate = update(latest);
      const latestUpdatedAt = Date.parse(latest.updatedAt);
      const candidateUpdatedAt = Date.parse(candidate.updatedAt);
      // The file repository guards both revision id and updatedAt. Browser clocks
      // can trail the server and a retry can outlive the timestamp captured by
      // the workflow, so keep the outgoing document monotonic against the
      // authoritative project rather than weakening the server's stale guard.
      const monotonicUpdatedAt = Number.isFinite(latestUpdatedAt)
        ? new Date(Math.max(Date.now(), latestUpdatedAt + 1)).toISOString()
        : new Date().toISOString();
      try {
        return await saveProjectDirect({
          ...candidate,
          updatedAt:
            Number.isFinite(candidateUpdatedAt) &&
            (!Number.isFinite(latestUpdatedAt) || candidateUpdatedAt > latestUpdatedAt)
              ? candidate.updatedAt
              : monotonicUpdatedAt,
        });
      } catch (error) {
        if (!(error instanceof WorkspaceApiError) || error.status !== 409) throw error;
        lastConflict = error;
        if (attempt + 1 < maxAttempts) await waitForRevisionRetry(attempt);
      }
    }
    throw lastConflict ?? new WorkspaceApiError(409, '项目正在被其他操作更新，请稍后重试。');
  });
}

export async function listFolders() {
  const result = await requestJson<{ folders?: unknown }>('/api/folders');
  return { folders: Array.isArray(result.folders) ? (result.folders as WorkspaceFolder[]) : [] };
}

export async function createFolder(name: string) {
  return requestJson<{ folder: WorkspaceFolder }>('/api/folders', {
    method: 'POST',
    body: JSON.stringify({ name }),
  });
}

export async function renameFolder(folderId: string, name: string) {
  return requestJson<{ folder: WorkspaceFolder }>(`/api/folders/${folderId}`, {
    method: 'PATCH',
    body: JSON.stringify({ name }),
  });
}

export async function deleteFolder(folderId: string) {
  return requestJson<{ folder: WorkspaceFolder; movedProjectCount: number }>(
    `/api/folders/${folderId}`,
    {
      method: 'DELETE',
    },
  );
}

export async function saveDataUrlAsset(input: {
  projectId: string;
  category: AssetCategory;
  dataUrl: string;
  filename: string;
}) {
  if (isCloudBuild) {
    const blob = await fetch(input.dataUrl).then((response) => response.blob());
    return saveBlobAsset({ ...input, blob });
  }
  return requestJson<{ asset: { category: AssetCategory; relativePath: string; url: string } }>(
    `/api/projects/${input.projectId}/assets`,
    {
      method: 'POST',
      body: JSON.stringify(input),
      timeoutMs: 60_000,
    },
  );
}

export type BlobAssetUploadProgress = {
  loadedBytes: number;
  totalBytes: number;
};

type SaveBlobAssetInput = {
  projectId: string;
  category: AssetCategory;
  blob: Blob;
  filename: string;
  onProgress?: (progress: BlobAssetUploadProgress) => void;
};

type SavedAssetResponse = {
  asset: { category: AssetCategory; relativePath: string; url: string };
};

async function blobSha256(blob: Blob) {
  // Asset hashing is only needed after a user selects a file. Keeping the
  // fallback implementation out of the application shell avoids charging
  // every visitor for the insecure-HTTP compatibility path at startup.
  const { sha256Hex } = await import('@/utils/sha256');
  return sha256Hex(blob);
}

function putDirectAsset(
  intent: AssetUploadIntent,
  blob: Blob,
  onProgress?: (progress: BlobAssetUploadProgress) => void,
) {
  return new Promise<void>((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open(intent.upload.method, intent.upload.url);
    request.timeout = 10 * 60_000;
    Object.entries(intent.upload.headers).forEach(([name, value]) => {
      request.setRequestHeader(name, value);
    });
    request.upload.onloadstart = () => onProgress?.({ loadedBytes: 0, totalBytes: blob.size });
    request.upload.onprogress = (event) => {
      onProgress?.({
        loadedBytes: event.loaded,
        totalBytes: event.lengthComputable && event.total > 0 ? event.total : blob.size,
      });
    };
    request.onload = () => {
      if (request.status < 200 || request.status >= 300) {
        reject(
          new WorkspaceApiError(
            request.status,
            `对象存储直传失败（${request.status}），项目资源尚未保存。`,
          ),
        );
        return;
      }
      onProgress?.({ loadedBytes: blob.size, totalBytes: blob.size });
      resolve();
    };
    request.onerror = () =>
      reject(new WorkspaceApiError(0, '对象存储网络连接失败，项目资源尚未保存。'));
    request.ontimeout = () => reject(new WorkspaceApiError(408, '对象存储直传超时，请稍后重试。'));
    request.send(blob);
  });
}

async function saveDirectBlobAsset(input: SaveBlobAssetInput) {
  if (!input.blob.size) throw new WorkspaceApiError(400, '不能上传空资源。');
  input.onProgress?.({ loadedBytes: 0, totalBytes: input.blob.size });
  const sha256 = await blobSha256(input.blob);
  const { intent } = await requestJson<{ intent: AssetUploadIntent }>(
    `/api/projects/${input.projectId}/assets/intents`,
    {
      method: 'POST',
      body: JSON.stringify({
        protocolVersion: ASSET_TRANSFER_PROTOCOL_VERSION,
        category: input.category,
        filename: input.filename,
        mimeType: input.blob.type || 'application/octet-stream',
        sizeBytes: input.blob.size,
        sha256,
      }),
      timeoutMs: 10_000,
    },
  );
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      await putDirectAsset(intent, input.blob, input.onProgress);
      break;
    } catch (error) {
      const retryable =
        error instanceof WorkspaceApiError &&
        (error.status === 0 || error.status === 408 || error.status === 429 || error.status >= 500);
      if (!retryable || attempt === 2) throw error;
      await new Promise((resolve) => window.setTimeout(resolve, 250));
    }
  }
  return requestJson<SavedAssetResponse & { replayed: boolean }>(
    `/api/projects/${input.projectId}/assets/intents/${intent.intentId}/complete`,
    {
      method: 'POST',
      body: JSON.stringify({
        protocolVersion: ASSET_TRANSFER_PROTOCOL_VERSION,
        assetId: intent.assetId,
        sha256,
      }),
      timeoutMs: 15_000,
    },
  );
}

function saveBlobAssetWithProgress(input: SaveBlobAssetInput) {
  return new Promise<SavedAssetResponse>((resolve, reject) => {
    const params = new URLSearchParams({
      format: 'blob',
      category: input.category,
      filename: input.filename,
    });
    const request = new XMLHttpRequest();
    request.open(
      'POST',
      `${workspaceApiBase}/api/projects/${input.projectId}/assets?${params.toString()}`,
    );
    request.withCredentials = true;
    request.timeout = 60_000;
    request.setRequestHeader('content-type', input.blob.type || 'application/octet-stream');
    request.upload.onprogress = (event) => {
      input.onProgress?.({
        loadedBytes: event.loaded,
        totalBytes: event.lengthComputable && event.total > 0 ? event.total : input.blob.size,
      });
    };
    request.upload.onloadstart = () => {
      input.onProgress?.({ loadedBytes: 0, totalBytes: input.blob.size });
    };
    request.onload = () => {
      let payload: unknown;
      try {
        payload = request.responseText ? JSON.parse(request.responseText) : undefined;
      } catch {
        payload = undefined;
      }
      if (request.status < 200 || request.status >= 300) {
        const message =
          payload &&
          typeof payload === 'object' &&
          'error' in payload &&
          typeof payload.error === 'string'
            ? payload.error
            : `Workspace request failed: ${request.status}`;
        reject(new WorkspaceApiError(request.status, message));
        return;
      }
      input.onProgress?.({ loadedBytes: input.blob.size, totalBytes: input.blob.size });
      resolve(payload as SavedAssetResponse);
    };
    request.onerror = () => {
      reject(
        new WorkspaceApiError(
          0,
          isCloudBuild
            ? '无法连接云端项目服务，项目资源尚未上传。'
            : '无法连接本地工作区服务，项目资源尚未上传。',
        ),
      );
    };
    request.ontimeout = () => {
      reject(new WorkspaceApiError(408, '项目资源上传超时，请稍后重试。'));
    };
    request.send(input.blob);
  });
}

export async function saveBlobAsset(input: SaveBlobAssetInput) {
  // The integrated 4517 workspace deliberately has no object-storage service.
  // Going through the cloud upload-intent endpoint first produces a guaranteed
  // 503 for every image plane. Multi-view projection amplifies that into
  // hundreds of failed requests before falling back, delaying or preventing
  // result persistence. Stream directly to the authenticated local workspace.
  if (isIntegratedLoopbackWorkspace()) return saveBlobAssetWithProgress(input);
  if (isCloudBuild && globalThis.crypto?.subtle) {
    try {
      return await saveDirectBlobAsset(input);
    } catch (error) {
      // The integrated local workspace intentionally has no external object-storage
      // component. When the 4517 backend reports that cloud storage is absent,
      // stream the same blob into its authenticated workspace route instead.
      // A100 keeps using the direct object-storage path because its intent request
      // succeeds and never reaches this fallback.
      if (!(error instanceof WorkspaceApiError) || error.status !== 503) throw error;
      return saveBlobAssetWithProgress(input);
    }
  }
  // Web Crypto is disabled by browsers on plain HTTP non-loopback origins.
  // Keep the zero-install test deployment functional by streaming through the
  // authenticated cloud server; the server hashes the bytes and still stores
  // the verified object in the configured S3/MinIO bucket.
  if (input.onProgress) return saveBlobAssetWithProgress(input);
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 60_000);
  const params = new URLSearchParams({
    format: 'blob',
    category: input.category,
    filename: input.filename,
  });
  let response: Response;
  try {
    response = await fetch(
      `${workspaceApiBase}/api/projects/${input.projectId}/assets?${params.toString()}`,
      {
        method: 'POST',
        body: input.blob,
        headers: {
          'content-type': input.blob.type || 'application/octet-stream',
        },
        signal: controller.signal,
        credentials: 'include',
      },
    );
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new WorkspaceApiError(408, '项目资源上传超时，请稍后重试。');
    }
    throw new WorkspaceApiError(0, '无法连接云端项目服务，项目资源尚未上传。');
  } finally {
    window.clearTimeout(timeout);
  }
  if (!response.ok) {
    const payload = await response.json().catch(() => undefined);
    const message =
      payload &&
      typeof payload === 'object' &&
      'error' in payload &&
      typeof payload.error === 'string'
        ? payload.error
        : `Workspace request failed: ${response.status}`;
    throw new WorkspaceApiError(response.status, message);
  }
  return response.json() as Promise<SavedAssetResponse>;
}

export async function saveRemoteUrlAsset(input: {
  projectId: string;
  category: AssetCategory;
  url: string;
  filename: string;
}) {
  return requestJson<{ asset: { category: AssetCategory; relativePath: string; url: string } }>(
    `/api/projects/${input.projectId}/assets`,
    {
      method: 'POST',
      body: JSON.stringify(input),
      timeoutMs: 45_000,
    },
  );
}

export async function exportProjectPackage(projectId: string) {
  return requestJson<{ status: 'coming-soon'; filename: string; message: string }>(
    `/api/projects/${projectId}/export/package`,
    { method: 'POST', body: JSON.stringify({}) },
  );
}

export async function fileToDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('Could not read file.'));
    reader.readAsDataURL(file);
  });
}

export function isTrustedGenerationWorkspaceAssetUrl(url?: string) {
  if (!url) return false;
  const workspacePath = workspacePathAtBase(url, generationWorkspaceApiBase);
  return Boolean(workspacePath && trustedGenerationWorkspacePath.test(workspacePath));
}

export async function urlToBlob(url: string) {
  const trustedGenerationAsset = isTrustedGenerationWorkspaceAssetUrl(url);
  const response = await fetch(url, {
    credentials: trustedGenerationAsset ? 'include' : 'same-origin',
    redirect: trustedGenerationAsset ? 'error' : 'follow',
  });
  if (!response.ok) throw new Error(`无法读取资源（${response.status}），请稍后重试。`);
  const blob = await response.blob();
  if (trustedGenerationAsset) {
    const contentType = (response.headers.get('content-type') || blob.type).toLowerCase();
    if (!contentType.startsWith('image/')) {
      throw new Error('局部重绘结果不是有效图片。');
    }
    if (!blob.size || blob.size > maxWorkspaceImageBytes) {
      throw new Error('局部重绘结果为空或文件过大。');
    }
  }
  return blob;
}

export async function urlToDataUrl(url: string) {
  if (url.startsWith('data:')) return url;
  const blob = await urlToBlob(url);
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('Could not read asset URL.'));
    reader.readAsDataURL(blob);
  });
}

export function isWorkspaceAssetUrl(url?: string) {
  return Boolean(
    url &&
    (workspacePathAtBase(url, workspaceApiBase) ||
      directAssetPathAtBase(url, workspaceApiBase) ||
      // The integrated local control plane stores canonical project assets as
      // project-relative paths in project.liclick.json. Treating these durable
      // paths as fresh imports re-uploaded every image/depth plane on every
      // autosave (and kept the critical button-2 save queued behind that work).
      // Cloud keeps its existing migration path and never accepts this shortcut.
      (!isCloudBuild && /^assets\/(?:models|references|captures|generations|layers|baked)\/[^?#]+$/i.test(url))),
  );
}

/** Legacy project files stored bytes below /workspace; cloud projects must
 * migrate those bytes to object storage before considering them durable. */
export function isLegacyWorkspaceAssetUrl(url?: string) {
  return Boolean(url && workspacePathAtBase(url, workspaceApiBase));
}

/** A durable /workspace asset already owned by the integrated loopback server. */
export function isIntegratedLoopbackWorkspaceAssetUrl(url?: string) {
  return Boolean(url && isIntegratedLoopbackWorkspace() && isLegacyWorkspaceAssetUrl(url));
}

/**
 * Reads a durable project asset without forwarding the Li3D session cookie to
 * cloud object storage. Cloud URLs are resolved through an authenticated,
 * same-origin request and the short-lived signed URL is fetched credentialless.
 */
export async function readWorkspaceAssetBlob(url: string) {
  const directAssetPath = directAssetPathAtBase(url, workspaceApiBase);
  if (isCloudBuild && directAssetPath) {
    const separator = directAssetPath.includes('?') ? '&' : '?';
    const resolution = await fetch(`${workspaceApiBase}${directAssetPath}${separator}resolve=1`, {
      credentials: 'include',
      redirect: 'error',
    });
    if (!resolution.ok) {
      throw new WorkspaceApiError(resolution.status, `无法解析云端资源（${resolution.status}）。`);
    }
    const payload = (await resolution.json()) as { downloadUrl?: unknown };
    if (typeof payload.downloadUrl !== 'string') {
      throw new WorkspaceApiError(502, '云端资源缺少签名下载地址。');
    }
    const signedUrl = new URL(payload.downloadUrl);
    if (signedUrl.protocol !== 'https:' && signedUrl.protocol !== 'http:') {
      throw new WorkspaceApiError(502, '云端资源签名下载协议无效。');
    }
    const response = await fetch(signedUrl, { credentials: 'omit', redirect: 'follow' });
    if (!response.ok) {
      throw new WorkspaceApiError(response.status, `无法读取云端资源（${response.status}）。`);
    }
    return response.blob();
  }
  const response = await fetch(url, {
    credentials: directAssetPath ? 'include' : 'same-origin',
  });
  if (!response.ok)
    throw new WorkspaceApiError(response.status, `无法读取资源（${response.status}）。`);
  return response.blob();
}
