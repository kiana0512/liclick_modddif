import type { Project } from '@/types/project';
import { getLocalTextureRuntimeApiBase } from './localTextureRuntimeClient';
import { getWorkspaceApiBase } from './workspaceApiBase';

const workspaceApiBase = getLocalTextureRuntimeApiBase();
const generationWorkspaceApiBase = getWorkspaceApiBase(
  import.meta.env.VITE_LICLICK_WORKSPACE_API,
);
const maxWorkspaceImageBytes = 160 * 1024 * 1024;

function workspacePathAtBase(url: string, base: string) {
  try {
    const baseUrl = new URL(base);
    const basePath = baseUrl.pathname.replace(/\/$/, '');
    const candidate = new URL(url, `${baseUrl.origin}${basePath || '/'}`);
    if (candidate.origin !== baseUrl.origin) return undefined;
    const workspacePrefix = `${basePath}/workspace/`;
    if (!candidate.pathname.startsWith(workspacePrefix)) return undefined;
    return candidate.pathname.slice(basePath.length);
  } catch {
    return undefined;
  }
}

const trustedGenerationWorkspacePath =
  /^\/workspace\/(?:(?:(?:users\/[^/]+\/projects\/[^/]+|projects\/[^/]+)\/(?:assets|thumbnails|exports))\/.+|users\/[^/]+\/recoveries\/modelview-inpaint\/[^/]+)$/i;

export class WorkspaceApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'WorkspaceApiError';
    this.status = status;
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
};

export type AssetCategory = 'models' | 'references' | 'captures' | 'generations' | 'layers' | 'baked';

async function requestJson<T>(path: string, init?: RequestInit & { timeoutMs?: number }): Promise<T> {
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
      payload && typeof payload === 'object' && 'error' in payload && typeof payload.error === 'string'
        ? payload.error
        : `Workspace request failed: ${response.status}`;
    throw new WorkspaceApiError(response.status, message);
  }
  return response.json() as Promise<T>;
}

export async function getWorkspaceHealth() {
  return requestJson<{ ok: boolean; workspaceDir: string; workspaceVersion: string }>('/api/health', {
    timeoutMs: 900,
  });
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
  return requestJson<{ project: Project; slug: string }>(`/api/projects/${projectId}`);
}

export async function renameProject(projectId: string, name: string) {
  return requestJson<{ project: Project; slug: string }>(`/api/projects/${projectId}`, {
    method: 'PATCH',
    body: JSON.stringify({ name }),
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

export async function moveProject(projectId: string, folderId: string | null) {
  return requestJson<{ project: Project; slug: string }>(`/api/projects/${projectId}/move`, {
    method: 'POST',
    body: JSON.stringify({ folderId }),
  });
}

export async function saveProject(project: Project) {
  return requestJson<{ project: Project; slug: string }>(`/api/projects/${project.id}`, {
    method: 'PUT',
    body: JSON.stringify({ ...project, workspaceVersion: project.workspaceVersion ?? '0.6.0' }),
    timeoutMs: 30_000,
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
  return requestJson<{ folder: WorkspaceFolder; movedProjectCount: number }>(`/api/folders/${folderId}`, {
    method: 'DELETE',
  });
}

export async function saveDataUrlAsset(input: {
  projectId: string;
  category: AssetCategory;
  dataUrl: string;
  filename: string;
}) {
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
          '无法连接本地工作区服务，项目资源尚未上传。',
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
    response = await fetch(`${workspaceApiBase}/api/projects/${input.projectId}/assets?${params.toString()}`, {
      method: 'POST',
      body: input.blob,
      headers: {
        'content-type': input.blob.type || 'application/octet-stream',
      },
      signal: controller.signal,
      credentials: 'include',
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new WorkspaceApiError(408, '项目资源上传超时，请稍后重试。');
    }
    throw new WorkspaceApiError(0, '无法连接本地工作区服务，项目资源尚未上传。');
  } finally {
    window.clearTimeout(timeout);
  }
  if (!response.ok) {
    const payload = await response.json().catch(() => undefined);
    const message =
      payload && typeof payload === 'object' && 'error' in payload && typeof payload.error === 'string'
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
  return Boolean(url && workspacePathAtBase(url, workspaceApiBase));
}
