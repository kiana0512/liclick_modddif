import type { IncomingMessage, ServerResponse } from 'node:http';
import { requireAuth } from '../auth/authMiddleware.js';
import {
  assetProcessingProxyStatus,
  downloadVerifiedAssetArtifact,
  proxyAssetProcessingRequest,
  sendAssetProcessingError,
} from '../services/assetProcessingProxy.js';
import {
  registerAssetJobOwner,
  updateAssetJobSnapshot,
  userOwnsAssetJob,
  type AssetHistoryMode,
  type AssetHistoryParameter,
  type AssetHistoryRegistration,
} from '../services/assetJobOwnership.js';
import { sendJson } from './httpUtils.js';

function requireSubmissionJobId(
  payload: unknown,
  statusCode: number,
  mode: AssetHistoryMode,
) {
  if (statusCode !== 202 || !payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Asset service returned an invalid submission response.');
  }
  const record = payload as Record<string, unknown>;
  if (
    typeof record.job_id !== 'string' ||
    !record.job_id ||
    record.status !== 'QUEUED' ||
    typeof record.status_url !== 'string' ||
    typeof record.events_url !== 'string' ||
    typeof record.cancel_url !== 'string'
  ) {
    throw new Error('Asset service submission response is missing required job fields.');
  }
  if (mode === 'retopology' && record.job_type !== 'RETOPOLOGY_PROCESS_V2') {
    throw new Error('Asset service returned a non-V6 retopology job.');
  }
  return record.job_id;
}

function historyText(value: unknown, maximumLength: number) {
  if (typeof value !== 'string') return undefined;
  const clean = Array.from(value, (character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 31 || code === 127 ? ' ' : character;
  }).join('').trim().slice(0, maximumLength);
  return clean || undefined;
}

function historyParameter(label: string, value: unknown): AssetHistoryParameter | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const text = historyText(typeof value === 'string' ? value : String(value), 600);
  return text ? { label, value: text } : undefined;
}

function historyParameters(mode: AssetHistoryMode, metadata: unknown) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return [];
  const record = metadata as Record<string, unknown>;
  const options = record.options && typeof record.options === 'object' && !Array.isArray(record.options)
    ? record.options as Record<string, unknown>
    : record;
  const values: Array<AssetHistoryParameter | undefined> = mode === 'uv'
    ? [
        historyParameter('输出尺寸', options.resolution ? `${options.resolution}px` : undefined),
        historyParameter('隐藏轴', options.hidden_axis),
        historyParameter('硬边角度', options.hard_edge_angle_degrees !== undefined ? `${options.hard_edge_angle_degrees}°` : undefined),
        historyParameter('UV 间距', options.padding_px !== undefined ? `${options.padding_px}px` : undefined),
        historyParameter('纹素密度', options.texel_density_mode),
        historyParameter('QA 配置', options.qa_profile),
      ]
    : [
        historyParameter('密度模式', options.budget_mode),
        historyParameter('拓扑类型', options.topology_style),
        historyParameter('交付档位', options.delivery_profile),
        historyParameter('保留源文件', options.preserve_source === undefined ? undefined : options.preserve_source ? '是' : '否'),
        historyParameter('锐边保留', options.preserve_sharp_edges === undefined ? undefined : options.preserve_sharp_edges ? '是' : '否'),
        historyParameter('边界保留', options.preserve_boundaries === undefined ? undefined : options.preserve_boundaries ? '是' : '否'),
        historyParameter('参考图', Array.isArray(record.reference_views) ? `${record.reference_views.length} 张` : undefined),
        historyParameter('制作要求', historyText(record.user_request, 600)),
      ];
  return values.filter((value): value is AssetHistoryParameter => Boolean(value));
}

function decodedHistoryHeader(request: IncomingMessage, name: string, maximumLength: number) {
  const raw = request.headers[name]?.toString();
  // encodeURIComponent expands a Unicode scalar to at most twelve ASCII
  // characters (four UTF-8 bytes, each encoded as %XX). Keep an absolute cap
  // as this value originates in an HTTP header.
  const maximumEncodedLength = Math.min(4_096, maximumLength * 12);
  if (!raw || raw.length > maximumEncodedLength) return undefined;
  try {
    return historyText(decodeURIComponent(raw), maximumLength);
  } catch {
    return undefined;
  }
}

