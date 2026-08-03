import { getWorkspaceApiBase } from './workspaceApiBase';

const workspaceApiBase = getWorkspaceApiBase(import.meta.env.VITE_LICLICK_WORKSPACE_API);

export type AssetProcessingMode = 'uv' | 'retopology';
export type AssetJobStatus =
  | 'QUEUED'
  | 'CLAIMED'
  | 'RUNNING'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'CANCELLED';

export type AssetArtifact = {
  artifact_id?: string;
  id?: string;
  name?: string;
  role?: string;
  filename: string;
  kind: string;
  content_type?: string;
  size_bytes: number;
  sha256: string;
  download_url: string;
};

export type AssetJobError = {
  code: string;
  summary?: string;
  message?: string;
};

export type AssetJob = {
  job_id: string;
  request_id?: string;
  external_asset_id?: string;
  input_sha256?: string;
  kind?: string;
  status: AssetJobStatus;
  worker_id?: string;
  progress: number;
  stage?: string;
  stage_message?: string;
  error?: AssetJobError;
  timing?: {
    elapsed_seconds?: number;
    estimated_remaining_seconds?: number;
    last_progress_at?: string;
  };
  artifacts?: AssetArtifact[];
  result?: {
    artifacts?: AssetArtifact[];
    qa?: Record<string, unknown>;
    summary?: Record<string, unknown>;
  };
  qa?: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
};

export type AssetJobSubmission = {
  job_id: string;
  request_id?: string;
  external_asset_id?: string;
  input_sha256?: string;
  status: 'QUEUED';
  status_url: string;
  events_url: string;
  cancel_url: string;
};

export type AssetProcessingCapacity = {
  schemaVersion: string;
  advisory: boolean;
  onlineWorkers: number;
  totalSlots: number;
  usedSlots: number;
  availableSlots: number;
  asOf: string;
};

export type AssetProcessingStatus = {
  configured: boolean;
  available: boolean;
  reachable: boolean;
  authorized: boolean;
  capacityCheckPassed?: boolean;
  capacity?: AssetProcessingCapacity;
  message: string;
  endpoint: string;
  apiKeyConfigured: boolean;
  authorizationMode: 'api-key' | 'client-ip';
  tls: {
    rejectUnauthorized: boolean;
    customCaConfigured: boolean;
    customCaAvailable: boolean;
    customCaIntegrityValid?: boolean;
    customCaSha256?: string;
    expectedCaSha256?: string;
    customCaManaged?: boolean;
    customCaError?: string;
  };
  capabilities: {
    uv: boolean;
    retopology: boolean;
    polling: boolean;
    events: boolean;
    cancellation: boolean;
    artifacts: boolean;
    verifiedArtifacts: boolean;
  };
};

function errorDetails(payload: unknown, fallback: string) {
  let message = fallback;
  let code: string | undefined;
  let requestId: string | undefined;
  if (!payload || typeof payload !== 'object') return { message, code, requestId };
  if ('error' in payload) {
    const value = payload.error;
    if (value && typeof value === 'object') {
      if ('summary' in value && typeof value.summary === 'string') message = value.summary;
      else if ('message' in value && typeof value.message === 'string') message = value.message;
      if ('code' in value && typeof value.code === 'string') code = value.code;
    }
  }
  if ('request_id' in payload && typeof payload.request_id === 'string') {
    requestId = payload.request_id;
  }
  return { message, code, requestId };
}

export class AssetProcessingHttpError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly requestId?: string;

  constructor(status: number, message: string, code?: string, requestId?: string) {
    super(message);
    this.name = 'AssetProcessingHttpError';
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }
}

async function responseJson<T>(response: Response) {
  const payload = await response.json().catch(() => undefined);
  if (!response.ok) {
    const details = errorDetails(payload, `资产服务请求失败（${response.status}）`);
    throw new AssetProcessingHttpError(
      response.status,
      details.message,
      details.code,
      response.headers.get('x-li3d-request-id') ??
        response.headers.get('x-request-id') ??
        details.requestId ??
        undefined,
    );
  }
  return payload as T;
}

function requestHeaders(idempotencyKey?: string) {
  return {
    'X-Request-ID': crypto.randomUUID(),
    ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
  };
}

