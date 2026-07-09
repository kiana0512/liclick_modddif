import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { serverConfig } from '../config.js';
import type { AuthUser } from './authTypes.js';
import { createSession, upsertUser } from './sessionService.js';

type PendingWebOAuthLogin = {
  id: string;
  provider: 'web-oauth' | 'idaas-sp';
  state: string;
  startedAt: number;
  completedAt?: number;
  user?: AuthUser;
  error?: string;
};

type TokenResponse = {
  access_token?: string;
  id_token?: string;
  token_type?: string;
  expires_in?: number;
  refresh_token?: string;
  [key: string]: unknown;
};

type OAuthClaims = {
  sub?: string;
  open_id?: string;
  openid?: string;
  union_id?: string;
  unionid?: string;
  user_id?: string;
  email?: string;
  name?: string;
  username?: string;
  display_name?: string;
  avatar_url?: string;
  picture?: string;
  data?: OAuthClaims;
  user?: OAuthClaims;
  userinfo?: OAuthClaims;
};

const pendingWebOAuthLogins = new Map<string, PendingWebOAuthLogin>();
const pendingWebOAuthByState = new Map<string, PendingWebOAuthLogin>();
const pendingWebOAuthTtlMs = 10 * 60 * 1000;

function prunePendingWebOAuthLogins() {
  const now = Date.now();
  for (const [id, login] of pendingWebOAuthLogins) {
    if (now - login.startedAt > pendingWebOAuthTtlMs) {
      pendingWebOAuthLogins.delete(id);
      pendingWebOAuthByState.delete(login.state);
    }
  }
}

function publicWorkspaceBase() {
  const publicUrl = new URL(serverConfig.publicWorkspaceUrl);
  const pathname = serverConfig.publicPath || publicUrl.pathname;
  publicUrl.pathname = `/${pathname.split('/').filter(Boolean).join('/')}`;
  publicUrl.search = '';
  publicUrl.hash = '';
  return publicUrl.toString().replace(/\/$/, '');
}

function oauthRedirectUrl() {
  return serverConfig.feishuWebOAuth.redirectUrl || `${publicWorkspaceBase()}/api/auth/feishu/callback`;
}

function isLoopbackCallback(value: string) {
  try {
    const url = new URL(value);
    return ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname);
  } catch {
    return false;
  }
}

function idaasServiceUrl() {
  const serviceUrl = serverConfig.idaasJwtSso.serviceUrl || oauthRedirectUrl();
  if (isLoopbackCallback(serviceUrl) && !serverConfig.idaasJwtSso.serviceUrl) {
    throw new Error(
      `IDaaS SP 登录不能使用未登记的本机回跳地址 ${serviceUrl}。请把 IDAAS_SP_SERVICE_URL 配成 IDaaS 后台已登记的 Service URL，或使用已登记的公网/内网访问地址。`,
    );
  }
  return serviceUrl;
}

function decodeJwtClaims(token?: string) {
  if (!token) return {};
  const parts = token.split('.');
  if (parts.length < 2) return {};
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as OAuthClaims;
  } catch {
    return {};
  }
}

