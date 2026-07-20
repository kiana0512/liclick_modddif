import { getWorkspaceApiBase } from './workspaceApiBase';
import { slugifyExportName } from '@/engine/export/exportUtils';

const workspaceApiBase = getWorkspaceApiBase(import.meta.env.VITE_LICLICK_WORKSPACE_API);

export type BakeChannelId = 'baseColor' | 'ambientOcclusion' | 'normal';

export type NormalBakeSettings = {
  resolution: 1024 | 2048 | 4096 | 8192;
  padding: number;
  sampling: '1x1' | '2x2' | '4x4' | '8x8';
  normalOrientation: 'directx' | 'opengl';
  device: 'gpu' | 'cpu';
  udim: number;
  frontalDistance: number;
  rearDistance: number;
  matchMode: 'always' | 'by-name';
  projectionMode: 'distance' | 'cage';
  hitStrategy: 'inward' | 'closest-from-source';
  ignoreBackfaces: boolean;
  channels: BakeChannelId[];
};

export type NormalBakeJob = {
  id: string;
  kind: 'bake-maps';
  projectId: string;
  objectId: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  stage: 'waiting-for-worker' | 'baking-maps' | 'verifying-file' | 'finished';
  progress: number;
  settings: NormalBakeSettings;
  input: { high: string; low: string; cage?: string; color?: string };
  output?: { fileName: string; width: number; height: number; url: string };
  outputs?: Partial<Record<BakeChannelId, { fileName: string; width: number; height: number; url: string }>>;
  error?: string;
  logs: string[];
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
};

async function responseJson<T>(response: Response) {
  const payload = await response.json().catch(() => undefined);
  if (!response.ok) {
    const message = payload && typeof payload === 'object' && 'error' in payload && typeof payload.error === 'string'
      ? payload.error
      : `Bake service request failed: ${response.status}`;
    throw new Error(message);
  }
  return payload as T;
}

export async function submitNormalBake(input: {
  projectId: string;
  objectId: string;
  high: File;
  low: File;
  cage?: File;
  color?: File;
  settings: NormalBakeSettings;
}) {
  const body = new FormData();
  body.set('projectId', input.projectId);
  body.set('objectId', input.objectId);
  body.set('settings', JSON.stringify(input.settings));
  body.set('high', input.high);
  body.set('low', input.low);
  if (input.cage) body.set('cage', input.cage);
  if (input.color) body.set('color', input.color);
  const response = await fetch(`${workspaceApiBase}/api/bake/jobs`, {
    method: 'POST',
    body,
    credentials: 'include',
  });
  return (await responseJson<{ job: NormalBakeJob }>(response)).job;
}

export async function getNormalBakeJob(jobId: string) {
  const response = await fetch(`${workspaceApiBase}/api/bake/jobs/${encodeURIComponent(jobId)}`, {
    credentials: 'include',
    cache: 'no-store',
  });
  return (await responseJson<{ job: NormalBakeJob }>(response)).job;
}

export function normalBakeOutputUrl(job: NormalBakeJob) {
  return bakeOutputUrl(job, 'normal');
}

export function bakeOutputUrl(job: NormalBakeJob, channel: BakeChannelId) {
  const output = job.outputs?.[channel] ?? (channel === 'normal' ? job.output : undefined);
  return output ? `${workspaceApiBase}${output.url}` : undefined;
}

export function downloadBakeOutput(job: NormalBakeJob, channel: BakeChannelId, filenameBase: string) {
  const url = bakeOutputUrl(job, channel);
  if (!url) throw new Error(`${channel} output is not available.`);
  const anchor = document.createElement('a');
  anchor.href = `${url}?download=1`;
  anchor.download = `${slugifyExportName(filenameBase)}.png`;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}
