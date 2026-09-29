import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  parseStartStorageCleanupRequest,
  parseStartStoragePurgeRequest,
} from '@liclick/contracts';
import { requireAuth } from '../auth/authMiddleware.js';
import {
  getStorageCleanupJob,
  getActiveStorageCleanupJob,
  getStorageOverview,
  getStoragePurgeJob,
  getStorageQuarantineStatus,
  startStorageCleanup,
  startStoragePurge,
  startStorageScan,
} from '../services/storageManagementService.js';
import { RequestBodyTooLargeError, getPathSegments, readJsonBody, sendJson } from './httpUtils.js';

export async function handleStorageRoute(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
) {
  const segments = getPathSegments(url);
  if (segments[1] !== 'storage') return false;
  const user = await requireAuth(request, response);
  if (!user) return true;

  if (request.method === 'GET' && segments.length === 2) {
    response.setHeader('cache-control', 'private, no-store');
    sendJson(response, 200, { overview: await getStorageOverview(user.id) });
    return true;
  }

  if (request.method === 'GET' && segments.length === 3 && segments[2] === 'quarantine') {
    response.setHeader('cache-control', 'private, no-store');
    sendJson(response, 200, { quarantine: await getStorageQuarantineStatus(user.id) });
    return true;
  }

  if (
    request.method === 'POST' &&
    segments.length === 4 &&
    segments[2] === 'quarantine' &&
    segments[3] === 'purge'
  ) {
    const quarantine = await getStorageQuarantineStatus(user.id);
    if (!quarantine.purgeSupported) {
      sendJson(response, 501, {
        error: quarantine.purgeUnavailableReason ?? 'Permanent purge is unavailable.',
        code: 'STORAGE_PURGE_UNAVAILABLE',
      });
      return true;
    }
    let input;
    try {
      input = parseStartStoragePurgeRequest(await readJsonBody<unknown>(request, 16 * 1024));
    } catch (error) {
      if (error instanceof RequestBodyTooLargeError) throw error;
      sendJson(response, 400, {
        error: error instanceof Error ? error.message : 'Invalid storage purge request.',
        code: 'INVALID_STORAGE_PURGE_REQUEST',
      });
      return true;
    }
    const job = await startStoragePurge({ userId: user.id, ...input });
    if (!job) {
      sendJson(response, 409, {
        error: 'The quarantine is empty or another storage task is active.',
        code: 'STORAGE_PURGE_NOT_READY',
      });
    } else {
      sendJson(response, job.status === 'queued' ? 202 : 200, { job });
    }
    return true;
  }

  if (
    request.method === 'GET' &&
    segments.length === 5 &&
    segments[2] === 'quarantine' &&
    segments[3] === 'purge'
  ) {
    const job = await getStoragePurgeJob(user.id, segments[4]);
    if (!job) sendJson(response, 404, { error: 'Storage purge job was not found.' });
    else {
      response.setHeader('cache-control', 'private, no-store');
      sendJson(response, 200, { job });
    }
    return true;
  }

  if (request.method === 'POST' && segments.length === 3 && segments[2] === 'scans') {
    void startStorageScan(user.id);
    const overview = await getStorageOverview(user.id);
    response.setHeader('cache-control', 'private, no-store');
    sendJson(response, 202, { accepted: true, overview });
    return true;
  }

  if (request.method === 'POST' && segments.length === 3 && segments[2] === 'cleanup') {
    let input;
    try {
      input = parseStartStorageCleanupRequest(await readJsonBody<unknown>(request, 16 * 1024));
    } catch (error) {
      if (error instanceof RequestBodyTooLargeError) throw error;
      sendJson(response, 400, {
        error: error instanceof Error ? error.message : 'Invalid storage cleanup request.',
        code: 'INVALID_STORAGE_CLEANUP_REQUEST',
      });
      return true;
    }
    const job = await startStorageCleanup({ userId: user.id, ...input });
    if (!job) {
      sendJson(response, 409, {
        error: 'Storage changed after this scan. Run a new scan before cleaning.',
        code: 'STORAGE_SCAN_STALE',
      });
    } else {
      sendJson(response, job.status === 'queued' ? 202 : 200, { job });
    }
    return true;
  }

  if (
    request.method === 'GET' &&
    segments.length === 4 &&
    segments[2] === 'cleanup' &&
    segments[3] === 'active'
  ) {
    response.setHeader('cache-control', 'private, no-store');
    sendJson(response, 200, { job: await getActiveStorageCleanupJob(user.id) });
    return true;
  }

  if (request.method === 'GET' && segments.length === 4 && segments[2] === 'cleanup') {
    const job = await getStorageCleanupJob(user.id, segments[3]);
    if (!job) sendJson(response, 404, { error: 'Storage cleanup job was not found.' });
    else {
      response.setHeader('cache-control', 'private, no-store');
      sendJson(response, 200, { job });
    }
    return true;
  }

  return false;
}
