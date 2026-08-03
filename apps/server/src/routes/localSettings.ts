import type { IncomingMessage, ServerResponse } from 'node:http';
import { optionalAuth } from '../auth/authMiddleware.js';
import { getLocalSettings, updateLocalSettings } from '../services/localSettingsService.js';
import { readJsonBody, sendJson } from './httpUtils.js';

type LocalSettingsInput = {
  userId?: string;
  activate?: boolean;
  performanceTestModeEnabled?: boolean;
  migrationPerformanceTestModeEnabled?: boolean;
  profile?: unknown;
  shortcutOverrides?: unknown;
  migrationShortcutOverrides?: unknown;
  photoshop?: unknown;
};

export async function handleLocalSettingsRoute(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
) {
  if (url.pathname !== '/api/local-settings') return false;
  const currentUser = await optionalAuth(request);
  const effectiveUserId = currentUser?.id ?? 'anonymous';

  if (request.method === 'GET') {
    sendJson(response, 200, await getLocalSettings(effectiveUserId));
    return true;
  }

  if (request.method === 'PUT') {
    const body = await readJsonBody<LocalSettingsInput>(request);
    // The request may not select another employee's settings. Anonymous users
    // keep only non-sensitive UI preferences; server/DCC configuration changes
    // require a session (the loopback local component gets its synthetic one).
    sendJson(response, 200, await updateLocalSettings({
      ...body,
      userId: effectiveUserId,
      ...(currentUser
        ? {}
        : {
            performanceTestModeEnabled: undefined,
            migrationPerformanceTestModeEnabled: undefined,
            photoshop: undefined,
          }),
    }));
    return true;
  }

  sendJson(response, 405, { error: 'Method not allowed.' });
  return true;
}