async function submissionFromResponse(response: Response) {
  if (response.status !== 202) {
    const payload = await response.json().catch(() => undefined);
    const details = errorDetails(payload, `Asset V4 提交协议错误（${response.status}）`);
    throw new AssetProcessingHttpError(
      response.status,
      details.message,
      details.code ?? 'ASSET_PROTOCOL_INVALID',
      response.headers.get('x-li3d-request-id') ??
        response.headers.get('x-request-id') ??
        details.requestId ??
        undefined,
    );
  }
  const payload = await responseJson<unknown>(response);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new AssetProcessingHttpError(502, 'Asset V4 返回了无效的任务响应。', 'ASSET_PROTOCOL_INVALID');
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
    throw new AssetProcessingHttpError(
      502,
      'Asset V4 任务响应缺少必要字段。',
      'ASSET_PROTOCOL_INVALID',
    );
  }
  return {
    ...record,
    request_id:
      typeof record.request_id === 'string'
        ? record.request_id
        : response.headers.get('x-li3d-request-id') ??
          response.headers.get('x-request-id') ??
          undefined,
  } as AssetJobSubmission;
}

export function assetJobId(job: AssetJob | AssetJobSubmission) {
  return job.job_id;
}

export function assetJobArtifacts(job?: AssetJob) {
  return job?.artifacts ?? job?.result?.artifacts ?? [];
}

export function assetJobError(job?: AssetJob) {
  return job?.error?.summary ?? job?.error?.message;
}

export function assetJobErrorCode(job?: AssetJob) {
  return job?.error?.code;
}

export async function getAssetProcessingStatus() {
  const response = await fetch(`${workspaceApiBase}/api/asset-processing/status`, {
    credentials: 'include',
    cache: 'no-store',
  });
  return responseJson<AssetProcessingStatus>(response);
}

export async function submitUvProcessing(input: {
  asset: File;
  metadata: {
    external_asset_id: string;
    options: {
      hidden_axis: 'x+' | 'x-' | 'y+' | 'y-' | 'z+' | 'z-' | 'auto';
      hard_edge_angle_degrees: number;
      resolution: 1024 | 2048 | 4096 | 8192;
      padding_px: number;
      texel_density_mode: 'uniform';
      qa_profile: 'pbr-v1';
    };
  };
}) {
  const body = new FormData();
  body.set('asset', input.asset);
  body.set('metadata', JSON.stringify(input.metadata));
  const response = await fetch(`${workspaceApiBase}/api/asset-processing/uv/process`, {
    method: 'POST',
    credentials: 'include',
    headers: requestHeaders(input.metadata.external_asset_id),
    body,
  });
  return submissionFromResponse(response);
}

export type RetopologyMetadata = {
  external_asset_id: string;
  options: {
    algorithm: 'agent';
    topology_style: 'quad_dominant';
    target_faces: number;
    preserve_sharp: boolean;
    preserve_boundary: boolean;
    render_resolution: number;
    max_repair_rounds: 0 | 1 | 2;
    require_closed: boolean;
  };
  reference_views: Array<{
    filename: string;
    view: 'front' | 'side' | 'top' | 'perspective' | 'detail' | 'other';
  }>;
  user_request: string;
};

export async function submitPreparedRetopologyProcessing(input: {
  highModel: File;
  metadata: RetopologyMetadata;
  referenceImages: File[];
}) {
  const body = new FormData();
  body.set('high_model', input.highModel);
  body.set('metadata', JSON.stringify(input.metadata));
  for (const image of input.referenceImages) body.append('reference_images', image);
  const response = await fetch(
    `${workspaceApiBase}/api/asset-processing/retopology/prepare-and-process`,
    {
      method: 'POST',
      credentials: 'include',
      headers: requestHeaders(input.metadata.external_asset_id),
      body,
    },
  );
  return submissionFromResponse(response);
}

export async function getAssetJob(jobId: string) {
  const response = await fetch(
    `${workspaceApiBase}/api/asset-processing/jobs/${encodeURIComponent(jobId)}`,
    {
      credentials: 'include',
      cache: 'no-store',
      headers: requestHeaders(),
    },
  );
  const payload = await responseJson<unknown>(response);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new AssetProcessingHttpError(
      502,
      'Asset V5 返回了无效的任务状态。',
      'ASSET_PROTOCOL_INVALID',
    );
  }
  const record = payload as Record<string, unknown>;
  const validStatuses = new Set<AssetJobStatus>([
    'QUEUED',
    'CLAIMED',
    'RUNNING',
    'SUCCEEDED',
    'FAILED',
    'CANCELLED',
  ]);
  if (
    typeof record.job_id !== 'string' ||
    !record.job_id ||
    typeof record.status !== 'string' ||
    !validStatuses.has(record.status as AssetJobStatus)
  ) {
    throw new AssetProcessingHttpError(
      502,
      'Asset V5 任务状态缺少必要字段或包含不受支持的人工复核状态。',
      'ASSET_PROTOCOL_INVALID',
    );
  }
  return record as AssetJob;
}

