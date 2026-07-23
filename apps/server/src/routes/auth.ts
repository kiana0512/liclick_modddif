import type { IncomingMessage, ServerResponse } from 'node:http';
import { serverConfig } from '../config.js';
import { optionalAuth } from '../auth/authMiddleware.js';
import {
  getAtlasStatus,
  pollAtlasLogin,
  startAtlasLogin,
} from '../auth/atlasAuthService.js';
import { toPublicUser } from '../auth/currentUser.js';
import { loginDevUser } from '../auth/devMockAuthService.js';
import {
  clearSessionCookie,
  consumeBrowserSessionHandoff,
  createBrowserSessionHandoff,
  getSessionCookie,
  revokeSession,
  setSessionCookie,
} from '../auth/sessionService.js';
import {
  handleWebOAuthCallback,
  isWebOAuthLoginId,
  pollWebOAuthLogin,
  startWebOAuthLogin,
} from '../auth/webOAuthService.js';
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
    const shouldCheckAtlas =
      Boolean(user) ||
      (!serverConfig.feishuWebOAuthEnabled &&
        !serverConfig.idaasJwtSsoEnabled &&
        serverConfig.atlasLocalLoginEnabled &&
        serverConfig.atlasLoginMode === 'service-token');
    const atlasStatus = shouldCheckAtlas
      ? await getAtlasStatus(user?.atlasHomeDir).catch((error) => ({
          valid: false,
          message: error instanceof Error ? error.message : 'Atlas status unavailable.',
        }))
      : {
          valid: serverConfig.feishuWebOAuthEnabled || serverConfig.idaasJwtSsoEnabled || serverConfig.atlasLocalLoginEnabled,
          message:
            serverConfig.feishuWebOAuthEnabled || serverConfig.idaasJwtSsoEnabled
              ? 'IDaaS/飞书网页登录已配置。'
              : serverConfig.atlasLocalLoginEnabled
                ? '莉刻/Atlas gateway 登录已启用。'
                : '需要先完成飞书/IDaaS 登录。',
        };
    sendJson(response, 200, {
      authMode: serverConfig.authMode,
      devLoginEnabled: serverConfig.authMode === 'dev-mock',
      feishuOAuthEnabled: true,
      feishuConfigured:
        serverConfig.feishuWebOAuthEnabled || serverConfig.idaasJwtSsoEnabled || serverConfig.atlasLocalLoginEnabled,
      feishuLoginProvider: serverConfig.feishuWebOAuthEnabled
        ? 'web-oauth'
        : serverConfig.idaasJwtSsoEnabled
          ? 'idaas-jwt'
          : serverConfig.atlasLocalLoginEnabled
            ? 'atlas-cli'
            : 'not-configured',
      feishuWebOAuthBlockedReason: serverConfig.feishuWebOAuthBlockedReason || undefined,
      atlasLoginMode: serverConfig.atlasLoginMode,
      missingConfigKeys:
        serverConfig.feishuWebOAuthEnabled || serverConfig.idaasJwtSsoEnabled
          ? []
          : serverConfig.atlasLocalLoginEnabled
            ? []
          : serverConfig.feishuWebOAuthMissingConfigKeys,
      atlas: atlasStatus,
    });
    return true;
  }

  if (request.method === 'POST' && route === 'browser-handoff') {
    const code = await createBrowserSessionHandoff(getSessionCookie(request));
    if (!code) {
      sendJson(response, 401, { error: 'Authentication required.' });
      return true;
    }
    const handoffUrl = new URL(`/api/auth/browser-handoff/${encodeURIComponent(code)}`, serverConfig.publicWorkspaceUrl);
    handoffUrl.searchParams.set('redirect', serverConfig.frontendUrl);
    sendJson(response, 200, { handoffUrl: handoffUrl.toString() });
    return true;
  }

  if (request.method === 'GET' && route === 'browser-handoff' && segments[3]) {
    const sessionToken = consumeBrowserSessionHandoff(segments[3]);
    if (!sessionToken) {
      sendJson(response, 410, { error: 'This login handoff has expired. Please open Li3D from the launcher again.' });
      return true;
    }
    const requestedRedirect = url.searchParams.get('redirect') || serverConfig.frontendUrl;
    let redirectUrl = serverConfig.frontendUrl;
    try {
      const parsed = new URL(requestedRedirect);
      if (serverConfig.allowedOrigins.includes(parsed.origin)) redirectUrl = parsed.toString();
    } catch {
      redirectUrl = serverConfig.frontendUrl;
    }
    setSessionCookie(response, sessionToken);
    response.writeHead(302, { location: redirectUrl, 'cache-control': 'no-store' });
    response.end();
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

  if (request.method === 'GET' && route === 'feishu' && segments[3] === 'callback') {
    return handleWebOAuthCallback(request, response, url);
  }

  if (request.method === 'GET' && route === 'feishu' && segments[3] === 'start') {
    let result: Awaited<ReturnType<typeof startAtlasLogin>> | ReturnType<typeof startWebOAuthLogin>;
    try {
      if (serverConfig.feishuWebOAuthBlockedReason) {
        throw new Error(serverConfig.feishuWebOAuthBlockedReason);
      }
      if (serverConfig.feishuWebOAuthEnabled || serverConfig.idaasJwtSsoEnabled) {
        result = startWebOAuthLogin();
      } else if (serverConfig.atlasLocalLoginEnabled) {
        result = await startAtlasLogin(request, response);
      } else {
        throw new Error(
          `服务器未配置真实登录方式。请安装 @lilith/atlas-skillhub 或配置 Web OAuth/IDaaS。缺少 OAuth 配置：${serverConfig.feishuWebOAuthMissingConfigKeys.join(', ') || '未知'}`,
        );
      }
    } catch (error) {
      sendJson(response, 409, {
        error: error instanceof Error ? error.message : '莉刻/Atlas 登录不可用。',
        atlasLoginMode: serverConfig.atlasLoginMode,
      });
      return true;
    }
    const user = 'user' in result ? result.user : undefined;
    const loginId = 'loginId' in result ? result.loginId : undefined;
    sendJson(response, 200, {
      user: user ? toPublicUser(user) : undefined,
      loginId,
      redirectUrl: 'redirectUrl' in result ? result.redirectUrl : undefined,
      authMode: 'feishu-oauth',
      atlas: result.status,
      message: result.message ?? '莉刻/Atlas 登录已可用。',
    });
    return true;
  }

  if (request.method === 'GET' && route === 'feishu' && segments[3] === 'poll' && segments[4]) {
    try {
      if (!isWebOAuthLoginId(segments[4]) && !serverConfig.atlasLocalLoginEnabled) {
        throw new Error('莉刻/Atlas gateway 登录已禁用。');
      }
      const result = isWebOAuthLoginId(segments[4])
        ? pollWebOAuthLogin(segments[4])
        : await pollAtlasLogin(segments[4], request, response);
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
