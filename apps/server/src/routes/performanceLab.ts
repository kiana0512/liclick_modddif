import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { requireAuth } from '../auth/authMiddleware.js';
import type { AuthUser } from '../auth/authTypes.js';
import { canReadAllPerformanceSessions } from '../auth/performanceLabAccess.js';
import { serverConfig } from '../config.js';
import { projectRepository as defaultProjectRepository } from '../repositories/projectRepository.js';
import {
  PerformanceLabPersistenceConflictError,
  postgresControlRepository,
} from '../repositories/postgresControlRepository.js';
import { readBinaryBody, sendJson } from './httpUtils.js';

const reportSchemaVersion = 2;
const startBodyLimitBytes = 512 * 1024;
const chunkBodyLimitBytes = 2 * 1024 * 1024;
const completeBodyLimitBytes = 8 * 1024 * 1024;
const sessionIdPattern =
  /^perf_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const sha256Pattern = /^[0-9a-f]{64}$/;

type PerformanceLabRepository = NonNullable<typeof postgresControlRepository>;
type ProjectLoader = Pick<typeof defaultProjectRepository, 'load'>;
type Authenticator = typeof requireAuth;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function cleanText(value: unknown, maximum: number) {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, maximum) : undefined;
}

function parseTimestamp(value: unknown, label: string) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new Error(`${label} must be an ISO timestamp.`);
  }
  return new Date(value).toISOString();
}

async function readJsonBodyLimited(request: IncomingMessage, maximumBytes: number) {
  const raw = await readBinaryBody(request, maximumBytes);
  if (raw.byteLength === 0) return {} as Record<string, unknown>;
  const parsed = JSON.parse(raw.toString('utf8')) as unknown;
  if (!isRecord(parsed)) throw new Error('Request body must be a JSON object.');
  return parsed;
}

function sha256Json(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function isMaintainer(user: AuthUser, maintainerEmails: ReadonlySet<string>) {
  return canReadAllPerformanceSessions(user, [...maintainerEmails]);
}

function requireMaintainer(
  response: ServerResponse,
  user: AuthUser,
  maintainerEmails: ReadonlySet<string>,
) {
  if (isMaintainer(user, maintainerEmails)) return true;
  sendJson(response, 403, { error: 'Performance Lab administrator access is required.' });
  return false;
}

function adminSessionIdFromPath(pathname: string) {
  const match = /^\/api\/performance-lab\/admin\/sessions\/([^/]+)$/.exec(pathname);
  if (!match) return undefined;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return undefined;
  }
}

function sessionIdFromPath(pathname: string) {
  const match = /^\/api\/performance-lab\/sessions\/([^/]+)(?:\/(chunks|complete))?$/.exec(
    pathname,
  );
  if (!match) return undefined;
  let sessionId: string;
  try {
    sessionId = decodeURIComponent(match[1]);
  } catch {
    return undefined;
  }
  return { sessionId, action: match[2] as 'chunks' | 'complete' | undefined };
}

function assertSessionId(sessionId: string) {
  if (!sessionIdPattern.test(sessionId)) throw new Error('Invalid performance session id.');
}

async function createSession(
  request: IncomingMessage,
  response: ServerResponse,
  user: AuthUser,
  repository: PerformanceLabRepository,
  projectLoader: ProjectLoader,
) {
  const body = await readJsonBodyLimited(request, startBodyLimitBytes);
  const sessionId = cleanText(body.sessionId, 80) ?? '';
  assertSessionId(sessionId);
  const schemaVersion = Number(body.schemaVersion);
  if (schemaVersion !== reportSchemaVersion) {
    throw new Error(`Performance report schema ${reportSchemaVersion} is required.`);
  }
  const collectorVersion = cleanText(body.collectorVersion, 40);
  if (!collectorVersion) throw new Error('collectorVersion is required.');
  const startedAt = parseTimestamp(body.startedAt, 'startedAt');
  if (Date.parse(startedAt) > Date.now() + 5 * 60_000) {
    throw new Error('startedAt is too far in the future.');
  }
  const projectId = cleanText(body.projectId, 160);
  if (projectId) {
    const project = await projectLoader.load(user.id, projectId);
    if (!project) {
      sendJson(response, 404, { error: 'Project not found for the authenticated user.' });
      return;
    }
  }
  if (!isRecord(body.clientContext)) throw new Error('clientContext is required.');
  const session = await repository.createPerformanceLabSession({
    userId: user.id,
    sessionId,
    projectId,
    schemaVersion,
    collectorVersion,
    startedAt,
    clientContext: body.clientContext,
  });
  sendJson(response, 201, { session });
}

