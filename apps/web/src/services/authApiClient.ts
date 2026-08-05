import { getWorkspaceApiBase } from './workspaceApiBase';

const workspaceApiBase = getWorkspaceApiBase(import.meta.env.VITE_LICLICK_WORKSPACE_API);

let cachedProviderStatus: ProviderStatus | undefined;

export type AuthMode = 'dev-mock' | 'feishu-oauth';

export type AuthUser = {
  id: string;
  displayName: string;
  email?: string;
  avatarUrl?: string;
  role: string;
  authSource: AuthMode;
};

export type AuthMeResponse = {
  authenticated: boolean;
  authMode: AuthMode;
  user?: AuthUser;
};

export type ProviderStatus = {
  authMode: AuthMode;
  devLoginEnabled: boolean;
  feishuOAuthEnabled: boolean;
  feishuConfigured: boolean;
  feishuLoginProvider?: 'web-oauth' | 'idaas-jwt' | 'atlas-cli' | 'not-configured';
  atlasLoginMode?: 'interactive' | 'service-token';
  missingConfigKeys: string[];
  atlas?: {
    valid?: boolean;
    expiresAt?: string;
    message?: string;
  };
};

async function requestJson<T>(path: string, init?: RequestInit) {
  const headers = new Headers(init?.headers);
  if (init?.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 30_000);
  let response: Response;
  try {
    response = await fetch(`${workspaceApiBase}${path}`, {
      ...init,
      signal: controller.signal,
      headers,
      credentials: 'include',
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error('登录服务响应超时，请稍后重试。');
    }
    throw new Error('无法连接登录服务，请确认 LI3D Web 后端已启动并可访问。');
  } finally {
    window.clearTimeout(timeout);
  }
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  if (!contentType.includes('application/json')) {
    throw new Error(
      '当前网址只部署了前端页面，尚未连接 LI3D Web 后端。请从已部署前后端一体服务的网址访问。',
    );
  }
  const payload: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = payload && typeof payload === 'object' && 'error' in payload ? payload.error : undefined;
    const missingConfigKeys =
      payload && typeof payload === 'object' && 'missingConfigKeys' in payload && Array.isArray(payload.missingConfigKeys)
        ? payload.missingConfigKeys.filter((key): key is string => typeof key === 'string')
        : [];
    const message = typeof error === 'string' ? error : `Auth request failed: ${response.status}`;
    throw new Error(missingConfigKeys.length > 0 ? `${message} Missing: ${missingConfigKeys.join(', ')}` : message);
  }
  return payload as T;
}

export function getAuthMe() {
  return requestJson<AuthMeResponse>('/api/auth/me');
}

export function getProviderStatus() {
  return requestJson<ProviderStatus>('/api/auth/provider-status').then((providerStatus) => {
    cachedProviderStatus = providerStatus;
    return providerStatus;
  });
}

export function getCachedProviderStatus() {
  return cachedProviderStatus;
}

export function devLogin(input: { displayName?: string; email?: string }) {
  return requestJson<{ user: AuthUser }>('/api/auth/dev-login', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function startFeishuLogin() {
  return requestJson<{
    redirectUrl?: string;
    loginId?: string;
    user?: AuthUser;
    authMode?: AuthMode;
    message?: string;
    atlas?: ProviderStatus['atlas'];
  }>('/api/auth/feishu/start');
}

export function pollFeishuLogin(loginId: string) {
  return requestJson<{
    done: boolean;
    redirectUrl?: string;
    loginId?: string;
    user?: AuthUser;
    authMode?: AuthMode;
    message?: string;
    atlas?: ProviderStatus['atlas'];
  }>(`/api/auth/feishu/poll/${encodeURIComponent(loginId)}`);
}

export function logout() {
  return requestJson<{ success: true }>('/api/auth/logout', { method: 'POST' });
}
