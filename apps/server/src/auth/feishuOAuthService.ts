import type { IncomingMessage, ServerResponse } from 'node:http';
import { serverConfig } from '../config.js';
import { createSession, upsertFeishuUser } from './sessionService.js';

type UnknownRecord = Record<string, unknown>;

export function getMissingFeishuConfigKeys() {
  const entries = {
    FEISHU_APP_ID: serverConfig.feishu.appId,
    FEISHU_APP_SECRET: serverConfig.feishu.appSecret,
  };
  return Object.entries(entries)
    .filter(([, value]) => !value)
    .map(([key]) => key);
}

export function getMissingFeishuStartConfigKeys() {
  const entries = {
    FEISHU_APP_ID: serverConfig.feishu.appId,
    FEISHU_REDIRECT_URI: serverConfig.feishu.redirectUri,
    FEISHU_AUTH_URL: serverConfig.feishu.authUrl,
  };
  return Object.entries(entries)
    .filter(([, value]) => !value)
    .map(([key]) => key);
}

export function isFeishuConfigured() {
  return getMissingFeishuConfigKeys().length === 0;
}

export function isFeishuStartConfigured() {
  return getMissingFeishuStartConfigKeys().length === 0;
}

export function buildAuthorizationUrl(state: string) {
  if (!serverConfig.feishu.authUrl || !serverConfig.feishu.appId || !serverConfig.feishu.redirectUri) {
    throw new Error('Feishu OAuth is not configured.');
  }
  const url = new URL(serverConfig.feishu.authUrl);
  url.searchParams.set('app_id', serverConfig.feishu.appId);
  url.searchParams.set('redirect_uri', serverConfig.feishu.redirectUri);
  url.searchParams.set('state', state);
  if (serverConfig.feishu.scope) url.searchParams.set('scope', serverConfig.feishu.scope);
  return url.toString();
}

function objectValue(value: unknown): UnknownRecord {
  return value && typeof value === 'object' ? (value as UnknownRecord) : {};
}

function stringValue(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function payloadData(payload: unknown) {
  const root = objectValue(payload);
  return objectValue(root.data ?? root.user ?? root);
}

async function readJsonResponse(response: Response) {
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(`Feishu request failed: ${response.status}`);
  }
  const code = (payload as UnknownRecord).code;
  if (typeof code === 'number' && code !== 0) {
    throw new Error(`Feishu request failed: ${code}`);
  }
  return payload;
}

async function getAppAccessToken() {
  if (!serverConfig.feishu.appAccessTokenUrl || !serverConfig.feishu.appId || !serverConfig.feishu.appSecret) {
    throw new Error('Feishu OAuth is not configured.');
  }
  const response = await fetch(serverConfig.feishu.appAccessTokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      app_id: serverConfig.feishu.appId,
      app_secret: serverConfig.feishu.appSecret,
    }),
  });
  const payload = await readJsonResponse(response);
  const data = payloadData(payload);
  const appAccessToken = stringValue(data.app_access_token, objectValue(data.token_info).app_access_token);
  if (!appAccessToken) throw new Error('Feishu app token response did not include app_access_token.');
  return appAccessToken;
}

export async function exchangeCodeForToken(code: string) {
  if (!serverConfig.feishu.tokenUrl) {
    throw new Error('Feishu OAuth is not configured.');
  }
  const appAccessToken = await getAppAccessToken();
  const response = await fetch(serverConfig.feishu.tokenUrl, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${appAccessToken}`,
      'content-type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      code,
    }),
  });
  const payload = await readJsonResponse(response);
  const data = payloadData(payload);
  const accessToken = stringValue(data.access_token, data.user_access_token, data.token, objectValue(data.token_info).access_token);
  const refreshToken = stringValue(data.refresh_token, objectValue(data.token_info).refresh_token);
  if (!accessToken) throw new Error('Feishu token response did not include access_token.');
  return {
    accessToken,
    refreshToken,
    expiresIn: typeof data.expires_in === 'number' ? data.expires_in : undefined,
  };
}

export async function fetchUserInfo(accessToken: string) {
  if (!serverConfig.feishu.userinfoUrl) throw new Error('Feishu OAuth is not configured.');
  const response = await fetch(serverConfig.feishu.userinfoUrl, {
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: 'application/json',
    },
  });
  const payload = await readJsonResponse(response);
  const data = payloadData(payload);
  const avatar = objectValue(data.avatar);
  return {
    feishuOpenId: stringValue(data.open_id, data.openId),
    feishuUnionId: stringValue(data.union_id, data.unionId),
    feishuUserId: stringValue(data.user_id, data.userId),
    tenantKey: stringValue(data.tenant_key, data.tenantKey),
    displayName: stringValue(data.name, data.en_name, data.nickname, data.display_name) ?? 'Feishu User',
    email: stringValue(data.email, data.enterprise_email),
    avatarUrl: stringValue(data.avatar_url, data.avatarUrl, data.avatar_thumb, avatar.avatar_url, avatar.avatar_240),
    rawProfileJson: JSON.stringify(payload),
  };
}

export async function completeFeishuLogin(
  code: string,
  request: IncomingMessage,
  response: ServerResponse,
) {
  if (!isFeishuConfigured()) throw new Error('Feishu OAuth is not configured.');
  const token = await exchangeCodeForToken(code);
  const profile = await fetchUserInfo(token.accessToken);
  const user = await upsertFeishuUser(profile);
  await createSession(user.id, 'feishu-oauth', request, response);
  return user;
}
