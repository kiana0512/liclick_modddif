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

function fakeJwt(email) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode({ email, sub: email, exp: Math.floor(Date.now() / 1000) + 3600 })}.`;
}

async function createMockAtlasRuntime() {
  const root = path.join(tmpRoot, 'atlas-runtime');
  const dist = path.join(root, 'dist');
  await fs.mkdir(dist, { recursive: true });
  await fs.writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ name: '@lilith/atlas-skillhub', version: '2.9.1', type: 'module' }),
  );
  await fs.writeFile(
    path.join(dist, 'index.js'),
    `const args=process.argv.slice(2);if(args.includes('list-tools')){process.stdout.write('  mock_generate_image()\\n');process.exit(0)}if(args.includes('status')){process.stdout.write(JSON.stringify({valid:true}));process.exit(0)}process.exit(0);`,
  );
  await fs.writeFile(
    path.join(dist, 'secure-runtime.js'),
    `import fs from 'node:fs';import http from 'node:http';import path from 'node:path';
function readCache(tokenFile){try{const wrapper=JSON.parse(fs.readFileSync(tokenFile,'utf8'));return JSON.parse(Buffer.from(wrapper.encrypted_payload,'base64url').toString('utf8'))}catch{return undefined}}
function authenticate(options){return new Promise((resolve,reject)=>{const server=http.createServer((request,response)=>{if(request.method!=='POST'||request.url!=='/callback/token'){response.writeHead(404);response.end();return}let body='';request.on('data',chunk=>body+=chunk);request.on('end',()=>{try{const input=JSON.parse(body);const token=input.id_token||input.access_token;if(!token)throw new Error('missing token');const claims=JSON.parse(Buffer.from(token.split('.')[1],'base64url').toString('utf8'));const expiresAt=new Date(claims.exp*1000).toISOString();const cache={version:'v1',access_token:token,token_type:'Bearer',expires_in:Math.max(1,claims.exp-Math.floor(Date.now()/1000)),expires_at:expiresAt,gateway_url:options.gatewayBaseUrl};fs.mkdirSync(path.dirname(options.tokenFile),{recursive:true});fs.writeFileSync(options.tokenFile,JSON.stringify({encrypted_payload:Buffer.from(JSON.stringify(cache)).toString('base64url')}),{mode:0o600});response.writeHead(200,{'content-type':'application/json'});response.end(JSON.stringify({ok:true}));server.close(()=>resolve(token))}catch(error){response.writeHead(400,{'content-type':'application/json'});response.end(JSON.stringify({ok:false}));server.close(()=>reject(error))}})});server.once('error',reject);server.listen(options.callbackPort,'127.0.0.1')})}
export {readCache,authenticate,};`,
  );
  return path.join(dist, 'index.js');
}

async function main() {
  await fs.rm(tmpRoot, { recursive: true, force: true });
  await fs.mkdir(tmpRoot, { recursive: true });
  const atlasRuntimePath = await createMockAtlasRuntime();

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
    FEISHU_OAUTH_PUBLIC_CLIENT: 'true',
    FEISHU_OAUTH_AUTHORIZE_URL: `${mockIssuer}/authorize`,
    FEISHU_OAUTH_TOKEN_URL: `${mockIssuer}/token`,
    FEISHU_OAUTH_USERINFO_URL: `${mockIssuer}/userinfo`,
    FEISHU_OAUTH_REDIRECT_URL: `${serverOrigin}/api/auth/feishu/callback`,
    FEISHU_OAUTH_SCOPE: '',
    FEISHU_OAUTH_TOKEN_REQUEST_FORMAT: 'json',
    FEISHU_OAUTH_ALLOW_LOOPBACK_PROVIDER: 'true',
    FEISHU_OAUTH_EXTRA_AUTHORIZE_PARAMS: 'mock_auto=1',
    IDAAS_JWT_SSO_URL: `${mockIssuer}/sso`,
    ATLAS_SKILLHUB_PATH: atlasRuntimePath,
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
    if (status.payload.missingConfigKeys?.length) {
      throw new Error(`Public-client OAuth was treated as incomplete: ${JSON.stringify(status.payload)}`);
    }

    const start = await requestJson(`${serverOrigin}/api/auth/feishu/start`);
    if (!start.payload.loginId || !start.payload.redirectUrl) {
      throw new Error(`Login did not return loginId/redirectUrl: ${JSON.stringify(start.payload)}`);
    }
    if (start.payload.redirectUrl.includes('localhost:20265')) {
      throw new Error(`Web OAuth unexpectedly fell back to an Atlas CLI callback: ${start.payload.redirectUrl}`);
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
    const setCookie = callbackResponse.headers.get('set-cookie');
    const bindingSsoUrl = callbackResponse.headers.get('location');
    if (callbackResponse.status !== 302 || !setCookie || !bindingSsoUrl) {
      throw new Error(`Callback did not enter account binding: status=${callbackResponse.status}`);
    }
    if (bindingSsoUrl.includes('localhost:20265')) {
      throw new Error('OAuth callback leaked the Atlas loopback callback to the browser.');
    }
    const sessionCookie = cookiePair(setCookie, 'liclick_3d_session');

    const bindingSsoResponse = await fetch(bindingSsoUrl, { redirect: 'manual' });
    const bindingCallbackWithFragment = bindingSsoResponse.headers.get('location');
    if (bindingSsoResponse.status !== 302 || !bindingCallbackWithFragment) {
      throw new Error(`Mock IDaaS SSO failed: status=${bindingSsoResponse.status}`);
    }
    const bindingCallbackUrl = new URL(bindingCallbackWithFragment);
    const idToken = new URLSearchParams(bindingCallbackUrl.hash.slice(1)).get('id_token');
    bindingCallbackUrl.hash = '';
    if (!idToken) throw new Error('Mock IDaaS callback did not provide an id_token.');

    const bindingPageResponse = await fetch(bindingCallbackUrl, {
      headers: { cookie: sessionCookie },
    });
    const bindingPageHtml = await bindingPageResponse.text();
    if (!bindingPageResponse.ok || !bindingPageHtml.includes('正在关联莉刻账号')) {
      throw new Error(`Account-binding callback page failed: status=${bindingPageResponse.status}`);
    }
    const bindingResult = await requestJson(bindingCallbackUrl.toString(), {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: sessionCookie },
      body: JSON.stringify({ idToken }),
    });
    if (bindingResult.response.status !== 200 || bindingResult.payload?.status !== 'bound') {
      throw new Error(`Automatic Liclick account binding failed: ${JSON.stringify(bindingResult.payload)}`);
    }

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

    await requestJson(`${serverOrigin}/api/auth/logout`, {
      method: 'POST',
      headers: { cookie: sessionCookie },
    });
    const loggedOut = await requestJson(`${serverOrigin}/api/auth/me`, {
      headers: { cookie: sessionCookie },
    });
    if (loggedOut.payload.authenticated) {
      throw new Error(`Logout did not revoke the browser session: ${JSON.stringify(loggedOut.payload)}`);
    }

    const reloginStart = await requestJson(`${serverOrigin}/api/auth/feishu/start`);
    if (
      !reloginStart.payload.loginId ||
      !reloginStart.payload.redirectUrl ||
      reloginStart.payload.redirectUrl.includes('localhost:20265')
    ) {
      throw new Error(`Re-login did not start a Web OAuth flow: ${JSON.stringify(reloginStart.payload)}`);
    }
    const reloginBrowserCookie = cookiePair(
      reloginStart.response.headers.get('set-cookie'),
      'li3d_oauth_nonce',
    );
    const reloginAuthorize = await fetch(reloginStart.payload.redirectUrl, { redirect: 'manual' });
    const reloginCallbackUrl = reloginAuthorize.headers.get('location');
    if (!reloginCallbackUrl) throw new Error('Re-login authorize did not return a callback URL.');
    const reloginCallback = await fetch(reloginCallbackUrl, {
      redirect: 'manual',
      headers: { cookie: reloginBrowserCookie },
    });
    const reloginSetCookie = reloginCallback.headers.get('set-cookie');
    if (!reloginCallback.ok || !reloginSetCookie) {
      throw new Error(`Re-login callback failed: status=${reloginCallback.status}`);
    }
    const reloginSessionCookie = cookiePair(reloginSetCookie, 'liclick_3d_session');
    const reloggedIn = await requestJson(`${serverOrigin}/api/auth/me`, {
      headers: { cookie: reloginSessionCookie },
    });
    if (!reloggedIn.payload.authenticated || reloggedIn.payload.user?.id !== me.payload.user.id) {
      throw new Error(`Re-login did not restore the same user: ${JSON.stringify(reloggedIn.payload)}`);
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

    console.log('\nOAuth login, logout, and re-login smoke test passed.');
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