function submissionHistory(
  request: IncomingMessage,
  mode: AssetHistoryMode,
): AssetHistoryRegistration {
  const sourceName = decodedHistoryHeader(request, 'x-li3d-history-source-name', 180)
    ?? (mode === 'uv' ? '历史展 UV 任务' : '历史拓扑任务');
  const encodedMetadata = request.headers['x-li3d-history-metadata']?.toString();
  let metadata: unknown;
  if (encodedMetadata && encodedMetadata.length <= 8_192 * 3) {
    try {
      metadata = JSON.parse(decodeURIComponent(encodedMetadata)) as unknown;
    } catch {
      metadata = undefined;
    }
  }
  const batchId = mode === 'retopology'
    ? decodedHistoryHeader(request, 'x-li3d-history-batch-id', 240)
    : undefined;
  const rawBatchIndex = Number(request.headers['x-li3d-history-batch-index']);
  const rawBatchSize = Number(request.headers['x-li3d-history-batch-size']);
  const batchIndex = batchId && Number.isInteger(rawBatchIndex) && rawBatchIndex >= 0
    ? rawBatchIndex
    : undefined;
  const batchSize = batchId && Number.isInteger(rawBatchSize) && rawBatchSize > 0 && rawBatchSize <= 100
    ? rawBatchSize
    : undefined;
  return {
    mode,
    sourceName,
    parameters: historyParameters(mode, metadata),
    ...(batchId ? { batchId } : {}),
    ...(batchIndex !== undefined ? { batchIndex } : {}),
    ...(batchSize !== undefined ? { batchSize } : {}),
  };
}

export async function handleAssetProcessingRoute(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
) {
  const user = await requireAuth(request, response);
  if (!user) return true;

  if (url.pathname === '/api/asset-processing/status' && request.method === 'GET') {
    sendJson(response, 200, await assetProcessingProxyStatus());
    return true;
  }

  const submissionRoutes = new Map([
    ['/api/asset-processing/uv/process', '/api/v1/assets/uv/process'],
    ['/api/asset-processing/retopology/process', '/api/v1/assets/retopology/process'],
  ]);
  const submissionUpstream = submissionRoutes.get(url.pathname);
  if (submissionUpstream) {
    if (request.method !== 'POST') {
      sendAssetProcessingError(
        response,
        405,
        'ASSET_METHOD_NOT_ALLOWED',
        'Method not allowed.',
      );
      return true;
    }
    const mode: AssetHistoryMode = url.pathname.includes('/uv/') ? 'uv' : 'retopology';
    const registration = submissionHistory(request, mode);
    await proxyAssetProcessingRequest(
      request,
      response,
      submissionUpstream,
      async (payload, statusCode) => {
        const jobId = requireSubmissionJobId(payload, statusCode, mode);
        await registerAssetJobOwner(jobId, user.id, registration);
        await updateAssetJobSnapshot(jobId, user.id, payload);
      },
    );
    return true;
  }

  const routeMap: Array<{
    pattern: RegExp;
    methods: string[];
    upstream: (match: RegExpExecArray) => string;
  }> = [
    {
      pattern: /^\/api\/asset-processing\/jobs\/([^/]+)$/,
      methods: ['GET'],
      upstream: (match) => `/api/v1/assets/jobs/${encodeURIComponent(decodeURIComponent(match[1]))}`,
    },
    {
      pattern: /^\/api\/asset-processing\/jobs\/([^/]+)\/cancel$/,
      methods: ['POST'],
      upstream: (match) => `/api/v1/assets/jobs/${encodeURIComponent(decodeURIComponent(match[1]))}/cancel`,
    },
    {
      pattern: /^\/api\/asset-processing\/jobs\/([^/]+)\/events$/,
      methods: ['GET'],
      upstream: (match) => `/api/v1/assets/jobs/${encodeURIComponent(decodeURIComponent(match[1]))}/events`,
    },
    {
      pattern: /^\/api\/asset-processing\/jobs\/([^/]+)\/artifacts\/([^/]+)$/,
      methods: ['GET'],
      upstream: () => '',
    },
  ];

  for (const route of routeMap) {
    const match = route.pattern.exec(url.pathname);
    if (!match) continue;
    if (!request.method || !route.methods.includes(request.method)) {
      sendAssetProcessingError(
        response,
        405,
        'ASSET_METHOD_NOT_ALLOWED',
        'Method not allowed.',
      );
      return true;
    }
    const jobId = decodeURIComponent(match[1]);
    if (!(await userOwnsAssetJob(jobId, user.id))) {
      sendAssetProcessingError(
        response,
        404,
        'ASSET_JOB_NOT_FOUND',
        'Asset job not found.',
      );
      return true;
    }
    if (match.length === 3 && url.pathname.includes('/artifacts/')) {
      await downloadVerifiedAssetArtifact(
        request,
        response,
        jobId,
        decodeURIComponent(match[2]),
      );
      return true;
    }
    const capturesSnapshot = !url.pathname.endsWith('/events');
    await proxyAssetProcessingRequest(
      request,
      response,
      route.upstream(match),
      capturesSnapshot
        ? async (payload) => {
            await updateAssetJobSnapshot(jobId, user.id, payload);
          }
        : undefined,
    );
    return true;
  }

  return false;
}
