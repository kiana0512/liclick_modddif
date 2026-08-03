import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const callbackHost = '127.0.0.1';
const callbackHostname = 'localhost';
const callbackPort = 20265;
const bindingTtlMs = 5 * 60 * 1000;
const completedBindingRetentionMs = 10 * 60 * 1000;
const maxCallbackBodyBytes = 64 * 1024;
const defaultGatewayUrl = 'https://atlas-ai-gateway.lilithgames.com';
const defaultIdaasSsoUrl = 'https://idaas.lilith.com/enduser/sp/sso/lilithplugin_jwt62';
const defaultEnterpriseId = 'lilith';

type AtlasTokenCache = {
  version: 'v1';
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  expires_at: string;
  gateway_url: string;
};

type AtlasClaims = {
  exp?: number;
  email?: string;
  name?: string;
  username?: string;
  sub?: string;
  idpUsername?: string;
  ouName?: string;
};

export type LocalLiclickAccountStatus = {
  bound: boolean;
  valid: boolean;
  email?: string;
  displayName?: string;
  expiresAt?: string;
  reason?: 'not-bound' | 'invalid-token-cache' | 'expired' | 'gateway-mismatch';
  message: string;
};

export type LocalLiclickBindingProgress = {
  status: 'pending' | 'succeeded' | 'failed';
  account?: LocalLiclickAccountStatus;
  error?: string;
};

type PendingBinding = {
  id: string;
  state: string;
  expectedEmail: string;
  startedAt: number;
  expiresAt: number;
  status: LocalLiclickBindingProgress['status'];
  account?: LocalLiclickAccountStatus;
  error?: string;
  server?: Server;
  timeout?: NodeJS.Timeout;
};

export class LocalLiclickAccountError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, statusCode: number, message: string) {
    super(message);
    this.name = 'LocalLiclickAccountError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

const bindings = new Map<string, PendingBinding>();
let activeBindingId: string | undefined;

function credentialsRoot() {
  const localAppData =
    process.env.LOCALAPPDATA?.trim() ||
    path.join(process.env.USERPROFILE?.trim() || os.homedir(), 'AppData', 'Local');
  return path.join(localAppData, 'LIclick 3D Texture Local Component', 'credentials');
}

export function localLiclickTokenFile() {
  const configured = process.env.ATLAS_TOKEN_FILE?.trim();
  return path.resolve(configured || path.join(credentialsRoot(), 'atlas.json'));
}

function gatewayUrl() {
  return (process.env.ATLAS_GATEWAY_URL?.trim() || defaultGatewayUrl).replace(/\/+$/, '');
}

function idaasSsoUrl() {
  return process.env.ATLAS_IDAAS_SSO_URL?.trim() || defaultIdaasSsoUrl;
}

function enterpriseId() {
  return process.env.ATLAS_IDAAS_ENTERPRISE_ID?.trim() || defaultEnterpriseId;
}

function normalizeEmail(value: string) {
  return value.trim().toLowerCase();
}

function assertExpectedEmail(value: unknown) {
  const email = typeof value === 'string' ? normalizeEmail(value) : '';
  if (!email || email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new LocalLiclickAccountError(
      'EXPECTED_EMAIL_REQUIRED',
      400,
      '绑定个人莉刻账号前必须取得当前飞书账号的有效邮箱。',
    );
  }
  return email;
}

function decodeJwtClaims(token: string) {
  const parts = token.split('.');
  if (parts.length < 2) {
    throw new LocalLiclickAccountError('INVALID_LICLICK_TOKEN', 400, '莉刻授权令牌格式无效。');
  }
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as AtlasClaims;
  } catch {
    throw new LocalLiclickAccountError('INVALID_LICLICK_TOKEN', 400, '莉刻授权令牌无法解析。');
  }
}

function identityFromClaims(claims: AtlasClaims) {
  const email = [claims.email, claims.username, claims.sub]
    .filter((value): value is string => typeof value === 'string')
    .map(normalizeEmail)
    .find((value) => value.length <= 320 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value));
  const displayName = claims.name ?? claims.ouName ?? claims.idpUsername ?? claims.username ?? claims.sub ?? email;
  return { email, displayName };
}

