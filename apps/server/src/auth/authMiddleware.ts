import type { IncomingMessage, ServerResponse } from 'node:http';
import { setCurrentUser } from './currentUser.js';
import { getSessionCookie, verifySession } from './sessionService.js';
import { sendJson } from '../routes/httpUtils.js';

export async function optionalAuth(request: IncomingMessage) {
  const user = await verifySession(getSessionCookie(request));
  if (user) setCurrentUser(request, user);
  return user;
}

export async function requireAuth(request: IncomingMessage, response: ServerResponse) {
  const user = await optionalAuth(request);
  if (!user) {
    sendJson(response, 401, { error: 'Authentication required.' });
    return undefined;
  }
  return user;
}
