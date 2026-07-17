import { getWorkspaceApiBase } from '@/services/workspaceApiBase';

const workspaceApiBase = getWorkspaceApiBase(import.meta.env.VITE_LICLICK_WORKSPACE_API);

export type PhotoshopSessionStatus =
  | 'awaiting_source'
  | 'launching'
  | 'waiting_for_plugin'
  | 'opening'
  | 'ready'
  | 'dirty'
  | 'syncing'
  | 'synced'
  | 'error'
  | 'closed';

export type PhotoshopSession = {
  id: string;
  token: string;
  projectId: string;
  layerId: string;
  layerName: string;
  layerType: 'projected' | 'uv';
  status: PhotoshopSessionStatus;
  workingDocumentPath: string;
  latestRevision: number;
  latestImageUrl?: string;
  syncMode: 'save' | 'live';
  liveSyncDelayMs: number;
  error?: string;
  createdAt: string;
  updatedAt: string;
};

export type PhotoshopBridgeStatus = {
  protocolVersion: string;
  plugin: {
    connected: boolean;
    pluginVersion?: string;
    photoshopVersion?: string;
  };
  installations: Array<{
    id: string;
    label: string;
    version: string;
    executablePath: string;
    selected: boolean;
  }>;
  selectedInstallation?: {
    id: string;
    label: string;
    version: string;
    executablePath: string;
    selected: boolean;
  };
  activeSessions: number;
};

function websocketBase() {
  const url = new URL(workspaceApiBase);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.href.replace(/\/$/, '');
}

async function requestJson<T>(path: string, init: RequestInit & { timeoutMs?: number } = {}) {
  const { timeoutMs = 15_000, headers, ...requestInit } = init;
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${workspaceApiBase}${path}`, {
      ...requestInit,
      headers,
      signal: controller.signal,
      credentials: 'include',
    });
    const payload = (await response.json().catch(() => undefined)) as { error?: string } | undefined;
    if (!response.ok) throw new Error(payload?.error || `Photoshop bridge request failed: ${response.status}`);
    return payload as T;
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error('Photoshop 本地桥接响应超时。');
    }
    if (error instanceof TypeError) throw new Error('无法连接 Photoshop 本地桥接，请确认启动器正在运行。');
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
}

function sessionHeaders(session: Pick<PhotoshopSession, 'token'>, extra?: HeadersInit) {
  return {
    'x-liclick-session-token': session.token,
    ...Object.fromEntries(new Headers(extra).entries()),
  };
}

export function getPhotoshopBridgeStatus() {
  return requestJson<PhotoshopBridgeStatus>('/api/photoshop/status', { method: 'GET' });
}

export function launchPhotoshop() {
  return requestJson<{ pluginConnected: boolean }>('/api/photoshop/launch', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
}

export function createPhotoshopSession(input: {
  projectId: string;
  layerId: string;
  layerName: string;
  layerType: 'projected' | 'uv';
}) {
  return requestJson<PhotoshopSession>('/api/photoshop/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
}

export async function uploadPhotoshopSessionSource(session: PhotoshopSession, image: Blob) {
  return requestJson<PhotoshopSession>(`/api/photoshop/sessions/${encodeURIComponent(session.id)}/source`, {
    method: 'PUT',
    headers: sessionHeaders(session, { 'content-type': image.type || 'image/png' }),
    body: image,
    timeoutMs: 120_000,
  });
}

export function openPhotoshopSession(session: PhotoshopSession) {
  return requestJson<PhotoshopSession>(`/api/photoshop/sessions/${encodeURIComponent(session.id)}/open`, {
    method: 'POST',
    headers: sessionHeaders(session, { 'content-type': 'application/json' }),
    body: '{}',
    timeoutMs: 30_000,
  });
}

export function syncPhotoshopSession(session: PhotoshopSession) {
  return requestJson<PhotoshopSession>(`/api/photoshop/sessions/${encodeURIComponent(session.id)}/sync`, {
    method: 'POST',
    headers: sessionHeaders(session, { 'content-type': 'application/json' }),
    body: '{}',
  });
}

export function closePhotoshopSession(session: PhotoshopSession) {
  return requestJson<PhotoshopSession>(`/api/photoshop/sessions/${encodeURIComponent(session.id)}/close`, {
    method: 'POST',
    headers: sessionHeaders(session, { 'content-type': 'application/json' }),
    body: '{}',
  });
}

export function subscribePhotoshopSession(
  session: PhotoshopSession,
  listener: (session: PhotoshopSession) => void,
) {
  let socket: WebSocket | undefined;
  let reconnectTimer: number | undefined;
  let reconnectAttempt = 0;
  let stopped = false;

  const connect = () => {
    if (stopped) return;
    const params = new URLSearchParams({
      role: 'web',
      sessionId: session.id,
      token: session.token,
    });
    socket = new WebSocket(`${websocketBase()}/api/photoshop/socket?${params.toString()}`);
    socket.addEventListener('open', () => {
      reconnectAttempt = 0;
    });
    socket.addEventListener('message', (event) => {
      try {
        const message = JSON.parse(String(event.data)) as { type?: string; session?: PhotoshopSession };
        if (message.type === 'session-updated' && message.session?.id === session.id) {
          listener({ ...message.session, token: session.token });
        }
      } catch {
        // A malformed bridge message is ignored; the next valid revision remains usable.
      }
    });
    socket.addEventListener('close', () => {
      if (stopped) return;
      const delay = Math.min(10_000, 500 * 2 ** Math.min(reconnectAttempt, 5));
      reconnectAttempt += 1;
      reconnectTimer = window.setTimeout(connect, delay);
    });
  };

  connect();
  return () => {
    stopped = true;
    window.clearTimeout(reconnectTimer);
    socket?.close();
  };
}