function parseTokenCache(filePath: string) {
  if (!fs.existsSync(filePath)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as Partial<AtlasTokenCache>;
  } catch {
    return undefined;
  }
}

export function getLocalLiclickAccountStatus(): LocalLiclickAccountStatus {
  const filePath = localLiclickTokenFile();
  if (!fs.existsSync(filePath)) {
    return {
      bound: false,
      valid: false,
      reason: 'not-bound',
      message: '此电脑尚未绑定个人莉刻账号。',
    };
  }
  const cache = parseTokenCache(filePath);
  if (
    cache?.version !== 'v1' ||
    typeof cache.access_token !== 'string' ||
    typeof cache.expires_at !== 'string' ||
    typeof cache.gateway_url !== 'string'
  ) {
    return {
      bound: true,
      valid: false,
      reason: 'invalid-token-cache',
      message: '此电脑上的个人莉刻授权文件无效，请重新绑定。',
    };
  }
  let claims: AtlasClaims;
  try {
    claims = decodeJwtClaims(cache.access_token);
  } catch {
    return {
      bound: true,
      valid: false,
      expiresAt: cache.expires_at,
      reason: 'invalid-token-cache',
      message: '此电脑上的个人莉刻授权文件无效，请重新绑定。',
    };
  }
  const identity = identityFromClaims(claims);
  const expiresAt = new Date(cache.expires_at);
  const jwtExpiresAt = typeof claims.exp === 'number' ? claims.exp * 1000 : Number.NaN;
  if (
    Number.isNaN(expiresAt.getTime()) ||
    !Number.isFinite(jwtExpiresAt) ||
    expiresAt.getTime() <= Date.now() ||
    jwtExpiresAt <= Date.now()
  ) {
    return {
      bound: true,
      valid: false,
      email: identity.email,
      displayName: identity.displayName,
      expiresAt: cache.expires_at,
      reason: 'expired',
      message: '此电脑上的个人莉刻授权已过期，请重新绑定。',
    };
  }
  if (cache.gateway_url.replace(/\/+$/, '') !== gatewayUrl()) {
    return {
      bound: true,
      valid: false,
      email: identity.email,
      displayName: identity.displayName,
      expiresAt: cache.expires_at,
      reason: 'gateway-mismatch',
      message: '此电脑上的莉刻授权环境不匹配，请重新绑定。',
    };
  }
  if (!identity.email) {
    return {
      bound: true,
      valid: false,
      expiresAt: cache.expires_at,
      reason: 'invalid-token-cache',
      message: '此电脑上的莉刻授权没有账号邮箱，请重新绑定。',
    };
  }
  return {
    bound: true,
    valid: true,
    email: identity.email,
    displayName: identity.displayName,
    expiresAt: cache.expires_at,
    message: `此电脑已绑定个人莉刻账号：${identity.email}`,
  };
}