export async function cancelAssetJob(jobId: string) {
  const response = await fetch(
    `${workspaceApiBase}/api/asset-processing/jobs/${encodeURIComponent(jobId)}/cancel`,
    {
      method: 'POST',
      credentials: 'include',
      headers: requestHeaders(),
    },
  );
  return responseJson<AssetJob>(response);
}

function artifactIdentifier(artifact: AssetArtifact) {
  const directId = artifact.artifact_id ?? artifact.id;
  if (directId) return directId;
  if (!artifact.download_url) return undefined;
  try {
    const pathname = new URL(artifact.download_url, window.location.origin).pathname;
    const match = /\/artifacts\/([^/]+)\/?$/.exec(pathname);
    return match ? decodeURIComponent(match[1]) : undefined;
  } catch {
    return undefined;
  }
}

export function assetArtifactUrl(jobId: string, artifact: AssetArtifact) {
  const artifactId = artifactIdentifier(artifact);
  if (!artifactId) return undefined;
  return (
    `${workspaceApiBase}/api/asset-processing/jobs/${encodeURIComponent(jobId)}` +
    `/artifacts/${encodeURIComponent(artifactId)}`
  );
}

function triggerBrowserDownload(blob: Blob, filename: string) {
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
}

function retryableArtifactDownloadError(error: unknown) {
  if (!(error instanceof AssetProcessingHttpError)) return false;
  return (
    error.status === 408 ||
    error.status === 425 ||
    error.status === 429 ||
    error.status >= 500
  ) && error.code !== 'ASSET_ARTIFACT_SHA_MISMATCH';
}

async function fetchVerifiedArtifactBlob(jobId: string, artifact: AssetArtifact) {
  const url = assetArtifactUrl(jobId, artifact);
  if (!url) {
    throw new AssetProcessingHttpError(
      502,
      '交付文件缺少有效下载地址。',
      'ASSET_ARTIFACT_INVALID',
    );
  }
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(url, {
        credentials: 'include',
        cache: 'no-store',
        headers: requestHeaders(),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => undefined);
        const details = errorDetails(payload, `交付文件下载失败（${response.status}）`);
        throw new AssetProcessingHttpError(
          response.status,
          details.message,
          details.code,
          response.headers.get('x-li3d-request-id') ??
            response.headers.get('x-request-id') ??
            details.requestId ??
            undefined,
        );
      }
      if (response.headers.get('x-li3d-artifact-verified') !== 'true') {
        throw new AssetProcessingHttpError(
          502,
          '交付文件未通过三方 SHA 校验。',
          'ASSET_ARTIFACT_SHA_MISMATCH',
          response.headers.get('x-li3d-request-id') ??
            response.headers.get('x-request-id') ??
            undefined,
        );
      }
      return await response.blob();
    } catch (error) {
      lastError = error;
      if (attempt === 2 || !retryableArtifactDownloadError(error)) throw error;
      await new Promise((resolve) => window.setTimeout(resolve, 300 * 2 ** attempt));
    }
  }
  throw lastError;
}

export async function downloadVerifiedArtifact(jobId: string, artifact: AssetArtifact) {
  const blob = await fetchVerifiedArtifactBlob(jobId, artifact);
  triggerBrowserDownload(blob, artifact.filename);
}

const assetEventNames = [
  'job',
  'status',
  'progress',
  'stage',
  'artifact',
  'completed',
  'failed',
  'cancelled',
] as const;

export function subscribeAssetJobEvents(
  jobId: string,
  onSignal: () => void,
  onConnectionError?: () => void,
) {
  const source = new EventSource(
    `${workspaceApiBase}/api/asset-processing/jobs/${encodeURIComponent(jobId)}/events`,
    { withCredentials: true },
  );
  const handleSignal = () => onSignal();
  source.onmessage = handleSignal;
  for (const eventName of assetEventNames) {
    source.addEventListener(eventName, handleSignal);
  }
  source.onerror = () => onConnectionError?.();
  return () => source.close();
}
