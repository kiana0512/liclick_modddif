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

async function responseJson<T>(response: Response) {
  const payload = await response.json().catch(() => undefined);
  if (!response.ok) {
    const message =
      payload &&
      typeof payload === 'object' &&
      'error' in payload &&
      typeof payload.error === 'string'
        ? payload.error
        : `历史记录请求失败（${response.status}）。`;
    throw new Error(message);
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
    const payload = (await response.json().catch(() => undefined)) as
      | { error?: string }
      | undefined;
    throw new Error(payload?.error ?? `历史文件下载失败（${response.status}）。`);
  }
  return response.blob();
}

export async function downloadTaskHistoryOutput(output: TaskHistoryOutput) {
  triggerBlobDownload(await fetchTaskHistoryOutputBlob(output), output.filename);
}
