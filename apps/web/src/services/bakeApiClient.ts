import { getWorkspaceApiBase } from './workspaceApiBase';
import { slugifyExportName } from '@/engine/export/exportUtils';

const workspaceApiBase = getWorkspaceApiBase(import.meta.env.VITE_LICLICK_WORKSPACE_API);

export type BakeChannelId =
  | 'baseColor'
  | 'normal'
  | 'ambientOcclusion'
  | 'curvature'
  | 'worldNormal'
  | 'thickness'
  | 'position'
  | 'roughness'
  | 'metallic';

export type NormalBakeSettings = {
  resolution: 1024 | 2048 | 4096;
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
  generateRoughnessFromBakedBaseColor?: boolean;
  channels: BakeChannelId[];
};

export type NormalBakeJob = {
  id: string;
  ownerUserId: string;
  kind: 'bake-maps';
  projectId: string;
  objectId: string;
  status: 'queued' | 'running' | 'cancelling' | 'succeeded' | 'failed' | 'cancelled';
  stage: 'waiting-for-worker' | 'baking-maps' | 'verifying-file' | 'finished';
  progress: number;
  settings: NormalBakeSettings;
  input: {
    high: string;
    low: string;
    cage?: string;
    color?: string;
    normalMap?: string;
    roughness?: string;
    metallic?: string;
  };
  output?: { fileName: string; width: number; height: number; url: string };
  outputs?: Partial<
    Record<BakeChannelId, { fileName: string; width: number; height: number; url: string }>
  >;
  remote?: {
    jobId: string;
    profile: 'ao-self-v1' | 'normal-dx-v1' | 'pbr-core-v1' | 'li3d-pbr-full-v2';
    statusUrl: string;
    eventsUrl?: string;
    cancelUrl?: string;
    status?:
      | 'QUEUED'
      | 'CLAIMED'
      | 'RUNNING'
      | 'CANCELLING'
      | 'SUCCEEDED'
      | 'FAILED'
      | 'CANCELLED'
      | (string & {});
    workerId?: string;
    stage?: string;
    stageMessage?: string;
    deliveryReady?: boolean;
    timing?: {
      queue_position?: number;
      estimated_start_seconds?: number;
      elapsed_seconds?: number;
      estimated_remaining_seconds?: number;
    };
  };
  error?: string;
  logs: string[];
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
};

export type SubstanceBakerStatus = {
  available: boolean;
  connected: boolean;
  endpoint: string;
  workerId?: string;
  tlsVerified: boolean;
  trustSource?:
    | 'configured-ca'
    | 'auto-discovered-ca'
    | 'embedded-ca'
    | 'system-ca'
    | 'node-default-ca';
  caPath?: string;
  error?: string;
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
        : `Bake service request failed: ${response.status}`;
    throw new Error(message);
  }
  return payload as T;
}

export async function getSubstanceBakerStatus() {
  const response = await fetch(`${workspaceApiBase}/api/bake/status`, {
    credentials: 'include',
    cache: 'no-store',
  });
  return responseJson<SubstanceBakerStatus>(response);
}

export async function generateRoughnessMap(image: File) {
  const body = new FormData();
  body.set('image', image);
  const response = await fetch(`${workspaceApiBase}/api/bake/roughness`, {
    method: 'POST',
    body,
    credentials: 'include',
    headers: { 'idempotency-key': `roughness_${crypto.randomUUID()}` },
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => undefined)) as
      | { error?: string }
      | undefined;
    throw new Error(payload?.error ?? `Roughness generation failed: ${response.status}`);
  }
  const blob = await response.blob();
  const extension =
    blob.type === 'image/jpeg' ? 'jpg' : blob.type === 'image/webp' ? 'webp' : 'png';
  return {
    file: new File([blob], `roughness-${Date.now()}.${extension}`, {
      type: blob.type || 'image/png',
    }),
    jobId: response.headers.get('x-job-id') ?? undefined,
  };
}

export async function submitNormalBake(input: {
  projectId: string;
  objectId: string;
  high: File;
  low: File;
  cage?: File;
  color?: File;
  normalMap?: File;
  roughness?: File;
  metallic?: File;
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
  if (input.normalMap) body.set('normalMap', input.normalMap);
  if (input.roughness) body.set('roughness', input.roughness);
  if (input.metallic) body.set('metallic', input.metallic);
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

export async function cancelNormalBake(jobId: string) {
  const response = await fetch(
    `${workspaceApiBase}/api/bake/jobs/${encodeURIComponent(jobId)}/cancel`,
    {
      method: 'POST',
      credentials: 'include',
    },
  );
  return (await responseJson<{ job: NormalBakeJob }>(response)).job;
}

export function normalBakeOutputUrl(job: NormalBakeJob) {
  return bakeOutputUrl(job, 'normal');
}

export function bakeOutputUrl(job: NormalBakeJob, channel: BakeChannelId) {
  const output = job.outputs?.[channel] ?? (channel === 'normal' ? job.output : undefined);
  return output ? `${workspaceApiBase}${output.url}` : undefined;
}

export function downloadBakeOutput(
  job: NormalBakeJob,
  channel: BakeChannelId,
  filenameBase: string,
) {
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

export async function downloadAllBakeOutputs(job: NormalBakeJob, filenameBase: string) {
  const channels = job.settings.channels.filter((channel) => bakeOutputUrl(job, channel));
  if (channels.length === 0) throw new Error('没有可导出的烘焙贴图。');
  const base = slugifyExportName(filenameBase);
  const archiveUrl = `${workspaceApiBase}/api/bake/jobs/${encodeURIComponent(job.id)}/archive?name=${encodeURIComponent(base)}`;
  const probe = await fetch(archiveUrl, {
    method: 'HEAD',
    credentials: 'include',
    cache: 'no-store',
  });
  if (!probe.ok) throw new Error(`全部贴图打包失败（${probe.status}）。`);
  const anchor = document.createElement('a');
  anchor.href = archiveUrl;
  anchor.download = `${base}_BakedMaps.zip`;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}
