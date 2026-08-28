import type { IncomingMessage, ServerResponse } from 'node:http';
import { optionalAuth } from '../auth/authMiddleware.js';
import {
  feishuIdentityFromAuthUser,
  identityTelemetryStorage,
  parseTelemetryBatch,
} from '../services/identityTelemetryService.js';
import { readBinaryBody, sendJson } from './httpUtils.js';

const telemetryBodyLimitBytes = 128 * 1024;
const telemetryBatchLimit = 20;

export async function handleEventsRoute(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
) {
  if (url.pathname !== '/api/events') return false;
  response.setHeader('cache-control', 'no-store');
  if (request.method !== 'POST') {
    sendJson(response, 405, { ok: false, error: 'Method not allowed.' });
    return true;
  }
  try {
    const buffer = await readBinaryBody(request, telemetryBodyLimitBytes);
    if (buffer.byteLength === 0) throw new Error('Telemetry request body is required.');
    let payload: unknown;
    try {
      payload = JSON.parse(buffer.toString('utf8'));
    } catch {
      throw new Error('Telemetry request body must be valid JSON.');
    }
    const events = parseTelemetryBatch(payload, telemetryBatchLimit);
    const currentUser = await optionalAuth(request);
    const identityOverride = currentUser?.authSource === 'feishu-oauth'
      ? feishuIdentityFromAuthUser(currentUser)
      : undefined;
    sendJson(response, 200, await identityTelemetryStorage.ingest(events, identityOverride));
  } catch (error) {
    sendJson(response, 400, {
      ok: false,
      error: error instanceof Error ? error.message : 'Telemetry request failed.',
    });
  }
  return true;
}