function runProcess(command: string, args: string[]) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${command} exited with code ${code ?? 'unknown'}: ${stderr.trim()}`));
    });
  });
}

async function currentWindowsSid() {
  const output = await runProcess('whoami.exe', ['/user', '/fo', 'csv', '/nh']);
  const sid = output.match(/S-1-(?:\d+-)+\d+/i)?.[0];
  if (!sid) throw new Error('Could not resolve the current Windows user SID.');
  return sid;
}

async function protectCredentialPath(targetPath: string, directory: boolean) {
  await fs.promises.chmod(targetPath, directory ? 0o700 : 0o600).catch(() => undefined);
  if (process.platform !== 'win32') return;
  const sid = await currentWindowsSid();
  const permission = directory ? '(OI)(CI)(F)' : '(F)';
  await runProcess('icacls.exe', [
    targetPath,
    '/inheritance:r',
    '/grant:r',
    `*${sid}:${permission}`,
  ]);
}

async function writeTokenCacheAtomically(cache: AtlasTokenCache) {
  const tokenFile = localLiclickTokenFile();
  const directory = path.dirname(tokenFile);
  await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
  await protectCredentialPath(directory, true);
  const temporary = path.join(directory, `.atlas.${process.pid}.${randomUUID()}.tmp`);
  const backup = path.join(directory, `.atlas.${process.pid}.${randomUUID()}.backup`);
  let backupCreated = false;
  let preserveBackup = false;
  try {
    await fs.promises.writeFile(temporary, `${JSON.stringify(cache, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    await protectCredentialPath(temporary, false);
    if (process.platform === 'win32' && fs.existsSync(tokenFile)) {
      await fs.promises.copyFile(tokenFile, backup, fs.constants.COPYFILE_EXCL);
      backupCreated = true;
      await protectCredentialPath(backup, false);
      await fs.promises.rm(tokenFile, { force: true });
    }
    try {
      await fs.promises.rename(temporary, tokenFile);
    } catch (error) {
      if (backupCreated && !fs.existsSync(tokenFile)) {
        try {
          await fs.promises.copyFile(backup, tokenFile, fs.constants.COPYFILE_EXCL);
          await protectCredentialPath(tokenFile, false);
        } catch (restoreError) {
          preserveBackup = true;
          throw new AggregateError(
            [error, restoreError],
            `Could not replace or restore the personal Liclick credential. Protected backup retained at ${backup}.`,
          );
        }
      }
      throw error;
    }
  } finally {
    await fs.promises.rm(temporary, { force: true }).catch(() => undefined);
    if (backupCreated && !preserveBackup) {
      await fs.promises.rm(backup, { force: true }).catch(() => undefined);
    }
  }
}

async function validateGatewayToken(token: string) {
  let response: Response;
  try {
    response = await fetch(`${gatewayUrl()}/mcp-servers/liclick`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        authorization: `Bearer ${token}`,
        'user-agent': 'liclick-3d-texture-local-component/0.1',
        'x-auth-method': 'idaas-jwt',
        'x-atlas-cli-domain': 'gateway',
        'x-atlas-cli-command': 'call-tool',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'tools/call',
        id: randomUUID(),
        params: {
          name: 'list_workspaces',
          arguments: { page: 0, page_size: 1 },
        },
      }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new LocalLiclickAccountError(
      'LICLICK_GATEWAY_UNREACHABLE',
      503,
      '无法连接莉刻服务验证个人账号，请检查网络后重试。',
    );
  }
  if (!response.ok) {
    throw new LocalLiclickAccountError(
      'LICLICK_ACCOUNT_UNAUTHORIZED',
      403,
      `莉刻服务拒绝了此账号的授权（HTTP ${response.status}）。`,
    );
  }
  let payload: Record<string, unknown>;
  try {
    payload = (await response.json()) as Record<string, unknown>;
  } catch {
    throw new LocalLiclickAccountError(
      'LICLICK_GATEWAY_INVALID_RESPONSE',
      502,
      '莉刻服务返回了无法识别的账号验证结果。',
    );
  }
  if (payload.error) {
    throw new LocalLiclickAccountError(
      'LICLICK_ACCOUNT_UNAUTHORIZED',
      403,
      '此账号暂时无法使用莉刻服务，请确认账号权限后重试。',
    );
  }
  const result = payload.result as Record<string, unknown> | undefined;
  if (result?.isError === true) {
    throw new LocalLiclickAccountError(
      'LICLICK_ACCOUNT_UNAUTHORIZED',
      403,
      '此账号暂时无法使用莉刻服务，请确认账号权限后重试。',
    );
  }
}

function callbackUrl() {
  // IDaaS registers this Service as an exact redirect URI. Query parameters
  // make it a different, unregistered Service and are rejected before login.
  return `http://${callbackHostname}:${callbackPort}/callback`;
}

function buildRedirectUrl() {
  const redirect = new URL(idaasSsoUrl());
  redirect.searchParams.set('redirect_uri', callbackUrl());
  redirect.searchParams.set('enterpriseId', enterpriseId());
  return redirect.toString();
}

