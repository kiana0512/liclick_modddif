import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { requireAuth } from '../auth/authMiddleware.js';
import {
  listAssetJobHistory,
  updateAssetJobSnapshot,
  type AssetHistoryMode,
  type AssetJobHistoryRecord,
} from '../services/assetJobOwnership.js';
import { fetchAssetJobSnapshot } from '../services/assetProcessingProxy.js';
import {
  getNormalBakeOutputPath,
  listNormalBakeJobs,
  type BakeChannelId,
  type NormalBakeJob,
} from '../services/substanceBakeService.js';
import { sendJson } from './httpUtils.js';

type HistoryModule = 'bake' | AssetHistoryMode;

type HistoryParameter = { label: string; value: string };
type HistoryOutput = {
  id: string;
  label: string;
  filename: string;
  sizeBytes: number;
  downloadUrl?: string;
};

type HistoryRecord = {
  id: string;
  module: HistoryModule;
  sourceName: string;
  status: string;
  progress: number;
  createdAt: string;
  finishedAt?: string;
  parameters: HistoryParameter[];
  outputs: HistoryOutput[];
  error?: string;
};

const bakeChannelLabels: Record<BakeChannelId, string> = {
  baseColor: 'Base Color',
  normal: 'Normal',
  ambientOcclusion: 'AO',
  curvature: 'Curvature',
  worldNormal: 'World Normal',
  thickness: 'Thickness',
  position: 'Position',
  roughness: 'Roughness',
  metallic: 'Metallic',
};

function cleanText(value: unknown, maximumLength = 1_000) {
  if (typeof value !== 'string') return undefined;
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, maximumLength);
  return clean || undefined;
}

function archiveBase(value: string) {
  return path.basename(value)
    .replace(/\.[^.]+$/, '')
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 72) || 'bake';
}

function bakeParameters(job: NormalBakeJob): HistoryParameter[] {
  const settings = job.settings;
  return [
    { label: '输出尺寸', value: `${settings.resolution / 1024}K (${settings.resolution}px)` },
    { label: '输出贴图', value: settings.channels.map((channel) => bakeChannelLabels[channel]).join('、') },
    { label: '法线方向', value: settings.normalOrientation === 'directx' ? 'DirectX (Y-)' : 'OpenGL (Y+)' },
    { label: '采样', value: settings.sampling },
    { label: '边距', value: `${settings.padding}px` },
    { label: '投射模式', value: settings.projectionMode === 'cage' ? 'Cage' : '距离' },
    { label: '正/反距离', value: `${settings.frontalDistance} / ${settings.rearDistance}` },
    { label: '匹配模式', value: settings.matchMode === 'by-name' ? '按名称' : '始终匹配' },
    { label: '运算设备', value: settings.device.toUpperCase() },
    { label: 'UDIM', value: String(settings.udim) },
  ];
}

function bakeOutputs(job: NormalBakeJob, userId: string): HistoryOutput[] {
  const outputs: HistoryOutput[] = [];
  let totalBytes = 0;
  for (const channel of job.settings.channels) {
    const output = job.outputs?.[channel] ?? (channel === 'normal' ? job.output : undefined);
    const outputPath = getNormalBakeOutputPath(job.id, userId, channel);
    if (!output || !outputPath) continue;
    let sizeBytes = 0;
    try {
      sizeBytes = fs.statSync(outputPath).size;
    } catch {
      continue;
    }
    totalBytes += sizeBytes;
    outputs.push({
      id: channel,
      label: bakeChannelLabels[channel],
      filename: path.basename(output.fileName),
      sizeBytes,
      downloadUrl: `/api/bake/jobs/${encodeURIComponent(job.id)}/output/${channel}?download=1`,
    });
  }
  if (outputs.length > 0) {
    const base = archiveBase(job.input.high);
    outputs.unshift({
      id: 'archive',
      label: '全部烘焙贴图 (ZIP)',
      filename: `${base}_BakedMaps.zip`,
      sizeBytes: totalBytes,
      downloadUrl: `/api/bake/jobs/${encodeURIComponent(job.id)}/archive?name=${encodeURIComponent(base)}`,
    });
  }
  return outputs;
}

