import {
  checkLocalTextureRuntime,
  getLocalTextureRuntimeApiBase,
} from './localTextureRuntimeClient';
import { fetchWithLocalIdentityProof } from './localIdentityProofApiClient';

const personalLiclickCapability = 'atlas-personal-auth';

export type PersonalLiclickAccountStatus = {
  bound: boolean;
  valid: boolean;
  email?: string;
  displayName?: string;
  expiresAt?: string;
  reason?: string;
  message?: string;
};

export type PersonalLiclickBindingStart = {
  loginId: string;
  redirectUrl: string;
  expiresAt?: string;
  message?: string;
};

export type PersonalLiclickBindingProgress = {
  done: boolean;
  status: 'pending' | 'succeeded' | 'failed';
  account?: PersonalLiclickAccountStatus;
  message?: string;
  error?: string;
};

type JsonRecord = Record<string, unknown>;
let cachedAccountStatus: PersonalLiclickAccountStatus | undefined;

export class LocalLiclickAccountApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'LocalLiclickAccountApiError';
  }
}

function asRecord(value: unknown): JsonRecord | undefined {
  return value && typeof value === 'object' ? (value as JsonRecord) : undefined;
}

function readString(record: JsonRecord | undefined, key: string) {
  const value = record?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function normalizeAccountStatus(payload: unknown): PersonalLiclickAccountStatus {
  const root = asRecord(payload);
  const account = asRecord(root?.account) ?? root;
  const state = readString(account, 'status')?.toLowerCase();
  const valid = account?.valid === true || state === 'valid' || state === 'ready';
  const bound = account?.bound === true || valid || Boolean(readString(account, 'email'));
  return {
    bound,
    valid,
    email: readString(account, 'email'),
    displayName: readString(account, 'displayName') ?? readString(account, 'display_name'),
    expiresAt: readString(account, 'expiresAt') ?? readString(account, 'expires_at'),
    reason: readString(account, 'reason'),
    message: readString(account, 'message') ?? readString(root, 'message'),
  };
}

function readError(payload: unknown, fallback: string) {
  const record = asRecord(payload);
  return readString(record, 'error') ?? readString(record, 'message') ?? fallback;
}

async function requestLocalJson<T>(
  path: string,
  init: RequestInit & { timeoutMs?: number } = {},
) {
  const { timeoutMs = 30_000, headers, ...fetchInit } = init;
  const requestHeaders = new Headers(headers);
  if (fetchInit.body && !requestHeaders.has('content-type')) {
    requestHeaders.set('content-type', 'application/json');
  }
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetchWithLocalIdentityProof(
      `${getLocalTextureRuntimeApiBase()}${path}`,
      {
        ...fetchInit,
        cache: 'no-store',
        credentials: 'omit',
        headers: requestHeaders,
        signal: controller.signal,
      },
      { signal: controller.signal, timeoutMs: Math.min(timeoutMs, 8_000) },
    );
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new LocalLiclickAccountApiError('本地贴图组件响应超时，请确认组件仍在运行。');
    }
    throw new LocalLiclickAccountApiError(
      '无法连接本地贴图组件。请安装并启动最新版“LIclick 3D Texture Local Component”。',
    );
  } finally {
    window.clearTimeout(timeout);
  }

  const payload = (await response.json().catch(() => undefined)) as unknown;
  if (!response.ok) {
    const record = asRecord(payload);
    const code = readString(record, 'code');
    const fallback =
      response.status === 404
        ? '本地贴图组件版本过旧，不支持个人莉刻账号绑定。请下载安装最新版组件。'
        : `本地莉刻账号服务请求失败：${response.status}`;
    throw new LocalLiclickAccountApiError(readError(payload, fallback), response.status, code);
  }
  return payload as T;
}

