import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptsDir, '..');
const tmpRoot = path.join(repoRoot, '.codex-tmp', 'oauth-smoke');
const mockPort = Number(process.env.MOCK_IDAAS_PORT ?? 5199);
const serverPort = Number(process.env.SERVER_PORT ?? 4519);
const mockIssuer = `http://127.0.0.1:${mockPort}`;
const serverOrigin = `http://127.0.0.1:${serverPort}`;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function startProcess(command, args, env) {
  const child = spawn(command, args, {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => process.stdout.write(chunk));
  child.stderr.on('data', (chunk) => process.stderr.write(chunk));
  return child;
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null) return;
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (child.exitCode === null) child.kill('SIGKILL');
      resolve();
    }, 3000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill();
  });
}

async function waitForJson(url, label) {
  const deadline = Date.now() + 30_000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return response.json();
      lastError = new Error(`${label} returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await wait(500);
  }
  throw lastError ?? new Error(`${label} not ready`);
}

async function requestJson(url, init) {
  const response = await fetch(url, init);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${url} failed ${response.status}: ${JSON.stringify(payload)}`);
  return { response, payload };
}

function cookiePair(setCookieHeader, name) {
  const match = new RegExp(`(?:^|,\\s*)(${name}=[^;]*)`).exec(setCookieHeader ?? '');
  if (!match) throw new Error(`Response did not set ${name}.`);
  return match[1];
}

async function main() {
  await fs.rm(tmpRoot, { recursive: true, force: true });
  await fs.mkdir(tmpRoot, { recursive: true });

  const mock = startProcess(process.execPath, ['scripts/mock-idaas-server.mjs'], {
    MOCK_IDAAS_PORT: String(mockPort),
    MOCK_IDAAS_REQUIRE_JSON_TOKEN_REQUEST: 'true',
  });
  const server = startProcess(process.execPath, ['apps/server/dist/index.js'], {
    SERVER_PORT: String(serverPort),
    SERVER_HOST: '127.0.0.1',
    LICLICK_WORKSPACE_DIR: path.join(tmpRoot, 'workspace'),
    LICLICK_PUBLIC_WORKSPACE_URL: serverOrigin,
    LICLICK_PUBLIC_PATH: '',
    LICLICK_FRONTEND_URL: 'http://127.0.0.1:5173',
    LICLICK_ALLOWED_ORIGINS: 'http://127.0.0.1:5173',
    AUTH_MODE: 'feishu-oauth',
    SESSION_SECRET: 'oauth-smoke-test-secret',
    SESSION_COOKIE_SECURE: 'false',
    FEISHU_OAUTH_CLIENT_ID: 'liclick-local-test',
    FEISHU_OAUTH_CLIENT_SECRET: 'local-secret',
    FEISHU_OAUTH_AUTHORIZE_URL: `${mockIssuer}/authorize`,
    FEISHU_OAUTH_TOKEN_URL: `${mockIssuer}/token`,
    FEISHU_OAUTH_USERINFO_URL: `${mockIssuer}/userinfo`,
    FEISHU_OAUTH_REDIRECT_URL: `${serverOrigin}/api/auth/feishu/callback`,
    FEISHU_OAUTH_SCOPE: '',
    FEISHU_OAUTH_TOKEN_REQUEST_FORMAT: 'json',
    FEISHU_OAUTH_ALLOW_LOOPBACK_PROVIDER: 'true',
    FEISHU_OAUTH_EXTRA_AUTHORIZE_PARAMS: 'mock_auto=1',
  });

  try {
    await waitForJson(`${mockIssuer}/health`, 'Mock IDaaS');
    const health = await waitForJson(`${serverOrigin}/api/health`, 'Liclick backend');
    if (!health.features?.webOAuthCookieSession) {
      throw new Error(`Backend did not enable webOAuthCookieSession: ${JSON.stringify(health)}`);
    }

    const status = await requestJson(`${serverOrigin}/api/auth/provider-status`);
    if (status.payload.feishuLoginProvider !== 'web-oauth') {
      throw new Error(`Expected web-oauth provider, got ${JSON.stringify(status.payload)}`);
    }

    const start = await requestJson(`${serverOrigin}/api/auth/feishu/start`);
    if (!start.payload.loginId || !start.payload.redirectUrl) {
      throw new Error(`Login did not return loginId/redirectUrl: ${JSON.stringify(start.payload)}`);
    }
    const oauthBrowserCookie = cookiePair(
      start.response.headers.get('set-cookie'),
      'li3d_oauth_nonce',
    );

    const authorizeResponse = await fetch(start.payload.redirectUrl, { redirect: 'manual' });
    const callbackUrl = authorizeResponse.headers.get('location');
    if (!callbackUrl) throw new Error('Mock authorize endpoint did not redirect to the callback.');
    const callbackResponse = await fetch(callbackUrl, {
      redirect: 'manual',
      headers: { cookie: oauthBrowserCookie },
    });
    const callbackHtml = await callbackResponse.text();
    const setCookie = callbackResponse.headers.get('set-cookie');
    if (!callbackResponse.ok || !setCookie || !callbackHtml.includes('Liclick 登录成功')) {
      throw new Error(`Callback failed: status=${callbackResponse.status} cookie=${Boolean(setCookie)}`);
    }
    const sessionCookie = cookiePair(setCookie, 'liclick_3d_session');

    const replayResponse = await fetch(callbackUrl, {
      redirect: 'manual',
      headers: { cookie: oauthBrowserCookie },
    });
    if (replayResponse.status !== 409) {
      throw new Error(`OAuth callback state was replayable: status=${replayResponse.status}`);
    }

    const poll = await requestJson(`${serverOrigin}/api/auth/feishu/poll/${encodeURIComponent(start.payload.loginId)}`, {
      headers: { cookie: sessionCookie },
    });
    if (!poll.payload.user?.id) throw new Error(`Poll did not return user: ${JSON.stringify(poll.payload)}`);

    const me = await requestJson(`${serverOrigin}/api/auth/me`, {
      headers: { cookie: sessionCookie },
    });
    if (!me.payload.authenticated || me.payload.user?.id !== poll.payload.user.id) {
      throw new Error(`Session cookie did not authenticate: ${JSON.stringify(me.payload)}`);
    }

    const crossBrowserStart = await requestJson(`${serverOrigin}/api/auth/feishu/start`);
    const crossBrowserCookie = cookiePair(
      crossBrowserStart.response.headers.get('set-cookie'),
      'li3d_oauth_nonce',
    );
    const crossAuthorize = await fetch(crossBrowserStart.payload.redirectUrl, {
      redirect: 'manual',
    });
    const crossCallbackUrl = crossAuthorize.headers.get('location');
    if (!crossCallbackUrl) throw new Error('Cross-browser authorize did not return a callback URL.');
    const missingBrowserCookie = await fetch(crossCallbackUrl, { redirect: 'manual' });
    if (
      missingBrowserCookie.status !== 409 ||
      !(await missingBrowserCookie.text()).includes('浏览器校验失败')
    ) {
      throw new Error('OAuth callback was not bound to the browser that started the flow.');
    }
    const consumedCrossBrowserState = await fetch(crossCallbackUrl, {
      redirect: 'manual',
      headers: { cookie: crossBrowserCookie },
    });
    if (consumedCrossBrowserState.status !== 409) {
      throw new Error('Failed browser verification did not consume the OAuth state.');
    }

    console.log('\nOAuth smoke test passed.');
    console.log(JSON.stringify({ provider: status.payload.feishuLoginProvider, user: me.payload.user }, null, 2));
  } finally {
    await stopProcess(server);
    await stopProcess(mock);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