async function appendChunk(
  request: IncomingMessage,
  response: ServerResponse,
  user: AuthUser,
  sessionId: string,
  repository: PerformanceLabRepository,
) {
  const body = await readJsonBodyLimited(request, chunkBodyLimitBytes);
  const sequence = Number(body.sequence);
  const sampleCount = Number(body.sampleCount);
  if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence > 10_000_000) {
    throw new Error('sequence must be a non-negative safe integer.');
  }
  if (!Number.isSafeInteger(sampleCount) || sampleCount < 0 || sampleCount > 2_000_000) {
    throw new Error('sampleCount is invalid.');
  }
  const startedAt = parseTimestamp(body.startedAt, 'startedAt');
  const endedAt = parseTimestamp(body.endedAt, 'endedAt');
  if (Date.parse(endedAt) < Date.parse(startedAt)) {
    throw new Error('Chunk endedAt cannot precede startedAt.');
  }
  if (!isRecord(body.payload)) throw new Error('payload is required.');
  const payloadSha256 = cleanText(body.payloadSha256, 64)?.toLowerCase() ?? '';
  if (!sha256Pattern.test(payloadSha256) || sha256Json(body.payload) !== payloadSha256) {
    throw new Error('Performance chunk SHA-256 verification failed.');
  }
  const payloadBytes = Buffer.byteLength(JSON.stringify(body.payload));
  const result = await repository.appendPerformanceLabChunk({
    userId: user.id,
    sessionId,
    sequence,
    startedAt,
    endedAt,
    sampleCount,
    byteCount: payloadBytes,
    payloadSha256,
    payload: body.payload,
  });
  if (!result) {
    sendJson(response, 404, { error: 'Performance session not found.' });
    return;
  }
  sendJson(response, 200, result);
}

async function completeSession(
  request: IncomingMessage,
  response: ServerResponse,
  user: AuthUser,
  sessionId: string,
  repository: PerformanceLabRepository,
) {
  const body = await readJsonBodyLimited(request, completeBodyLimitBytes);
  const endedAt = parseTimestamp(body.endedAt, 'endedAt');
  if (!isRecord(body.summary) || !isRecord(body.report)) {
    throw new Error('summary and report are required.');
  }
  const reportSha256 = cleanText(body.reportSha256, 64)?.toLowerCase() ?? '';
  const expectedSha256 = sha256Json({ summary: body.summary, report: body.report });
  if (!sha256Pattern.test(reportSha256) || reportSha256 !== expectedSha256) {
    throw new Error('Final performance report SHA-256 verification failed.');
  }
  const session = await repository.completePerformanceLabSession({
    userId: user.id,
    sessionId,
    endedAt,
    summary: body.summary,
    report: body.report,
    reportSha256,
  });
  if (!session) {
    sendJson(response, 404, { error: 'Performance session not found.' });
    return;
  }
  sendJson(response, 200, { session });
}

async function listSessions(
  response: ServerResponse,
  user: AuthUser,
  url: URL,
  repository: PerformanceLabRepository,
  maintainerEmails: ReadonlySet<string>,
) {
  const requestedLimit = Number(url.searchParams.get('limit') ?? 100);
  const limit = Number.isSafeInteger(requestedLimit)
    ? Math.max(1, Math.min(200, requestedLimit))
    : 100;
  const sessions = await repository.listPerformanceLabSessions({
    requesterUserId: user.id,
    includeAllUsers: isMaintainer(user, maintainerEmails),
    limit,
  });
  sendJson(response, 200, {
    sessions: sessions.map(({ clientContext: _context, report: _report, ...session }) => session),
  });
}

async function getSession(
  response: ServerResponse,
  user: AuthUser,
  sessionId: string,
  repository: PerformanceLabRepository,
  maintainerEmails: ReadonlySet<string>,
) {
  const session = await repository.getPerformanceLabSession({
    requesterUserId: user.id,
    includeAllUsers: isMaintainer(user, maintainerEmails),
    sessionId,
  });
  if (!session) {
    sendJson(response, 404, { error: 'Performance session not found.' });
    return;
  }
  sendJson(response, 200, { session });
}

async function listAdminSessions(
  response: ServerResponse,
  user: AuthUser,
  url: URL,
  repository: PerformanceLabRepository,
  maintainerEmails: ReadonlySet<string>,
) {
  if (!requireMaintainer(response, user, maintainerEmails)) return;
  const beforeSessionId = url.searchParams.get('before') ?? undefined;
  if (beforeSessionId) assertSessionId(beforeSessionId);
  const requestedLimit = Number(url.searchParams.get('limit') ?? 200);
  const limit = Number.isSafeInteger(requestedLimit)
    ? Math.max(1, Math.min(200, requestedLimit))
    : 200;
  const sessions = await repository.listPerformanceLabSessions({
    requesterUserId: user.id,
    includeAllUsers: true,
    limit: limit + 1,
    beforeSessionId,
  });
  sendJson(response, 200, {
    sessions: sessions.slice(0, limit).map(({ clientContext: _context, report: _report, ...session }) => session),
    nextCursor: sessions.length > limit ? sessions[limit - 1].sessionId : undefined,
  });
}

