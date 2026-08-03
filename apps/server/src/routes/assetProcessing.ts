import type { IncomingMessage, ServerResponse } from 'node:http';
import { requireAuth } from '../auth/authMiddleware.js';
import {
  assetProcessingProxyStatus,
  downloadVerifiedAssetArtifact,
  proxyAssetProcessingRequest,
  proxyPreparedRetopologySubmission,
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
import {
  prepareRetopologyProjectFromFiles,
  RetopologyPreparationError,
} from '../services/retopologyProjectPreparationService.js';
import {
  parsePreparedRetopologySubmission,
  type ParsedPreparedRetopologySubmission,
} from '../services/retopologyPreparedSubmissionUploadService.js';
import { sendJson } from './httpUtils.js';

function requireV4SubmissionJobId(payload: unknown, statusCode: number) {
  if (statusCode !== 202 || !payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Asset V4 returned an invalid submission response.');
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
    throw new Error('Asset V4 submission response is missing required job fields.');
  }
  return record.job_id;
}

function historyText(value: unknown, maximumLength: number) {
  if (typeof value !== 'string') return undefined;
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, maximumLength);
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
        historyParameter('目标面数', options.target_faces),
        historyParameter('拓扑类型', options.topology_style),
        historyParameter('锐边保留', options.preserve_sharp === undefined ? undefined : options.preserve_sharp ? '是' : '否'),
        historyParameter('边界保留', options.preserve_boundary === undefined ? undefined : options.preserve_boundary ? '是' : '否'),
        historyParameter('封闭模型', options.require_closed === undefined ? undefined : options.require_closed ? '是' : '否'),
        historyParameter('检查分辨率', options.render_resolution),
        historyParameter('最大修复轮次', options.max_repair_rounds),
        historyParameter('参考图', Array.isArray(record.reference_views) ? `${record.reference_views.length} 张` : undefined),
        historyParameter('制作要求', historyText(record.user_request, 600)),
      ];
  return values.filter((value): value is AssetHistoryParameter => Boolean(value));
}

function decodedHistoryHeader(request: IncomingMessage, name: string, maximumLength: number) {
  const raw = request.headers[name]?.toString();
  if (!raw || raw.length > maximumLength * 3) return undefined;
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
  return { mode, sourceName, parameters: historyParameters(mode, metadata) };
}

export async function handleAssetProcessingRoute(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
) {
  const user = await requireAuth(request, response);
  if (!user) return true;

  if (url.pathname === '/api/asset-processing/retopology/prepare-and-process') {
    if (request.method !== 'POST') {
      sendAssetProcessingError(
        response,
        405,
        'ASSET_METHOD_NOT_ALLOWED',
        'Method not allowed.',
      );
      return true;
    }

    const abortController = new AbortController();
    const onResponseClose = () => {
      if (!response.writableEnded) abortController.abort();
    };
    response.once('close', onResponseClose);
    let upload: ParsedPreparedRetopologySubmission | undefined;
    let prepared: Awaited<ReturnType<typeof prepareRetopologyProjectFromFiles>> | undefined;
    try {
      upload = await parsePreparedRetopologySubmission(request);
      if (abortController.signal.aborted) return true;
      prepared = await prepareRetopologyProjectFromFiles(
        upload.sources,
        abortController.signal,
      );
      if (abortController.signal.aborted) return true;
      await proxyPreparedRetopologySubmission(
        request,
        response,
        {
          project: {
            fieldName: 'project',
            filePath: prepared.filePath,
            filename: prepared.filename,
            size: prepared.size,
            contentType: 'application/octet-stream',
          },
          referenceImages: upload.referenceImages,
          metadata: upload.metadata,
        },
        async (payload, statusCode) => {
          const jobId = requireV4SubmissionJobId(payload, statusCode);
          const metadata = JSON.parse(upload!.metadata) as unknown;
          await registerAssetJobOwner(jobId, user.id, {
            mode: 'retopology',
            sourceName: upload!.sourceName,
            parameters: historyParameters('retopology', metadata),
          });
          await updateAssetJobSnapshot(jobId, user.id, payload);
        },
      );
    } catch (error) {
      if (response.headersSent) {
        response.destroy(error instanceof Error ? error : undefined);
      } else if (!abortController.signal.aborted) {
        const preparationError = error instanceof RetopologyPreparationError;
        const statusCode = preparationError ? error.statusCode : 500;
        const code =
          statusCode === 413
            ? 'ASSET_UPLOAD_TOO_LARGE'
            : statusCode === 415
              ? 'ASSET_MEDIA_TYPE_UNSUPPORTED'
              : statusCode >= 500
                ? 'ASSET_PREPARATION_FAILED'
                : 'ASSET_INPUT_INVALID';
        sendAssetProcessingError(
          response,
          statusCode,
          code,
          preparationError
            ? error.message
            : 'Could not prepare and submit the retopology project.',
        );
      }
    } finally {
      response.off('close', onResponseClose);
      await prepared?.cleanup();
      await upload?.cleanup();
    }
    return true;
  }

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
        const jobId = requireV4SubmissionJobId(payload, statusCode);
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