function callbackHeaders(contentType: string, nonce?: string) {
  const scriptSource = nonce ? `'nonce-${nonce}'` : "'none'";
  const styleSource = nonce ? `'nonce-${nonce}'` : "'none'";
  return {
    'content-type': contentType,
    connection: 'close',
    'cache-control': 'no-store, no-cache, must-revalidate',
    pragma: 'no-cache',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-resource-policy': 'same-origin',
    'content-security-policy': `default-src 'none'; script-src ${scriptSource}; style-src ${styleSource}; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
  };
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => {
    const escapes: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    };
    return escapes[character];
  });
}

function renderCallbackPage(state: string) {
  const nonce = randomBytes(18).toString('base64url');
  const serializedState = JSON.stringify(state).replace(/</g, '\\u003c');
  return {
    nonce,
    html: `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>绑定个人莉刻账号</title>
<style nonce="${nonce}">*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#080915;color:#fff;font-family:system-ui,-apple-system,"Segoe UI",sans-serif}.card{width:min(440px,calc(100% - 32px));padding:32px;border:1px solid rgba(255,255,255,.14);border-radius:16px;background:#111224;box-shadow:0 24px 80px rgba(0,0,0,.45)}h1{margin:0 0 12px;font-size:22px}p{margin:0;color:rgba(255,255,255,.68);line-height:1.7}.ok{color:#6ee7b7}.error{color:#fda4af}</style></head>
<body><main class="card"><h1 id="title">正在绑定个人莉刻账号</h1><p id="message">正在把授权安全保存到这台电脑，请稍候……</p></main>
<script nonce="${nonce}">(async function(){var title=document.getElementById('title');var message=document.getElementById('message');var query=new URLSearchParams(window.location.search);var fragment=new URLSearchParams(window.location.hash.slice(1));var token=query.get('id_token')||query.get('access_token')||fragment.get('id_token')||fragment.get('access_token');history.replaceState(null,'',window.location.pathname);if(!token){title.textContent='绑定失败';title.className='error';message.textContent='授权回调中没有找到令牌，请关闭窗口后重试。';return;}try{var response=await fetch('/callback/token?state='+encodeURIComponent(${serializedState}),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id_token:token})});token='';var payload=await response.json().catch(function(){return {};});if(!response.ok)throw new Error(payload.error||('绑定请求失败：'+response.status));title.textContent='绑定成功';title.className='ok';message.textContent=payload.account&&payload.account.email?('此电脑已绑定 '+payload.account.email+'，可以关闭此窗口。'):'个人莉刻账号已绑定，可以关闭此窗口。';window.setTimeout(function(){window.close();},1200);}catch(error){token='';title.textContent='绑定失败';title.className='error';message.textContent=error instanceof Error?error.message:'无法完成个人莉刻账号绑定，请重试。';}})();</script></body></html>`,
  };
}

function renderCallbackSuccess(email?: string) {
  const nonce = randomBytes(18).toString('base64url');
  const message = email
    ? `此电脑已绑定 ${escapeHtml(email)}，可以关闭此窗口。`
    : '个人莉刻账号已绑定，可以关闭此窗口。';
  return {
    nonce,
    html: `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>绑定成功</title><style nonce="${nonce}">body{margin:0;min-height:100vh;display:grid;place-items:center;background:#080915;color:#fff;font-family:system-ui,-apple-system,"Segoe UI",sans-serif}.card{width:min(440px,calc(100% - 64px));padding:32px;border:1px solid rgba(110,231,183,.34);border-radius:16px;background:#111d20;box-shadow:0 24px 80px rgba(0,0,0,.45)}h1{margin:0 0 12px;font-size:22px;color:#6ee7b7}p{margin:0;color:rgba(255,255,255,.68);line-height:1.7}</style></head><body><main class="card"><h1>绑定成功</h1><p>${message}</p></main><script nonce="${nonce}">history.replaceState(null,'',window.location.pathname);window.setTimeout(function(){window.close();},1200);</script></body></html>`,
  };
}

function renderCallbackFailure(message: string) {
  const nonce = randomBytes(18).toString('base64url');
  return {
    nonce,
    html: `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>绑定失败</title><style nonce="${nonce}">body{margin:0;min-height:100vh;display:grid;place-items:center;background:#080915;color:#fff;font-family:system-ui,-apple-system,"Segoe UI",sans-serif}.card{width:min(440px,calc(100% - 64px));padding:32px;border:1px solid #7f1d1d;border-radius:16px;background:#2b1018}h1{margin:0 0 12px;font-size:22px}p{margin:0;color:#fecdd3;line-height:1.7}</style></head><body><main class="card"><h1>绑定失败</h1><p>${escapeHtml(message)}</p></main><script nonce="${nonce}">history.replaceState(null,'',window.location.pathname);</script></body></html>`,
  };
}