function avatarDataUrl(displayName: string, email?: string) {
  const hue = Math.abs([...`${displayName}${email ?? ''}`].reduce((sum, char) => sum + char.charCodeAt(0), 0)) % 360;
  const initial = (displayName.trim() || email?.trim() || 'L').slice(0, 1).toUpperCase();
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96"><defs><linearGradient id="g" x1="0" x2="1" y1="0" y2="1"><stop stop-color="hsl(${hue} 88% 62%)"/><stop offset="1" stop-color="hsl(${(hue + 54) % 360} 78% 56%)"/></linearGradient></defs><rect width="96" height="96" rx="48" fill="url(#g)"/><text x="50%" y="54%" text-anchor="middle" dominant-baseline="middle" font-family="Arial, sans-serif" font-size="42" font-weight="700" fill="white">${initial}</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function normalizeClaims(payload?: OAuthClaims) {
  if (!payload) return {};
  return {
    ...payload,
    ...(typeof payload.data === 'object' ? payload.data : {}),
    ...(typeof payload.user === 'object' ? payload.user : {}),
    ...(typeof payload.userinfo === 'object' ? payload.userinfo : {}),
  };
}

function extractProfile(token: TokenResponse, userInfo?: OAuthClaims) {
  const claims = { ...decodeJwtClaims(token.id_token), ...normalizeClaims(userInfo) };
  const externalId =
    claims.union_id ?? claims.unionid ?? claims.open_id ?? claims.openid ?? claims.user_id ?? claims.sub ?? claims.email;
  const email = claims.email;
  const displayName = claims.name ?? claims.display_name ?? claims.username ?? email ?? externalId ?? 'Liclick User';
  return {
    externalId,
    email,
    displayName,
    avatarUrl: claims.avatar_url ?? claims.picture ?? avatarDataUrl(displayName, email),
  };
}

async function exchangeCodeForToken(code: string) {
  const config = serverConfig.feishuWebOAuth;
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: oauthRedirectUrl(),
  });
  const headers: Record<string, string> = {
    accept: 'application/json',
    'content-type': 'application/x-www-form-urlencoded',
  };

  if (config.tokenAuthMethod === 'client_secret_basic') {
    headers.authorization = `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')}`;
    body.set('client_id', config.clientId);
  } else {
    body.set('client_id', config.clientId);
    if (config.clientSecret) body.set('client_secret', config.clientSecret);
  }

  const response = await fetch(config.tokenUrl, {
    method: 'POST',
    headers,
    body,
  });
  const payload = (await response.json().catch(() => ({}))) as TokenResponse & { error?: string; error_description?: string };
  if (!response.ok || !payload.access_token) {
    throw new Error(payload.error_description ?? payload.error ?? `OAuth token exchange failed: ${response.status}`);
  }
  return payload;
}

