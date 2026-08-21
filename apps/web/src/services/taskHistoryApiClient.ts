import { getWorkspaceApiBase } from './workspaceApiBase';

const workspaceApiBase = getWorkspaceApiBase(import.meta.env.VITE_LICLICK_WORKSPACE_API);

export type TaskHistoryModule = 'bake' | 'uv' | 'retopology';

export type TaskHistoryParameter = {
  label: string;
  value: string;
};

export type TaskHistoryOutput = {
  id: string;
  label: string;
  filename: string;
  sizeBytes: number;
  downloadUrl?: string;
};

export type TaskHistoryRecord = {
  id: string;
  module: TaskHistoryModule;
  sourceName: string;
  status: string;
  progress: number;
  createdAt: string;
  finishedAt?: string;
  parameters: TaskHistoryParameter[];
  outputs: TaskHistoryOutput[];
  error?: string;
};

type TaskHistoryResponse = {
  records: TaskHistoryRecord[];
};

function historyErrorMessage(payload: unknown, fallback: string) {
  if (!payload || typeof payload !== 'object' || !('error' in payload)) return fallback;
  const error = payload.error;
  if (typeof error === 'string' && error.trim()) return error;
  if (!error || typeof error !== 'object') return fallback;
  const errorRecord = error as Record<string, unknown>;
  for (const key of ['summary', 'message', 'code'] as const) {
    const value = errorRecord[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return fallback;
}

async function responseJson<T>(response: Response) {
  const payload = await response.json().catch(() => undefined);
  if (!response.ok) {
    throw new Error(historyErrorMessage(payload, `历史记录请求失败（${response.status}）。`));
  }
  return payload as T;
}

export async function getTaskHistory(module: TaskHistoryModule, limit = 30) {
  const query = new URLSearchParams({
    module,
    limit: String(Math.min(100, Math.max(1, Math.round(limit)))),
  });
  const response = await fetch(`${workspaceApiBase}/api/history?${query}`, {
    credentials: 'include',
    cache: 'no-store',
  });
  const payload = await responseJson<TaskHistoryResponse>(response);
  return Array.isArray(payload.records) ? payload.records : [];
}

function resolvedDownloadUrl(downloadUrl: string) {
  try {
    return new URL(downloadUrl, `${workspaceApiBase}/`).href;
  } catch {
    return downloadUrl;
  }
}

function triggerBlobDownload(blob: Blob, filename: string) {
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = filename;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
}

export async function fetchTaskHistoryOutputBlob(output: TaskHistoryOutput) {
  if (!output.downloadUrl) throw new Error('此历史文件当前不可下载。');
  const response = await fetch(resolvedDownloadUrl(output.downloadUrl), {
    credentials: 'include',
    cache: 'no-store',
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => undefined);
    throw new Error(historyErrorMessage(payload, `历史文件下载失败（${response.status}）。`));
  }
  return response.blob();
}

export async function downloadTaskHistoryOutput(output: TaskHistoryOutput) {
  triggerBlobDownload(await fetchTaskHistoryOutputBlob(output), output.filename);
}
