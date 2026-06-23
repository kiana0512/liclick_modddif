import type { IncomingMessage, ServerResponse } from 'node:http';
import { serverConfig } from '../config.js';
import { optionalAuth } from '../auth/authMiddleware.js';
import { getAtlasStatus, pollAtlasLogin, startAtlasLogin } from '../auth/atlasAuthService.js';
import { toPublicUser } from '../auth/currentUser.js';
import { loginDevUser } from '../auth/devMockAuthService.js';
import { clearSessionCookie, getSessionCookie, revokeSession } from '../auth/sessionService.js';
import { getPathSegments, readJsonBody, sendJson } from './httpUtils.js';

export async function handleAuthRoute(request: IncomingMessage, response: ServerResponse, url: URL) {
  const segments = getPathSegments(url);
  if (segments[0] !== 'api' || segments[1] !== 'auth') return false;
  const route = segments[2];

  if (request.method === 'GET' && route === 'me') {
    const user = await optionalAuth(request);
    sendJson(response, 200, {
      authenticated: Boolean(user),
      authMode: serverConfig.authMode,
      user: user ? toPublicUser(user) : undefined,
    });
    return true;
  }

  if (request.method === 'GET' && route === 'provider-status') {
    const user = await optionalAuth(request);
    const atlasStatus = user
      ? await getAtlasStatus(user.atlasHomeDir).catch((error) => ({
          valid: false,
          message: error instanceof Error ? error.message : 'Atlas status unavailable.',
        }))
      : {
          valid: false,
          message: '需要先完成飞书/IDaaS 登录。',
        };
    sendJson(response, 200, {
      authMode: serverConfig.authMode,
      devLoginEnabled: serverConfig.authMode === 'dev-mock',
      feishuOAuthEnabled: true,
      feishuConfigured: atlasStatus.valid,
      atlasLoginMode: serverConfig.atlasLoginMode,
      missingConfigKeys: [],
      atlas: atlasStatus,
    });
    return true;
  }

  if (request.method === 'POST' && route === 'dev-login') {
    if (serverConfig.authMode !== 'dev-mock') {
      sendJson(response, 403, { error: 'Dev login is disabled.' });
      return true;
    }
    const body = await readJsonBody<{ displayName?: string; email?: string }>(request);
    const user = await loginDevUser(body, request, response);
    sendJson(response, 200, { user: toPublicUser(user) });
    return true;
  }

  if (request.method === 'GET' && route === 'feishu' && segments[3] === 'start') {
    let result: Awaited<ReturnType<typeof startAtlasLogin>>;
    try {
      result = await startAtlasLogin(request, response);
    } catch (error) {
      sendJson(response, 409, {
        error: error instanceof Error ? error.message : '莉刻/Atlas 登录不可用。',
        atlasLoginMode: serverConfig.atlasLoginMode,
      });
      return true;
    }
    sendJson(response, 200, {
      user: result.user ? toPublicUser(result.user) : undefined,
      loginId: 'loginId' in result ? result.loginId : undefined,
      redirectUrl: 'redirectUrl' in result ? result.redirectUrl : undefined,
      authMode: 'feishu-oauth',
      atlas: result.status,
      message: result.message ?? '莉刻/Atlas 登录已可用。',
    });
    return true;
  }

  if (request.method === 'GET' && route === 'feishu' && segments[3] === 'poll' && segments[4]) {
    try {
      const result = await pollAtlasLogin(segments[4], request, response);
      sendJson(response, 200, {
        ...result,
        user: result.user ? toPublicUser(result.user) : undefined,
        authMode: 'feishu-oauth',
      });
    } catch (error) {
      sendJson(response, 409, {
        error: error instanceof Error ? error.message : '飞书/IDaaS 登录任务不可用。',
        atlasLoginMode: serverConfig.atlasLoginMode,
      });
    }
    return true;
  }

  if (request.method === 'POST' && route === 'logout') {
    await revokeSession(getSessionCookie(request));
    clearSessionCookie(response);
    sendJson(response, 200, { success: true });
    return true;
  }

  return false;
}
