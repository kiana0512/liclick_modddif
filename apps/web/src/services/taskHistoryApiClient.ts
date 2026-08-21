import { getWorkspaceApiBase } from './workspaceApiBase';
import type {
  Project,
  ProjectPipelineRevision,
  ProjectPipelineSettingValue,
} from '@/types/project';

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

function settingText(value: ProjectPipelineSettingValue | undefined) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

function localPipelineStatus(revision: ProjectPipelineRevision) {
  if (revision.status === 'ready') return 'succeeded';
  return revision.status;
}

/**
 * Browser-local compute still belongs to the signed-in account: its durable
 * history is read from that account's project pipeline, never from localStorage.
 */
export function getProjectPipelineTaskHistory(
  project: Project | undefined,
  module: TaskHistoryModule,
): TaskHistoryRecord[] {
  if (!project?.pipeline) return [];
  const stage = module === 'uv' ? 'uv' : module === 'bake' ? 'bake' : 'retopology';

  return project.pipeline.revisions
    .filter((revision) => revision.stage === stage && revision.sourceMode === 'browser-local')
    .map((revision) => {
      const settings = revision.settings;
      const parameterEntries: Array<[string, string | undefined]> = [
        ['输出尺寸', settingText(settings.resolution)],
        ['边距', settingText(settings.padding)],
        ['网格', settingText(settings.meshCount)],
        ['三角面', settingText(settings.triangleCount)],
        ['UV 岛', settingText(settings.chartCount)],
        [
          '利用率',
          typeof settings.utilization === 'number'
            ? `${(settings.utilization * 100).toFixed(1)}%`
            : settingText(settings.utilization),
        ],
      ];
      const sourceName =
        revision.inputAssets[0]?.name ?? revision.outputAssets[0]?.name ?? '未命名模型';
      return {
        id: `pipeline:${revision.id}`,
        module,
        sourceName,
        status: localPipelineStatus(revision),
        progress: revision.status === 'ready' ? 100 : 0,
        createdAt: revision.createdAt,
        finishedAt: revision.completedAt,
        parameters: parameterEntries
          .filter((entry): entry is [string, string] => Boolean(entry[1]))
          .map(([label, value]) => ({ label, value })),
        outputs: revision.outputAssets.map((asset) => ({
          id: asset.id,
          label: module === 'uv' ? 'UV 模型' : '输出模型',
          filename: asset.name,
          sizeBytes: asset.sizeBytes ?? 0,
          downloadUrl: asset.url,
        })),
      } satisfies TaskHistoryRecord;
    })
    .sort(
      (a, b) =>
        Date.parse(b.finishedAt ?? b.createdAt) - Date.parse(a.finishedAt ?? a.createdAt),
    );
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
