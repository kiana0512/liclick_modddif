import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const serverEntry = path.join(root, 'apps', 'server', 'dist', 'index.js');
const workspaceDir = path.join(root, '.codex-tmp', 'lan-http-oauth-smoke');

async function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : undefined;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function serverEnvironment(port, allowInsecureHttp) {
  const publicOrigin = `http://10.3.34.9:${port}`;
  return {
    ...process.env,
    NODE_ENV: 'production',
    SERVER_HOST: '127.0.0.1',
    SERVER_PORT: String(port),
    LICLICK_WORKSPACE_DIR: workspaceDir,
    LICLICK_PUBLIC_WORKSPACE_URL: publicOrigin,
    LICLICK_FRONTEND_URL: publicOrigin,
    LICLICK_ALLOWED_ORIGINS: publicOrigin,
    LICLICK_ENABLE_ATLAS_LOCAL_LOGIN: 'false',
    AUTH_MODE: 'feishu-oauth',
    SESSION_SECRET: 'lan-http-oauth-smoke-session-secret',
    SESSION_COOKIE_SECURE: 'false',
    FEISHU_OAUTH_CLIENT_ID: 'cli_lan_http_smoke',
    FEISHU_OAUTH_CLIENT_SECRET: 'lan-http-smoke-secret',
    FEISHU_OAUTH_AUTHORIZE_URL: 'https://accounts.feishu.cn/open-apis/authen/v1/authorize',
    FEISHU_OAUTH_TOKEN_URL: 'https://open.feishu.cn/open-apis/authen/v2/oauth/token',
    FEISHU_OAUTH_USERINFO_URL: 'https://open.feishu.cn/open-apis/authen/v1/user_info',
    FEISHU_OAUTH_REDIRECT_URL: `${publicOrigin}/api/auth/feishu/callback`,
    FEISHU_OAUTH_ALLOW_INSECURE_HTTP_CALLBACK: allowInsecureHttp ? 'true' : 'false',
  };
}

function collectProcess(child) {
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  return {
    output: () => ({ stdout, stderr }),
    exited: new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal }))),
  };
}

async function waitForJson(url, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw lastError ?? new Error(`Timed out waiting for ${url}`);
}

const blockedPort = await reservePort();
const blocked = spawn(process.execPath, [serverEntry], {
  cwd: root,
  env: serverEnvironment(blockedPort, false),
  stdio: ['ignore', 'pipe', 'pipe'],
});
const blockedResult = collectProcess(blocked);
const blockedExit = await blockedResult.exited;
assert.notEqual(blockedExit.code, 0);
assert.match(
  blockedResult.output().stderr,
  /FEISHU_OAUTH_REDIRECT_URL must use HTTPS unless it points to a loopback test server/,
);

const enabledPort = await reservePort();
const enabled = spawn(process.execPath, [serverEntry], {
  cwd: root,
  env: serverEnvironment(enabledPort, true),
  stdio: ['ignore', 'pipe', 'pipe'],
});
const enabledResult = collectProcess(enabled);

try {
  await waitForJson(`http://127.0.0.1:${enabledPort}/api/health`);
  const statusResponse = await fetch(`http://127.0.0.1:${enabledPort}/api/auth/provider-status`);
  assert.equal(statusResponse.status, 200);
  const status = await statusResponse.json();
  assert.equal(status.feishuConfigured, true);
  assert.equal(status.feishuLoginProvider, 'web-oauth');
  assert.equal(status.insecureHttpCallback, true);

  const startResponse = await fetch(`http://127.0.0.1:${enabledPort}/api/auth/feishu/start`);
  assert.equal(startResponse.status, 200);
  assert.match(startResponse.headers.get('set-cookie') ?? '', /li3d_oauth_nonce=/);
  const started = await startResponse.json();
  const authorizeUrl = new URL(started.redirectUrl);
  assert.equal(authorizeUrl.origin, 'https://accounts.feishu.cn');
  assert.equal(
    authorizeUrl.searchParams.get('redirect_uri'),
    `http://10.3.34.9:${enabledPort}/api/auth/feishu/callback`,
  );
  assert.equal(authorizeUrl.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(authorizeUrl.searchParams.get('state'));
  assert.ok(authorizeUrl.searchParams.get('code_challenge'));
} finally {
  enabled.kill('SIGTERM');
  await Promise.race([
    enabledResult.exited,
    new Promise((resolve) => setTimeout(resolve, 2_000)),
  ]);
}

console.log('LAN HTTP OAuth opt-in smoke test passed.');
