/* global TextEncoder, TextDecoder, Headers, Response, Request, URL, ReadableStream, crypto, fetch, btoa, atob, console */
const encoder = new TextEncoder();
const oauthCookieName = 'li3d_oauth_state';
const sessionCookieName = 'li3d_session';
const oauthTtlSeconds = 10 * 60;
const sessionTtlSeconds = 7 * 24 * 60 * 60;
const installerRoute = '/downloads/LIclick-3D-Texture-Local-Component-Setup.exe';
const installerFilename = 'LIclick 3D Texture Local Component Setup.exe';
const installerContentType = 'application/vnd.microsoft.portable-executable';
const installerBytes = 25_270_801;
const installerSha256 = 'c6bce970c4384c42c3f2764da47226fb4a81e295055438a5e6c6c381cf9a551e';
const installerParts = [
  '/downloads/local-component/part-001.bin',
  '/downloads/local-component/part-002.bin',
  '/downloads/local-component/part-003.bin',
  '/downloads/local-component/part-004.bin',
  '/downloads/local-component/part-005.bin',
  '/downloads/local-component/part-006.bin',
  '/downloads/local-component/part-007.bin',
];

function installerStream(request, env) {
  let partIndex = 0;
  let reader;
  return new ReadableStream({
    async pull(controller) {
      try {
        while (partIndex < installerParts.length) {
          if (!reader) {
            const partUrl = new URL(installerParts[partIndex], request.url);
            const response = await env.ASSETS.fetch(new Request(partUrl));
            if (!response.ok || !response.body) {
              throw new Error(`Installer part ${partIndex + 1} is unavailable.`);
            }
            reader = response.body.getReader();
          }
          const result = await reader.read();
          if (!result.done) {
            controller.enqueue(result.value);
            return;
          }
          reader = undefined;
          partIndex += 1;
        }
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel(reason) {
      await reader?.cancel(reason);
    },
  });
}

function serveInstaller(request, env) {
  const headers = new Headers({
    'content-type': installerContentType,
    'content-disposition': `attachment; filename="LIclick-3D-Texture-Local-Component-Setup.exe"; filename*=UTF-8''${encodeURIComponent(installerFilename)}`,
    'content-length': String(installerBytes),
    'cache-control': 'no-store',
    'x-li3d-installer-sha256': installerSha256,
  });
  if (request.method === 'HEAD') return new Response(null, { headers });
  return new Response(installerStream(request, env), { headers });
}

function json(payload, status = 200, headers = undefined) {
  const responseHeaders = new Headers(headers);
  responseHeaders.set('content-type', 'application/json; charset=utf-8');
  responseHeaders.set('cache-control', 'no-store');
  return new Response(JSON.stringify(payload), { status, headers: responseHeaders });
}

function randomBase64Url(byteLength = 32) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

function bytesToBase64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlToBytes(value) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function parseCookies(request) {
  const result = {};
  const header = request.headers.get('cookie') ?? '';
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (!key) continue;
    try {
      result[key] = decodeURIComponent(value);
    } catch {
      result[key] = value;
    }
  }
  return result;
}

function secureCookie(name, value, maxAge) {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

function clearCookie(name) {
  return `${name}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

async function importHmacKey(secret) {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

async function signJson(payload, secret) {
  const body = bytesToBase64Url(encoder.encode(JSON.stringify(payload)));
  const key = await importHmacKey(secret);
  const signature = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, encoder.encode(body)),
  );
  return `${body}.${bytesToBase64Url(signature)}`;
}

async function verifyJson(value, secret) {
  if (!value || !secret) return undefined;
  const separator = value.lastIndexOf('.');
  if (separator <= 0) return undefined;
  const body = value.slice(0, separator);
  const signature = value.slice(separator + 1);
  try {
    const key = await importHmacKey(secret);
    const valid = await crypto.subtle.verify(
      'HMAC',
      key,
      base64UrlToBytes(signature),
      encoder.encode(body),
    );
    if (!valid) return undefined;
    return JSON.parse(new TextDecoder().decode(base64UrlToBytes(body)));
  } catch {
    return undefined;
  }
}

async function sha256Base64Url(value) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
  return bytesToBase64Url(digest);
}

function requiredConfig(env) {
  const required = [
    ['FEISHU_OAUTH_CLIENT_ID', env.FEISHU_OAUTH_CLIENT_ID],
    ['FEISHU_OAUTH_CLIENT_SECRET', env.FEISHU_OAUTH_CLIENT_SECRET],
    ['FEISHU_OAUTH_REDIRECT_URL', env.FEISHU_OAUTH_REDIRECT_URL],
    ['LI3D_SESSION_SECRET', env.LI3D_SESSION_SECRET],
  ];
  return required.filter(([, value]) => !value).map(([key]) => key);
}

function publicUser(user) {
  if (!user) return undefined;
  return {
    id: user.id,
    displayName: user.displayName,
    email: user.email,
    avatarUrl: user.avatarUrl,
    role: user.role ?? 'artist',
    authSource: 'feishu-oauth',
  };
}

async function readSession(request, env) {
  const signed = parseCookies(request)[sessionCookieName];
  const session = await verifyJson(signed, env.LI3D_SESSION_SECRET);
  if (!session || typeof session.exp !== 'number' || session.exp <= Date.now()) return undefined;
  if (!session.user || typeof session.user.id !== 'string') return undefined;
  return session.user;
}

async function createSessionCookie(user, env) {
  const token = await signJson(
    { v: 1, exp: Date.now() + sessionTtlSeconds * 1000, user },
    env.LI3D_SESSION_SECRET,
  );
  return secureCookie(sessionCookieName, token, sessionTtlSeconds);
}

function oauthEndpoints(env) {
  return {
    authorize:
      env.FEISHU_OAUTH_AUTHORIZE_URL ??
      'https://accounts.feishu.cn/open-apis/authen/v1/authorize',
    token:
      env.FEISHU_OAUTH_TOKEN_URL ??
      'https://open.feishu.cn/open-apis/authen/v2/oauth/token',
    userInfo:
      env.FEISHU_OAUTH_USERINFO_URL ??
      'https://open.feishu.cn/open-apis/authen/v1/user_info',
  };
}

async function startOAuth(request, env) {
  const missingConfigKeys = requiredConfig(env);
  if (missingConfigKeys.length > 0) {
    return json(
      { error: '飞书登录服务尚未完成配置。', missingConfigKeys },
      503,
    );
  }

  const state = randomBase64Url(24);
  const verifier = randomBase64Url(32);
  const loginId = `web-oauth-${crypto.randomUUID()}`;
  const pending = await signJson(
    { v: 1, state, verifier, loginId, iat: Date.now() },
    env.LI3D_SESSION_SECRET,
  );
  const redirectUrl = new URL(oauthEndpoints(env).authorize);
  redirectUrl.searchParams.set('response_type', 'code');
  redirectUrl.searchParams.set('client_id', env.FEISHU_OAUTH_CLIENT_ID);
  redirectUrl.searchParams.set('redirect_uri', env.FEISHU_OAUTH_REDIRECT_URL);
  redirectUrl.searchParams.set('state', state);
  redirectUrl.searchParams.set('code_challenge', await sha256Base64Url(verifier));
  redirectUrl.searchParams.set('code_challenge_method', 'S256');
  if (env.FEISHU_OAUTH_SCOPE) {
    redirectUrl.searchParams.set('scope', env.FEISHU_OAUTH_SCOPE);
  }

  const headers = new Headers();
  headers.append('set-cookie', secureCookie(oauthCookieName, pending, oauthTtlSeconds));
  return json(
    {
      ok: true,
      bound: false,
      loginId,
      redirectUrl: redirectUrl.toString(),
      authMode: 'feishu-oauth',
      message: '飞书授权窗口已打开，请完成企业账号登录。',
    },
    200,
    headers,
  );
}

async function exchangeCode(code, verifier, env) {
  const response = await fetch(oauthEndpoints(env).token, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      code,
      redirect_uri: env.FEISHU_OAUTH_REDIRECT_URL,
      client_id: env.FEISHU_OAUTH_CLIENT_ID,
      client_secret: env.FEISHU_OAUTH_CLIENT_SECRET,
      code_verifier: verifier,
    }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.code || !payload.access_token) {
    throw new Error(
      payload.error_description ??
        payload.msg ??
        payload.error ??
        `OAuth token exchange failed: ${response.status}`,
    );
  }
  return payload;
}

async function fetchFeishuUser(accessToken, env) {
  const response = await fetch(oauthEndpoints(env).userInfo, {
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${accessToken}`,
    },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.code) {
    throw new Error(payload.msg ?? `OAuth user info request failed: ${response.status}`);
  }
  const profile = {
    ...payload,
    ...(payload.data && typeof payload.data === 'object' ? payload.data : {}),
  };
  const externalId =
    profile.union_id ??
    profile.user_id ??
    profile.open_id ??
    profile.sub ??
    profile.email ??
    profile.enterprise_email;
  if (!externalId) throw new Error('飞书没有返回可识别的用户 ID。');
  const email = profile.enterprise_email ?? profile.email;
  const displayName =
    profile.name ?? profile.en_name ?? profile.display_name ?? email ?? String(externalId);
  return {
    id: `feishu-${String(externalId).toLowerCase()}`,
    displayName,
    email,
    avatarUrl:
      profile.avatar_url ??
      profile.avatar_big ??
      profile.avatar_middle ??
      profile.avatar_thumb,
    role: 'artist',
    authSource: 'feishu-oauth',
  };
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => {
    if (character === '&') return '&amp;';
    if (character === '<') return '&lt;';
    if (character === '>') return '&gt;';
    if (character === '"') return '&quot;';
    return '&#39;';
  });
}