function bakeHistoryRecord(job: NormalBakeJob, userId: string): HistoryRecord {
  return {
    id: job.id,
    module: 'bake',
    sourceName: path.basename(job.input.high || '未命名模型'),
    status: job.status,
    progress: Math.min(100, Math.max(0, Number(job.progress) || 0)),
    createdAt: job.createdAt,
    ...(job.finishedAt ? { finishedAt: job.finishedAt } : {}),
    parameters: bakeParameters(job),
    outputs: bakeOutputs(job, userId),
    ...(cleanText(job.error) ? { error: cleanText(job.error) } : {}),
  };
}

function normalizedAssetStatus(status?: string) {
  switch (status?.toUpperCase()) {
    case 'SUCCEEDED': return 'succeeded';
    case 'FAILED': return 'failed';
    case 'CANCELLED': return 'cancelled';
    case 'QUEUED': return 'queued';
    default: return status ? 'running' : 'queued';
  }
}

function assetHistoryRecord(
  module: AssetHistoryMode,
  record: AssetJobHistoryRecord & { jobId: string },
): HistoryRecord {
  return {
    id: record.jobId,
    module,
    sourceName: cleanText(record.sourceName, 180) ?? (module === 'uv' ? '历史展 UV 任务' : '历史拓扑任务'),
    status: normalizedAssetStatus(record.status),
    progress: Math.min(100, Math.max(0, Number(record.progress) || 0)),
    createdAt: record.createdAt,
    ...(record.finishedAt ? { finishedAt: record.finishedAt } : {}),
    parameters: record.parameters ?? [],
    outputs: (record.artifacts ?? []).map((artifact) => ({
      id: artifact.id,
      label: artifact.label,
      filename: artifact.filename,
      sizeBytes: artifact.sizeBytes,
      downloadUrl:
        `/api/asset-processing/jobs/${encodeURIComponent(record.jobId)}` +
        `/artifacts/${encodeURIComponent(artifact.id)}`,
    })),
    ...(cleanText(record.error) ? { error: cleanText(record.error) } : {}),
  };
}

async function refreshedAssetHistory(
  userId: string,
  module: AssetHistoryMode,
  limit: number,
) {
  // Include old ownership-only rows in the refresh candidates. A trustworthy
  // remote `kind` may recover their module; if the remote record is gone they
  // remain unclassified and invisible rather than being guessed.
  const initial = (await listAssetJobHistory(userId, undefined, 100))
    .filter((record) => !record.mode || record.mode === module)
    .slice(0, Math.max(limit, 30));
  await Promise.all(initial.map(async (record) => {
    const status = record.status?.toUpperCase();
    if (status && ['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(status)) return;
    try {
      const snapshot = await fetchAssetJobSnapshot(record.jobId, 2_500);
      await updateAssetJobSnapshot(record.jobId, userId, snapshot);
    } catch {
      // The durable local record remains visible when the remote worker is
      // offline or its retention window has expired.
    }
  }));
  return listAssetJobHistory(userId, module, limit);
}

export async function handleHistoryRoute(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
) {
  if (url.pathname !== '/api/history') return false;
  if (request.method !== 'GET') {
    sendJson(response, 405, { error: 'Method not allowed.' });
    return true;
  }
  const user = await requireAuth(request, response);
  if (!user) return true;
  const module = url.searchParams.get('module') as HistoryModule | null;
  if (!module || !['bake', 'uv', 'retopology'].includes(module)) {
    sendJson(response, 400, { error: 'module must be bake, uv, or retopology.' });
    return true;
  }
  const requestedLimit = Number(url.searchParams.get('limit') ?? 30);
  const limit = Math.min(100, Math.max(1, Number.isFinite(requestedLimit) ? Math.trunc(requestedLimit) : 30));
  const records = module === 'bake'
    ? listNormalBakeJobs(user.id, limit).map((job) => bakeHistoryRecord(job, user.id))
    : (await refreshedAssetHistory(user.id, module, limit)).map((record) => assetHistoryRecord(module, record));
  sendJson(response, 200, { records });
  return true;
}
