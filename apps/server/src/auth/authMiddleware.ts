import type { IncomingMessage, ServerResponse } from 'node:http';
import { setCurrentUser } from './currentUser.js';
import { getSessionCookie, upsertUser, verifySession } from './sessionService.js';
import { sendJson } from '../routes/httpUtils.js';

let localComponentUserPromise: ReturnType<typeof upsertUser> | undefined;

function getLocalComponentUser() {
  localComponentUserPromise ??= upsertUser({
    id: 'local-device',
    displayName: 'LIclick Local Device',
    email: 'local-device@liclick.local',
    authSource: 'dev-mock',
  });
  return localComponentUserPromise;
}

export async function optionalAuth(request: IncomingMessage) {
  if (process.env.LICLICK_LOCAL_COMPONENT_MODE === '1') {
    const user = await getLocalComponentUser();
    setCurrentUser(request, user);
    return user;
  }
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
