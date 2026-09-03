import { getWorkspaceApiBase } from '@/services/workspaceApiBase';

const workspaceApiBase = getWorkspaceApiBase(import.meta.env.VITE_LICLICK_WORKSPACE_API);

export type PerformanceLabSessionListItem = {
  sessionId: string;
  projectId?: string;
  status: 'recording' | 'completed';
  schemaVersion: number;
  collectorVersion: string;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  chunkCount: number;
  sampleCount: number;
  totalBytes: number;
  summary?: Record<string, unknown>;
  user: {
    id: string;
    displayName: string;
    avatarUrl?: string;
    email?: string;
  };
};

export type PerformanceLabSessionDetail = PerformanceLabSessionListItem & {
  clientContext: Record<string, unknown>;
  report?: Record<string, unknown>;
  chunks: Array<{
    source: 'browser';
    sequence: number;
    startedAt: string;
    endedAt: string;
    sampleCount: number;
    byteCount: number;
    payloadSha256: string;
    payload: Record<string, unknown>;
  }>;
};

async function requestJson<T>(path: string) {
  const response = await fetch(`${workspaceApiBase}${path}`, {
    credentials: 'include',
    headers: { accept: 'application/json' },
  });
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(
      typeof payload.error === 'string'
        ? payload.error
        : `Performance Lab request failed: ${response.status}`,
    );
  }
  return payload as T;
}

export function performanceLabApiUrl(path: string) {
  return `${workspaceApiBase}${path}`;
}

export function listPerformanceLabSessions(limit = 100) {
  return requestJson<{ sessions: PerformanceLabSessionListItem[] }>(
    `/api/performance-lab/sessions?limit=${Math.max(1, Math.min(200, limit))}`,
  );
}

export function getPerformanceLabSession(sessionId: string) {
  return requestJson<{ session: PerformanceLabSessionDetail }>(
    `/api/performance-lab/sessions/${encodeURIComponent(sessionId)}`,
  );
}

export function listPerformanceLabAdminSessions(limit = 200) {
  return requestJson<{ sessions: PerformanceLabSessionListItem[] }>(
    `/api/performance-lab/admin/sessions?limit=${Math.max(1, Math.min(200, limit))}`,
  );
}

export function getPerformanceLabAdminSession(sessionId: string) {
  return requestJson<{ session: PerformanceLabSessionDetail }>(
    `/api/performance-lab/admin/sessions/${encodeURIComponent(sessionId)}`,
  );
}