async function fetchUserInfo(accessToken?: string) {
  if (!accessToken || !serverConfig.feishuWebOAuth.userInfoUrl) return undefined;
  const response = await fetch(serverConfig.feishuWebOAuth.userInfoUrl, {
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${accessToken}`,
    },
  });
  if (!response.ok) return undefined;
  const payload = (await response.json().catch(() => undefined)) as OAuthClaims | undefined;
  return normalizeClaims(payload) as OAuthClaims;
}

function callbackHtml(success: boolean, message: string) {
  const safeMessage = message.replace(/[&<>"']/g, (char) => {
    if (char === '&') return '&amp;';
    if (char === '<') return '&lt;';
    if (char === '>') return '&gt;';
    if (char === '"') return '&quot;';
    return '&#39;';
  });
  return `<!doctype html><meta charset="utf-8"><title>Liclick 登录${success ? '成功' : '失败'}</title><body style="font-family:Arial,'Microsoft YaHei',sans-serif;padding:40px;color:#111"><h2>Liclick 登录${success ? '成功' : '失败'}</h2><p>${safeMessage}</p><script>try{window.opener&&window.opener.postMessage({type:'liclick-auth-callback',success:${success ? 'true' : 'false'}},'*');}catch(e){}${success ? 'setTimeout(()=>window.close(),900);' : ''}</script></body>`;
}

export function isWebOAuthLoginId(loginId: string) {
  return pendingWebOAuthLogins.has(loginId) || loginId.startsWith('web-oauth-');
}

export function startWebOAuthLogin() {
  if (!serverConfig.feishuWebOAuthEnabled && !serverConfig.idaasJwtSsoEnabled) {
    throw new Error('服务器未配置 IDaaS/飞书网页登录。');
  }
  prunePendingWebOAuthLogins();
  const id = `web-oauth-${randomUUID()}`;
  const state = randomUUID();
  const login: PendingWebOAuthLogin = {
    id,
    provider: serverConfig.feishuWebOAuthEnabled ? 'web-oauth' : 'idaas-sp',
    state,
    startedAt: Date.now(),
  };
  pendingWebOAuthLogins.set(id, login);
  pendingWebOAuthByState.set(state, login);

  let redirectUrl: string;
  if (serverConfig.feishuWebOAuthEnabled) {
    const url = new URL(serverConfig.feishuWebOAuth.authorizeUrl);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', serverConfig.feishuWebOAuth.clientId);
    url.searchParams.set('redirect_uri', oauthRedirectUrl());
    url.searchParams.set('state', state);
    if (serverConfig.feishuWebOAuth.scope) url.searchParams.set('scope', serverConfig.feishuWebOAuth.scope);
    for (const [key, value] of Object.entries(serverConfig.feishuWebOAuth.extraAuthorizeParams)) {
      url.searchParams.set(key, value);
    }
    redirectUrl = url.toString();
  } else {
    const url = new URL(serverConfig.idaasJwtSso.url);
    url.searchParams.set('redirect_uri', idaasServiceUrl());
    url.searchParams.set('state', state);
    if (serverConfig.idaasJwtSso.enterpriseId) {
      url.searchParams.set('enterpriseId', serverConfig.idaasJwtSso.enterpriseId);
    }
    redirectUrl = url.toString();
  }
  return {
    loginId: id,
    redirectUrl,
    status: { valid: false, message: '请在弹出的 IDaaS/飞书页面完成授权。' },
    message: '已启动 IDaaS/飞书网页登录。授权完成后会自动返回 Liclick。',
  };
}

export async function handleWebOAuthCallback(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
) {
  const state = url.searchParams.get('state') ?? '';
  const code = url.searchParams.get('code') ?? '';
  const idToken =
    url.searchParams.get('id_token') ??
    url.searchParams.get('token') ??
    url.searchParams.get('jwt') ??
    url.searchParams.get('assertion') ??
    '';
  const error = url.searchParams.get('error') ?? '';
  const login =
    pendingWebOAuthByState.get(state) ??
    (!state && (code || idToken) && pendingWebOAuthLogins.size === 1
      ? [...pendingWebOAuthLogins.values()][0]
      : undefined);
  if (!login) {
    response.writeHead(409, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    response.end(callbackHtml(false, '登录任务已过期，请回到 Liclick 重新点击飞书登录。'));
    return true;
  }
  try {
    if (error) throw new Error(url.searchParams.get('error_description') ?? error);
    if (login.provider === 'idaas-sp' && !idToken) {
      throw new Error('IDaaS 回调缺少 JWT token。请确认 Service URL 指向 Liclick 回调，且 IDaaS 应用使用 JWT 回跳。');
    }
    if (login.provider === 'web-oauth' && !code && !idToken) {
      throw new Error('飞书 OAuth 回调缺少 code 或 id_token。');
    }
    const token = idToken
      ? ({ id_token: idToken, access_token: idToken } satisfies TokenResponse)
      : await exchangeCodeForToken(code);
    const userInfo = idToken || login.provider === 'idaas-sp' ? undefined : await fetchUserInfo(token.access_token);
    const profile = extractProfile(token, userInfo);
    if (!profile.externalId) throw new Error('IDaaS/飞书没有返回可识别的用户 ID。');
    const user = await upsertUser({
      id: `feishu-${String(profile.externalId).toLowerCase()}`,
      displayName: profile.displayName,
      email: profile.email,
      avatarUrl: profile.avatarUrl,
      authSource: 'feishu-oauth',
    });
    await createSession(user.id, 'feishu-oauth', request, response);
    login.user = user;
    login.completedAt = Date.now();
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    response.end(callbackHtml(true, '授权已完成，可以回到 Liclick 页面继续使用。'));
  } catch (callbackError) {
    login.error = callbackError instanceof Error ? callbackError.message : 'Web OAuth 登录失败。';
    response.writeHead(409, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    response.end(callbackHtml(false, login.error));
  }
  return true;
}

export function pollWebOAuthLogin(loginId: string) {
  prunePendingWebOAuthLogins();
  const login = pendingWebOAuthLogins.get(loginId);
  if (!login) throw new Error('登录任务已过期，请重新点击飞书登录。');
  if (login.error) {
    pendingWebOAuthByState.delete(login.state);
    pendingWebOAuthLogins.delete(login.id);
    throw new Error(login.error);
  }
  if (login.user) {
    pendingWebOAuthByState.delete(login.state);
    pendingWebOAuthLogins.delete(login.id);
    return {
      done: true,
      user: login.user,
      status: { valid: true, message: 'Web OAuth 登录完成。' },
      message: '飞书登录成功。',
    };
  }
  return {
    done: false,
    loginId,
    status: { valid: false, message: '等待 IDaaS/飞书授权完成。' },
    message: '等待 IDaaS/飞书授权完成。',
  };
}
