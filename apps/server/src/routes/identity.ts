import type { IncomingMessage, ServerResponse } from 'node:http';
import { optionalAuth } from '../auth/authMiddleware.js';
import { setWebOAuthBrowserCookie, startWebOAuthLogin } from '../auth/webOAuthService.js';
import { serverConfig } from '../config.js';
import {
  bindDeviceToCurrentUser,
  identityTelemetryStorage,
  parseDeviceIdentityInput,
} from '../services/identityTelemetryService.js';
import { readBinaryBody, sendJson } from './httpUtils.js';

const identityBodyLimitBytes = 16 * 1024;

async function readIdentityBody(request: IncomingMessage) {
  const buffer = await readBinaryBody(request, identityBodyLimitBytes);
  if (buffer.byteLength === 0) return {};
  try {
    return JSON.parse(buffer.toString('utf8')) as unknown;
  } catch {
    throw new Error('Identity request body must be valid JSON.');
  }
}

function identityFromQuery(url: URL) {
  const supported = new Set(['machine_id', 'install_id', 'version', 'host_version']);
  const unsupported = [...url.searchParams.keys()].filter((key) => !supported.has(key));
  if (unsupported.length > 0) {
    throw new Error(`Identity request contains unsupported query fields: ${unsupported.join(', ')}.`);
  }
  return parseDeviceIdentityInput({
    machine_id: url.searchParams.get('machine_id') || undefined,
    install_id: url.searchParams.get('install_id') || undefined,
    version: url.searchParams.get('version') || undefined,
    host_version: url.searchParams.get('host_version') || undefined,
  });
}

async function sendIdentityError(response: ServerResponse, error: unknown, statusCode = 400) {
  sendJson(response, statusCode, {
    ok: false,
    error: error instanceof Error ? error.message : 'Identity request failed.',
  });
}

export async function handleIdentityRoute(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
) {
  response.setHeader('cache-control', 'no-store');
  if (url.pathname === '/api/identity/status' && (request.method === 'POST' || request.method === 'GET')) {
    try {
      const device = request.method === 'POST'
        ? parseDeviceIdentityInput(await readIdentityBody(request))
        : identityFromQuery(url);
      let status = await identityTelemetryStorage.status(device);
      const currentUser = await optionalAuth(request);
      if (!status.bound && currentUser?.authSource === 'feishu-oauth') {
        status = await bindDeviceToCurrentUser(device, currentUser);
      }
      sendJson(response, 200, status);
    } catch (error) {
      await sendIdentityError(response, error);
    }
    return true;
  }

  if (url.pathname === '/api/identity/bind/start' && request.method === 'GET') {
    try {
      const device = identityFromQuery(url);
      const currentUser = await optionalAuth(request);
      if (currentUser?.authSource === 'feishu-oauth') {
        const status = await bindDeviceToCurrentUser(device, currentUser);
        sendJson(response, 200, {
          ...status,
          user: {
            id: currentUser.id,
            displayName: currentUser.displayName,
            email: currentUser.email,
            avatarUrl: currentUser.avatarUrl,
            role: currentUser.role,
            authSource: currentUser.authSource,
          },
          authMode: 'feishu-oauth',
          message: '当前飞书会话已与此安装设备绑定。',
        });
        return true;
      }
      if (!serverConfig.feishuWebOAuthEnabled && !serverConfig.idaasJwtSsoEnabled) {
        sendJson(response, 409, {
          ok: false,
          error: '服务器尚未配置可用于设备绑定的飞书/IDaaS Web OAuth。',
          missingConfigKeys: serverConfig.feishuWebOAuthMissingConfigKeys,
        });
        return true;
      }
      const result = startWebOAuthLogin({ bindingDevice: device });
      setWebOAuthBrowserCookie(response, result.browserNonce);
      sendJson(response, 200, {
        ok: true,
        bound: false,
        loginId: result.loginId,
        redirectUrl: result.redirectUrl,
        authMode: 'feishu-oauth',
        atlas: result.status,
        message: result.message,
      });
    } catch (error) {
      await sendIdentityError(response, error);
    }
    return true;
  }

  return false;
}