async function getAdminSession(
  response: ServerResponse,
  user: AuthUser,
  sessionId: string,
  repository: PerformanceLabRepository,
  maintainerEmails: ReadonlySet<string>,
) {
  if (!requireMaintainer(response, user, maintainerEmails)) return;
  const session = await repository.getPerformanceLabSession({
    requesterUserId: user.id,
    includeAllUsers: true,
    sessionId,
  });
  if (!session) {
    sendJson(response, 404, { error: 'Performance session not found.' });
    return;
  }
  sendJson(response, 200, { session });
}

export function createPerformanceLabRoute(input: {
  repository?: PerformanceLabRepository;
  projectLoader?: ProjectLoader;
  authenticate?: Authenticator;
  enabled?: boolean;
  maintainerEmails?: readonly string[];
}) {
  const repository = input.repository;
  const projectLoader = input.projectLoader ?? defaultProjectRepository;
  const authenticate = input.authenticate ?? requireAuth;
  const enabled = input.enabled ?? true;
  const maintainerEmails = new Set(
    (input.maintainerEmails ?? serverConfig.performanceLabMaintainerEmails).map((email) =>
      email.trim().toLowerCase(),
    ),
  );
  return async function handlePerformanceLabRoute(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ) {
    if (!url.pathname.startsWith('/api/performance-lab')) return false;
    if (!enabled) {
      sendJson(response, 404, { error: 'Performance Lab is not enabled in this deployment.' });
      return true;
    }
    const user = await authenticate(request, response);
    if (!user) return true;
    if (!repository) {
      sendJson(response, 503, {
        error: 'Performance Lab persistence requires the Cloud PostgreSQL control plane.',
      });
      return true;
    }
    try {
      if (url.pathname === '/api/performance-lab/admin/sessions') {
        if (request.method === 'GET') {
          await listAdminSessions(response, user, url, repository, maintainerEmails);
        } else sendJson(response, 405, { error: 'Method not allowed.' });
        return true;
      }
      const adminSessionId = adminSessionIdFromPath(url.pathname);
      if (adminSessionId) {
        assertSessionId(adminSessionId);
        if (request.method === 'GET') {
          await getAdminSession(response, user, adminSessionId, repository, maintainerEmails);
        } else sendJson(response, 405, { error: 'Method not allowed.' });
        return true;
      }
      if (url.pathname === '/api/performance-lab/sessions') {
        if (request.method === 'POST') {
          await createSession(request, response, user, repository, projectLoader);
        } else if (request.method === 'GET') {
          await listSessions(response, user, url, repository, maintainerEmails);
        } else sendJson(response, 405, { error: 'Method not allowed.' });
        return true;
      }
      const target = sessionIdFromPath(url.pathname);
      if (!target) {
        sendJson(response, 404, { error: 'Performance Lab route not found.' });
        return true;
      }
      assertSessionId(target.sessionId);
      if (!target.action && request.method === 'GET') {
        await getSession(response, user, target.sessionId, repository, maintainerEmails);
        return true;
      }
      if (target.action === 'chunks' && request.method === 'POST') {
        await appendChunk(request, response, user, target.sessionId, repository);
        return true;
      }
      if (target.action === 'complete' && request.method === 'POST') {
        await completeSession(request, response, user, target.sessionId, repository);
        return true;
      }
      sendJson(response, 405, { error: 'Method not allowed.' });
    } catch (error) {
      if (error instanceof PerformanceLabPersistenceConflictError) {
        sendJson(response, 409, { error: error.message });
        return true;
      }
      if (error instanceof Error && /too large/i.test(error.message)) {
        sendJson(response, 413, { error: error.message });
        return true;
      }
      if (
        error instanceof SyntaxError ||
        (error instanceof Error &&
          /must|required|invalid|failed|cannot|too far/i.test(error.message))
      ) {
        sendJson(response, 400, {
          error: error instanceof Error ? error.message : 'Invalid request.',
        });
        return true;
      }
      throw error;
    }
    return true;
  };
}

export const handlePerformanceLabRoute = createPerformanceLabRoute({
  repository: postgresControlRepository,
  projectLoader: defaultProjectRepository,
  enabled: serverConfig.performanceLabEnabled,
  maintainerEmails: serverConfig.performanceLabMaintainerEmails,
});
