import { getWorkspaceApiBase } from './workspaceApiBase';

const workspaceApiBase = getWorkspaceApiBase(import.meta.env.VITE_LICLICK_WORKSPACE_API);

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
  const response = await fetch(`${workspaceApiBase}${path}`, {
    ...init,
    headers,
    credentials: 'include',
  });
  if (!response.ok) {
    const payload: unknown = await response.json().catch(() => ({}));
    const error = payload && typeof payload === 'object' && 'error' in payload ? payload.error : undefined;
    const missingConfigKeys =
      payload && typeof payload === 'object' && 'missingConfigKeys' in payload && Array.isArray(payload.missingConfigKeys)
        ? payload.missingConfigKeys.filter((key): key is string => typeof key === 'string')
        : [];
    const message = typeof error === 'string' ? error : `Auth request failed: ${response.status}`;
    throw new Error(missingConfigKeys.length > 0 ? `${message} Missing: ${missingConfigKeys.join(', ')}` : message);
  }
  return response.json() as Promise<T>;
}

export function getAuthMe() {
  return requestJson<AuthMeResponse>('/api/auth/me');
}

export function getProviderStatus() {
  return requestJson<ProviderStatus>('/api/auth/provider-status');
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
