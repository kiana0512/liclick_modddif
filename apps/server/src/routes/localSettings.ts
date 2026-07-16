import type { IncomingMessage, ServerResponse } from 'node:http';
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
};

export async function handleLocalSettingsRoute(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
) {
  if (url.pathname !== '/api/local-settings') return false;

  if (request.method === 'GET') {
    sendJson(response, 200, await getLocalSettings(url.searchParams.get('userId') ?? undefined));
    return true;
  }

  if (request.method === 'PUT') {
    const body = await readJsonBody<LocalSettingsInput>(request);
    sendJson(response, 200, await updateLocalSettings(body));
    return true;
  }

  sendJson(response, 405, { error: 'Method not allowed.' });
  return true;
}