function closeBindingServer(binding: PendingBinding) {
  if (binding.timeout) {
    clearTimeout(binding.timeout);
    binding.timeout = undefined;
  }
  const server = binding.server;
  binding.server = undefined;
  if (server) {
    server.close(() => undefined);
    server.closeIdleConnections();
  }
  if (activeBindingId === binding.id) activeBindingId = undefined;
}

function failBinding(binding: PendingBinding, message: string) {
  if (binding.status !== 'pending') return;
  binding.status = 'failed';
  binding.error = message;
  binding.account = getLocalLiclickAccountStatus();
  closeBindingServer(binding);
}

function pruneBindings() {
  const now = Date.now();
  for (const [id, binding] of bindings) {
    if (binding.status !== 'pending' && now - binding.expiresAt > completedBindingRetentionMs) {
      bindings.delete(id);
    }
  }
}

async function readCallbackBody(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxCallbackBodyBytes) {
      throw new LocalLiclickAccountError('CALLBACK_BODY_TOO_LARGE', 413, '授权回调内容过大。');
    }
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks, total).toString('utf8')) as Record<string, unknown>;
  } catch {
    throw new LocalLiclickAccountError('INVALID_CALLBACK_BODY', 400, '授权回调内容无效。');
  }
}

async function finishBindingWithToken(binding: PendingBinding, token: string) {
  if (binding.status !== 'pending') {
    throw new LocalLiclickAccountError('BINDING_NOT_PENDING', 409, '此绑定任务已经结束。');
  }
  if (!token || token.length > 32_768) {
    throw new LocalLiclickAccountError('INVALID_LICLICK_TOKEN', 400, '莉刻授权令牌无效。');
  }
  const claims = decodeJwtClaims(token);
  if (typeof claims.exp !== 'number' || !Number.isFinite(claims.exp)) {
    throw new LocalLiclickAccountError('INVALID_LICLICK_TOKEN', 400, '莉刻授权令牌缺少有效期。');
  }
  const expiresAt = new Date(claims.exp * 1000);
  if (expiresAt.getTime() <= Date.now()) {
    throw new LocalLiclickAccountError('EXPIRED_LICLICK_TOKEN', 400, '莉刻授权令牌已经过期。');
  }
  const tokenEmail = identityFromClaims(claims).email;
  if (!tokenEmail || tokenEmail !== binding.expectedEmail) {
    throw new LocalLiclickAccountError(
      'LICLICK_ACCOUNT_EMAIL_MISMATCH',
      403,
      `请使用当前飞书账号 ${binding.expectedEmail} 对应的个人莉刻账号完成授权。`,
    );
  }
  await validateGatewayToken(token);
  await writeTokenCacheAtomically({
    version: 'v1',
    access_token: token,
    token_type: 'Bearer',
    expires_in: Math.max(1, Math.floor((expiresAt.getTime() - Date.now()) / 1000)),
    expires_at: expiresAt.toISOString().replace(/\.\d{3}Z$/, 'Z'),
    gateway_url: gatewayUrl(),
  });
  const account = getLocalLiclickAccountStatus();
  if (!account.valid || account.email !== binding.expectedEmail) {
    throw new LocalLiclickAccountError(
      'LICLICK_CREDENTIAL_WRITE_FAILED',
      500,
      '个人莉刻账号授权没有正确保存，请重试。',
    );
  }
  binding.status = 'succeeded';
  binding.account = account;
  closeBindingServer(binding);
  return account;
}

