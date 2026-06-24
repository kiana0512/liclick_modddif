import type { Project } from '@/types/project';
import { getWorkspaceApiBase } from './workspaceApiBase';

const workspaceApiBase = getWorkspaceApiBase(import.meta.env.VITE_LICLICK_WORKSPACE_API);

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
  const response = await fetch(`${workspaceApiBase}${path}`, {
    ...fetchInit,
    signal: controller.signal,
    headers: requestHeaders,
    credentials: 'include',
  }).finally(() => window.clearTimeout(timeout));
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
    },
  );
}

export async function saveBlobAsset(input: {
  projectId: string;
  category: AssetCategory;
  blob: Blob;
  filename: string;
}) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 60_000);
  const params = new URLSearchParams({
    format: 'blob',
    category: input.category,
    filename: input.filename,
  });
  const response = await fetch(`${workspaceApiBase}/api/projects/${input.projectId}/assets?${params.toString()}`, {
    method: 'POST',
    body: input.blob,
    headers: {
      'content-type': input.blob.type || 'application/octet-stream',
    },
    signal: controller.signal,
    credentials: 'include',
  }).finally(() => window.clearTimeout(timeout));
  if (!response.ok) {
    const payload = await response.json().catch(() => undefined);
    const message =
      payload && typeof payload === 'object' && 'error' in payload && typeof payload.error === 'string'
        ? payload.error
        : `Workspace request failed: ${response.status}`;
    throw new WorkspaceApiError(response.status, message);
  }
  return response.json() as Promise<{ asset: { category: AssetCategory; relativePath: string; url: string } }>;
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

export async function urlToDataUrl(url: string) {
  if (url.startsWith('data:')) return url;
  const response = await fetch(url);
  const blob = await response.blob();
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('Could not read asset URL.'));
    reader.readAsDataURL(blob);
  });
}

export function isWorkspaceAssetUrl(url?: string) {
  return Boolean(url && (url.startsWith(workspaceApiBase) || url.includes('/workspace/')));
}