function callbackPage(success, message, headers) {
  const title = success ? 'Li3D 飞书登录成功' : 'Li3D 飞书登录失败';
  const body = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><body style="margin:0;background:#070815;color:#fff;font-family:Arial,'Microsoft YaHei',sans-serif;display:grid;min-height:100vh;place-items:center"><main style="max-width:560px;padding:40px;border:1px solid #ffffff24;border-radius:20px;background:#111226"><h1 style="margin:0 0 16px;font-size:26px">${title}</h1><p style="margin:0;color:#d7d7e8;line-height:1.7">${escapeHtml(message)}</p></main><script>${success ? 'setTimeout(()=>window.close(),700);' : ''}</script></body></html>`;
  const responseHeaders = new Headers(headers);
  responseHeaders.set('content-type', 'text/html; charset=utf-8');
  responseHeaders.set('cache-control', 'no-store');
  return new Response(body, { status: success ? 200 : 409, headers: responseHeaders });
}

async function oauthCallback(request, env) {
  const url = new URL(request.url);
  const headers = new Headers();
  headers.append('set-cookie', clearCookie(oauthCookieName));
  try {
    const pendingToken = parseCookies(request)[oauthCookieName];
    const pending = await verifyJson(pendingToken, env.LI3D_SESSION_SECRET);
    if (
      !pending ||
      typeof pending.state !== 'string' ||
      typeof pending.verifier !== 'string' ||
      typeof pending.iat !== 'number' ||
      Date.now() - pending.iat > oauthTtlSeconds * 1000
    ) {
      throw new Error('登录任务已过期，请返回 Li3D 重新点击飞书登录。');
    }
    const state = url.searchParams.get('state') ?? '';
    if (state !== pending.state) throw new Error('飞书登录状态校验失败，请重新登录。');
    const providerError = url.searchParams.get('error');
    if (providerError) {
      throw new Error(url.searchParams.get('error_description') ?? providerError);
    }
    const code = url.searchParams.get('code') ?? '';
    if (!code) throw new Error('飞书回调缺少授权码。');
    const token = await exchangeCode(code, pending.verifier, env);
    const user = await fetchFeishuUser(token.access_token, env);
    headers.append('set-cookie', await createSessionCookie(user, env));
    return callbackPage(true, `已登录为 ${user.displayName}，窗口将自动关闭。`, headers);
  } catch (error) {
    return callbackPage(
      false,
      error instanceof Error ? error.message : '飞书登录失败，请重试。',
      headers,
    );
  }
}

async function handleApi(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method.toUpperCase();

  if (method === 'GET' && path === '/api/auth/provider-status') {
    const missingConfigKeys = requiredConfig(env);
    return json({
      authMode: 'feishu-oauth',
      devLoginEnabled: false,
      feishuOAuthEnabled: missingConfigKeys.length === 0,
      feishuConfigured: missingConfigKeys.length === 0,
      feishuLoginProvider: missingConfigKeys.length === 0 ? 'web-oauth' : 'not-configured',
      missingConfigKeys,
    });
  }

  if (method === 'GET' && path === '/api/auth/me') {
    const user = await readSession(request, env);
    return json({
      authenticated: Boolean(user),
      authMode: 'feishu-oauth',
      user: publicUser(user),
    });
  }

  if (method === 'POST' && path === '/api/auth/logout') {
    const headers = new Headers();
    headers.append('set-cookie', clearCookie(sessionCookieName));
    return json({ success: true }, 200, headers);
  }

  if (method === 'GET' && path === '/api/auth/feishu/start') {
    return startOAuth(request, env);
  }

  if (method === 'GET' && path === '/api/auth/feishu/callback') {
    return oauthCallback(request, env);
  }

  if (method === 'GET' && path.startsWith('/api/auth/feishu/poll/')) {
    const user = await readSession(request, env);
    return json({
      done: Boolean(user),
      user: publicUser(user),
      authMode: 'feishu-oauth',
      message: user ? '飞书登录成功。' : '等待飞书授权完成。',
    });
  }

  if ((method === 'GET' || method === 'POST') && path === '/api/identity/status') {
    const user = await readSession(request, env);
    return json({
      ok: true,
      bound: Boolean(user),
      user_name: user?.displayName,
      email: user?.email,
    });
  }

  if (method === 'GET' && path === '/api/identity/bind/start') {
    const user = await readSession(request, env);
    if (user) {
      return json({
        ok: true,
        bound: true,
        user: publicUser(user),
        authMode: 'feishu-oauth',
        message: '当前飞书会话已经绑定到此浏览器。',
      });
    }
    return startOAuth(request, env);
  }

  if (method === 'POST' && path === '/api/events') {
    const body = await request.json().catch(() => ({}));
    const accepted = Array.isArray(body.events) ? body.events.length : 0;
    return json({ ok: true, accepted }, 202);
  }

  return json({ error: 'API route not found.' }, 404);
}

async function serveSite(request, env) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method Not Allowed', { status: 405 });
  }
  const response = await env.ASSETS.fetch(request);
  if (response.status !== 404) return response;
  const accept = request.headers.get('accept') ?? '';
  if (!accept.includes('text/html')) return response;
  const indexUrl = new URL('/index.html', request.url);
  return env.ASSETS.fetch(
    new Request(indexUrl, { method: 'GET', headers: request.headers }),
  );
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (
        url.pathname === installerRoute &&
        (request.method === 'GET' || request.method === 'HEAD')
      ) {
        return serveInstaller(request, env);
      }
      if (url.pathname.startsWith('/api/')) return await handleApi(request, env);
      return await serveSite(request, env);
    } catch (error) {
      console.error('LI3D worker request failed', error);
      if (url.pathname.startsWith('/api/')) {
        return json({ error: 'LI3D service request failed.' }, 500);
      }
      return new Response('LI3D service unavailable.', { status: 500 });
    }
  },
};