async function handleCallbackRequest(
  binding: PendingBinding,
  request: IncomingMessage,
  response: ServerResponse,
) {
  const url = new URL(request.url ?? '/', `http://${callbackHostname}:${callbackPort}`);
  const state = url.searchParams.get('state');
  const isCallbackPage = request.method === 'GET' && url.pathname === '/callback';
  const isCallbackToken = request.method === 'POST' && url.pathname === '/callback/token';
  // The provider callback must use the exact URI registered by the official
  // Atlas client, so it has no application state query. The callback page
  // injects the in-memory state into the same-origin POST that stores the
  // token; that second step remains protected by the random binding state.
  if (isCallbackToken && state !== binding.state) {
    response.writeHead(403, callbackHeaders('application/json; charset=utf-8'));
    response.end(JSON.stringify({ ok: false, error: '授权回调校验失败。' }));
    return;
  }
  if (isCallbackPage) {
    if (state && state !== binding.state) {
      response.writeHead(403, callbackHeaders('application/json; charset=utf-8'));
      response.end(JSON.stringify({ ok: false, error: '授权回调校验失败。' }));
      return;
    }
    const providerError = url.searchParams.get('error');
    if (providerError) {
      const message = '莉刻账号授权被取消或失败，请关闭窗口后重试。';
      failBinding(binding, message);
      const page = renderCallbackFailure(message);
      response.writeHead(400, callbackHeaders('text/html; charset=utf-8', page.nonce));
      response.end(page.html);
      return;
    }
    const queryToken = url.searchParams.get('id_token') || url.searchParams.get('access_token');
    if (queryToken) {
      try {
        const account = await finishBindingWithToken(binding, queryToken);
        const page = renderCallbackSuccess(account.email);
        response.writeHead(200, callbackHeaders('text/html; charset=utf-8', page.nonce));
        response.end(page.html);
      } catch (error) {
        const message = error instanceof Error ? error.message : '个人莉刻账号绑定失败。';
        failBinding(binding, message);
        const statusCode = error instanceof LocalLiclickAccountError ? error.statusCode : 500;
        const page = renderCallbackFailure(message);
        response.writeHead(statusCode, callbackHeaders('text/html; charset=utf-8', page.nonce));
        response.end(page.html);
      }
      return;
    }
    const page = renderCallbackPage(binding.state);
    response.writeHead(200, callbackHeaders('text/html; charset=utf-8', page.nonce));
    response.end(page.html);
    return;
  }
  if (isCallbackToken) {
    const origin = request.headers.origin;
    if (origin && origin !== `http://${callbackHostname}:${callbackPort}` && origin !== `http://${callbackHost}:${callbackPort}`) {
      response.writeHead(403, callbackHeaders('application/json; charset=utf-8'));
      response.end(JSON.stringify({ ok: false, error: '授权回调来源无效。' }));
      return;
    }
    try {
      const body = await readCallbackBody(request);
      const token =
        typeof body.id_token === 'string'
          ? body.id_token
          : typeof body.access_token === 'string'
            ? body.access_token
            : '';
      const account = await finishBindingWithToken(binding, token);
      response.writeHead(200, callbackHeaders('application/json; charset=utf-8'));
      response.end(JSON.stringify({ ok: true, account }));
    } catch (error) {
      const message = error instanceof Error ? error.message : '个人莉刻账号绑定失败。';
      failBinding(binding, message);
      const statusCode = error instanceof LocalLiclickAccountError ? error.statusCode : 500;
      response.writeHead(statusCode, callbackHeaders('application/json; charset=utf-8'));
      response.end(JSON.stringify({ ok: false, error: message }));
    }
    return;
  }
  response.writeHead(404, callbackHeaders('text/plain; charset=utf-8'));
  response.end('Not found.');
}

function listenForCallback(binding: PendingBinding) {
  return new Promise<void>((resolve, reject) => {
    const server = createServer((request, response) => {
      void handleCallbackRequest(binding, request, response).catch((error) => {
        const message = error instanceof Error ? error.message : '个人莉刻账号回调处理失败。';
        failBinding(binding, message);
        if (!response.headersSent) {
          response.writeHead(500, callbackHeaders('application/json; charset=utf-8'));
        }
        if (!response.writableEnded) response.end(JSON.stringify({ ok: false, error: message }));
      });
    });
    binding.server = server;
    server.once('error', (error: NodeJS.ErrnoException) => {
      binding.server = undefined;
      if (error.code === 'EADDRINUSE') {
        reject(
          new LocalLiclickAccountError(
            'LOCAL_CALLBACK_PORT_OCCUPIED',
            409,
            `本地端口 ${callbackPort} 已被占用，无法启动个人莉刻账号授权。请关闭占用该端口的程序后重试。`,
          ),
        );
      } else {
        reject(
          new LocalLiclickAccountError(
            'LOCAL_CALLBACK_LISTENER_FAILED',
            500,
            '无法启动个人莉刻账号的本地授权监听。',
          ),
        );
      }
    });
    server.listen(callbackPort, callbackHost, () => resolve());
  });
}