export async function requirePersonalLiclickRuntime() {
  const runtime = await checkLocalTextureRuntime();
  if (runtime.status === 'missing') {
    throw new LocalLiclickAccountApiError(
      runtime.reason || '未检测到本地贴图组件，请先安装并启动最新版组件。',
    );
  }
  if (runtime.status === 'outdated') {
    throw new LocalLiclickAccountApiError(
      `本地贴图组件版本过旧（${runtime.health.runtimeVersion}），请下载安装最新版组件。`,
    );
  }
  if (runtime.status !== 'ready') {
    throw new LocalLiclickAccountApiError('本地贴图组件仍在启动，请稍后重试。');
  }
  if (!runtime.health.capabilities.includes(personalLiclickCapability)) {
    throw new LocalLiclickAccountApiError(
      '当前本地贴图组件不支持个人莉刻账号绑定，请下载安装最新版组件。',
    );
  }
  return runtime.health;
}

export async function getPersonalLiclickAccountStatus(options: { verifyRuntime?: boolean } = {}) {
  if (options.verifyRuntime !== false) await requirePersonalLiclickRuntime();
  const payload = await requestLocalJson<unknown>('/api/local-liclick-account/status', {
    method: 'GET',
    timeoutMs: 8_000,
  });
  cachedAccountStatus = normalizeAccountStatus(payload);
  return cachedAccountStatus;
}

export function getCachedPersonalLiclickAccountStatus() {
  return cachedAccountStatus;
}

export function invalidateCachedPersonalLiclickAccountStatus() {
  cachedAccountStatus = undefined;
}

export function isPersonalLiclickAccountForEmail(
  account: PersonalLiclickAccountStatus | undefined,
  expectedEmail: string | undefined,
) {
  if (!account?.valid) return false;
  if (account.expiresAt) {
    const expiresAt = Date.parse(account.expiresAt);
    if (Number.isFinite(expiresAt) && expiresAt <= Date.now() + 30_000) return false;
  }
  if (!expectedEmail) return true;
  return account.email?.trim().toLowerCase() === expectedEmail.trim().toLowerCase();
}

export async function startPersonalLiclickAccountBinding(_expectedEmail?: string) {
  await requirePersonalLiclickRuntime();
  const payload = await requestLocalJson<unknown>('/api/local-liclick-account/bind/start', {
    method: 'POST',
    body: JSON.stringify({}),
    timeoutMs: 15_000,
  });
  const record = asRecord(payload);
  const loginId = readString(record, 'loginId') ?? readString(record, 'login_id');
  const redirectUrl = readString(record, 'redirectUrl') ?? readString(record, 'redirect_url');
  if (!loginId || !redirectUrl) {
    throw new LocalLiclickAccountApiError('本地组件没有返回完整的莉刻授权信息，请重启组件后再试。');
  }
  return {
    loginId,
    redirectUrl,
    expiresAt: readString(record, 'expiresAt') ?? readString(record, 'expires_at'),
    message: readString(record, 'message'),
  } satisfies PersonalLiclickBindingStart;
}

export async function pollPersonalLiclickAccountBinding(loginId: string) {
  const payload = await requestLocalJson<unknown>(
    `/api/local-liclick-account/bind/poll/${encodeURIComponent(loginId)}`,
    { method: 'GET', timeoutMs: 8_000 },
  );
  const record = asRecord(payload);
  const rawStatus = readString(record, 'status')?.toLowerCase();
  const failed =
    rawStatus === 'failed' || rawStatus === 'error' || record?.success === false;
  const succeeded =
    rawStatus === 'succeeded' ||
    rawStatus === 'success' ||
    rawStatus === 'complete' ||
    record?.success === true ||
    (record?.done === true && !failed);
  const status: PersonalLiclickBindingProgress['status'] = failed
    ? 'failed'
    : succeeded
      ? 'succeeded'
      : 'pending';
  return {
    done: status !== 'pending' || record?.done === true,
    status,
    account: asRecord(record?.account) ? normalizeAccountStatus(record?.account) : undefined,
    message: readString(record, 'message'),
    error: readString(record, 'error'),
  } satisfies PersonalLiclickBindingProgress;
}

export async function unbindPersonalLiclickAccount() {
  await requirePersonalLiclickRuntime();
  await requestLocalJson<unknown>('/api/local-liclick-account/unbind', {
    method: 'POST',
    body: JSON.stringify({}),
    timeoutMs: 8_000,
  });
  cachedAccountStatus = { bound: false, valid: false, message: '尚未绑定' };
}
