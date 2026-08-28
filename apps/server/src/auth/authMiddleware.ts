import type { IncomingMessage, ServerResponse } from 'node:http';
import { getSessionCookie, verifySession } from './sessionService.js';
import { sendJson } from '../routes/httpUtils.js';

export async function optionalAuth(request: IncomingMessage) {
  return verifySession(getSessionCookie(request));
}

export async function requireAuth(request: IncomingMessage, response: ServerResponse) {
  const user = await optionalAuth(request);
  if (!user) {
    sendJson(response, 401, { error: 'Authentication required.' });
    return undefined;
  }
  return user;
}
