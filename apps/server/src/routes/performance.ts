import type { IncomingMessage, ServerResponse } from 'node:http';
import { getNativePerformanceSnapshot } from '../services/nativePerformanceService.js';
import { sendJson } from './httpUtils.js';

function isLoopbackAddress(address: string | undefined) {
  return (
    !address ||
    address === '127.0.0.1' ||
    address === '::1' ||
    address === '::ffff:127.0.0.1'
  );
}

export async function handlePerformanceRoute(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
) {
  if (url.pathname !== '/api/performance/native-snapshot') return false;
  if (!isLoopbackAddress(request.socket.remoteAddress)) {
    sendJson(response, 403, { error: 'Native performance telemetry is loopback-only.' });
    return true;
  }
  if (request.method !== 'GET') {
    sendJson(response, 405, { error: 'Method not allowed.' });
    return true;
  }
  sendJson(response, 200, await getNativePerformanceSnapshot());
  return true;
}
