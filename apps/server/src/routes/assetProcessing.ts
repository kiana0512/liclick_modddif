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
  userOwnsAssetJob,
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
        async (payload, statusCode) =>
          registerAssetJobOwner(requireV4SubmissionJobId(payload, statusCode), user.id),
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
    await proxyAssetProcessingRequest(
      request,
      response,
      submissionUpstream,
      async (payload, statusCode) =>
        registerAssetJobOwner(requireV4SubmissionJobId(payload, statusCode), user.id),
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
    await proxyAssetProcessingRequest(request, response, route.upstream(match));
    return true;
  }

  return false;
}
