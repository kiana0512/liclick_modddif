import type { AuthMode, AuthUser, ProviderStatus } from './authApiClient';
import { getClientIdentity } from './clientIdentity';
import { getWorkspaceApiBase } from './workspaceApiBase';

const workspaceApiBase = getWorkspaceApiBase(import.meta.env.VITE_LICLICK_WORKSPACE_API);

export type IdentityStatus = {
  ok: boolean;
  bound: boolean;
  ambiguous?: boolean;
  user_name?: string;
  email?: string;
  department?: string;
};

export type IdentityBindStart = {
  redirectUrl?: string;
  loginId?: string;
  user?: AuthUser;
  authMode?: AuthMode;
  message?: string;
  atlas?: ProviderStatus['atlas'];
};

export class IdentityApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'IdentityApiError';
  }
}

async function requestIdentityJson<T>(path: string, init?: RequestInit) {
  const headers = new Headers(init?.headers);
  if (init?.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 15_000);
  let response: Response;
  try {
    response = await fetch(`${workspaceApiBase}${path}`, {
      ...init,
      headers,
      credentials: 'include',
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new IdentityApiError('身份服务响应超时，请稍后重试。');
    }
    throw new IdentityApiError('无法连接 LI3D 身份服务，请检查网络后重试。');
  } finally {
    window.clearTimeout(timeout);
  }

  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  if (!contentType.includes('application/json')) {
    throw new IdentityApiError('当前网址没有连接 LI3D 身份后端。', response.status);
  }
  const payload = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) {
    throw new IdentityApiError(
      typeof payload.error === 'string' ? payload.error : `Identity request failed: ${response.status}`,
      response.status,
    );
  }
  return payload;
}

export function getIdentityStatus() {
  const { machine_id, install_id } = getClientIdentity();
  return requestIdentityJson<IdentityStatus>('/api/identity/status', {
    method: 'POST',
    body: JSON.stringify({ machine_id, install_id }),
  });
}

export function startIdentityBinding() {
  const { machine_id, install_id } = getClientIdentity();
  const query = new URLSearchParams({ machine_id, install_id });
  return requestIdentityJson<IdentityBindStart>(`/api/identity/bind/start?${query.toString()}`);
}