export async function startLocalLiclickAccountBinding(expectedEmailValue: unknown) {
  pruneBindings();
  const expectedEmail = assertExpectedEmail(expectedEmailValue);
  if (activeBindingId) {
    const active = bindings.get(activeBindingId);
    if (active?.status === 'pending' && active.expectedEmail === expectedEmail) {
      return {
        loginId: active.id,
        redirectUrl: buildRedirectUrl(),
        expiresAt: new Date(active.expiresAt).toISOString(),
      };
    }
    if (active?.status === 'pending') {
      failBinding(active, '已开始新的个人莉刻账号绑定。');
    }
  }

  const now = Date.now();
  const binding: PendingBinding = {
    id: randomUUID(),
    state: randomBytes(32).toString('base64url'),
    expectedEmail,
    startedAt: now,
    expiresAt: now + bindingTtlMs,
    status: 'pending',
  };
  bindings.set(binding.id, binding);
  activeBindingId = binding.id;
  try {
    await listenForCallback(binding);
  } catch (error) {
    bindings.delete(binding.id);
    if (activeBindingId === binding.id) activeBindingId = undefined;
    throw error;
  }
  binding.timeout = setTimeout(() => {
    failBinding(binding, '等待个人莉刻账号授权超时，请重新绑定。');
  }, bindingTtlMs);
  binding.timeout.unref();
  return {
    loginId: binding.id,
    redirectUrl: buildRedirectUrl(),
    expiresAt: new Date(binding.expiresAt).toISOString(),
  };
}

export function getLocalLiclickAccountBindingProgress(
  loginId: string,
  expectedEmailValue: unknown,
): LocalLiclickBindingProgress {
  pruneBindings();
  const expectedEmail = assertExpectedEmail(expectedEmailValue);
  const binding = bindings.get(loginId);
  if (!binding) {
    throw new LocalLiclickAccountError(
      'LICLICK_BINDING_NOT_FOUND',
      404,
      '个人莉刻账号绑定任务不存在或已经过期。',
    );
  }
  if (binding.expectedEmail !== expectedEmail) {
    throw new LocalLiclickAccountError(
      'LICLICK_BINDING_OWNER_MISMATCH',
      403,
      '此个人莉刻账号绑定任务不属于当前飞书用户。',
    );
  }
  if (binding.status === 'pending') return { status: 'pending' };
  if (binding.status === 'succeeded') {
    return { status: 'succeeded', account: binding.account ?? getLocalLiclickAccountStatus() };
  }
  return {
    status: 'failed',
    account: binding.account,
    error: binding.error ?? '个人莉刻账号绑定失败。',
  };
}

export async function unbindLocalLiclickAccount(expectedEmailValue: unknown) {
  const expectedEmail = assertExpectedEmail(expectedEmailValue);
  const account = getLocalLiclickAccountStatus();
  if (account.email && account.email.toLowerCase() !== expectedEmail) {
    throw new LocalLiclickAccountError(
      'LICLICK_ACCOUNT_EMAIL_MISMATCH',
      403,
      '当前飞书账号不能解绑其他员工的个人莉刻账号。',
    );
  }
  if (activeBindingId) {
    const active = bindings.get(activeBindingId);
    if (active?.status === 'pending' && active.expectedEmail !== expectedEmail) {
      throw new LocalLiclickAccountError(
        'LICLICK_BINDING_OWNER_MISMATCH',
        403,
        '当前飞书账号不能取消其他员工的个人莉刻账号绑定。',
      );
    }
    if (active?.status === 'pending') failBinding(active, '个人莉刻账号绑定已取消。');
  }
  const tokenFile = localLiclickTokenFile();
  await fs.promises.rm(tokenFile, { force: true });
  return getLocalLiclickAccountStatus();
}
