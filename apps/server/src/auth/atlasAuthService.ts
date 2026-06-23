import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createSession, upsertUser } from './sessionService.js';
import { serverConfig } from '../config.js';
import type { AuthUser } from './authTypes.js';

type AtlasCommandResult = {
  code: number | null;
  stdout: string;
  stderr: string;
};

type AtlasStatus = {
  valid?: boolean;
  expires_at?: string;
};

type PublicAtlasStatus = {
  valid: boolean;
  expiresAt?: string;
  message?: string;
};

type PendingAtlasLogin = {
  id: string;
  homeDir: string;
  callbackPort?: number;
  child?: ChildProcessWithoutNullStreams;
  startedAt: number;
  stdout: string;
  stderr: string;
  closed: boolean;
  closeCode?: number | null;
};

type AtlasTokenCache = {
  access_token?: string;
  expires_at?: string;
  gateway_url?: string;
};

type AtlasClaims = {
  email?: string;
  name?: string;
  username?: string;
  idpUsername?: string;
  ouName?: string;
  ouId?: string;
  externalId?: string;
  sub?: string;
};

const pendingAtlasLogins = new Map<string, PendingAtlasLogin>();
const pendingLoginTtlMs = 10 * 60 * 1000;

function atlasScriptPath() {
  const appData = process.env.APPDATA;
  const explicitPath = process.env.ATLAS_SKILLHUB_PATH;
  const candidates = [
    explicitPath ?? '',
    appData ? path.join(appData, 'npm', 'node_modules', '@lilith', 'atlas-skillhub', 'dist', 'index.js') : '',
    path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'node_modules', '@lilith', 'atlas-skillhub', 'dist', 'index.js'),
    path.join(os.homedir(), '.npm-global', 'lib', 'node_modules', '@lilith', 'atlas-skillhub', 'dist', 'index.js'),
    path.join(os.homedir(), '.local', 'lib', 'node_modules', '@lilith', 'atlas-skillhub', 'dist', 'index.js'),
    '/usr/local/lib/node_modules/@lilith/atlas-skillhub/dist/index.js',
    '/usr/lib/node_modules/@lilith/atlas-skillhub/dist/index.js',
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate));
}

function atlasTokenFile(homeDir = os.homedir()) {
  return path.join(homeDir, '.atlas-ai-gateway-oauth.json');
}

function userAtlasHomesRoot() {
  return path.join(serverConfig.workspaceDir, 'atlas-homes');
}

async function createAtlasHomeDir() {
  const dir = path.join(userAtlasHomesRoot(), `login-${randomUUID()}`);
  await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.promises.chmod(dir, 0o700).catch(() => undefined);
  return dir;
}

function trimOutput(text: string) {
  return sanitizeAtlasOutput(text).trim().replace(/\s+/g, ' ').slice(0, 1600);
}

function sanitizeAtlasOutput(text: string) {
  return text
    .replace(/([?&](?:id_token|access_token|refresh_token|token)=)[^&\s"'<>]+/gi, '$1[redacted]')
    .replace(/(authorization:\s*bearer\s+)[^\s"'<>]+/gi, '$1[redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[redacted-jwt]');
}

export function parseJsonFromOutput(text: string) {
  const raw = text.trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    const first = raw.indexOf('{');
    const last = raw.lastIndexOf('}');
    if (first >= 0 && last > first) return JSON.parse(raw.slice(first, last + 1)) as Record<string, unknown>;
    return {};
  }
}

function atlasEnv(homeDir?: string, extraEnv: NodeJS.ProcessEnv = {}) {
  return {
    ...process.env,
    ...extraEnv,
    ...(homeDir
      ? {
          HOME: homeDir,
          USERPROFILE: homeDir,
          XDG_CONFIG_HOME: path.join(homeDir, '.config'),
          XDG_CACHE_HOME: path.join(homeDir, '.cache'),
          XDG_DATA_HOME: path.join(homeDir, '.local', 'share'),
        }
      : {}),
  };
}

export function runAtlas(args: string[], timeoutMs: number, allowNonZero = false, homeDir?: string, extraEnv: NodeJS.ProcessEnv = {}) {
  const script = atlasScriptPath();
  if (!script) {
    return Promise.reject(
      new Error('未找到 @lilith/atlas-skillhub，请先安装莉刻 Atlas 运行时。'),
    );
  }
  return new Promise<AtlasCommandResult>((resolve, reject) => {
    const child = spawn('node', [script, ...args], {
      cwd: process.cwd(),
      env: atlasEnv(homeDir, extraEnv),
      shell: false,
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`atlas-skillhub ${args.join(' ')} 超时`));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 || allowNonZero) resolve({ code, stdout, stderr });
      else reject(new Error(trimOutput(stderr || stdout || `atlas-skillhub exited ${code}`)));
    });
  });
}

function prunePendingAtlasLogins() {
  const now = Date.now();
  for (const [id, login] of pendingAtlasLogins) {
    if (now - login.startedAt > pendingLoginTtlMs) {
      if (!login.closed) login.child?.kill('SIGTERM');
      pendingAtlasLogins.delete(id);
    }
  }
}

function extractFirstUrl(text: string) {
  return text.match(/https?:\/\/[^\s"'<>]+/)?.[0];
}

function publicWorkspaceBase() {
  const publicUrl = new URL(serverConfig.publicWorkspaceUrl);
  const pathname = serverConfig.publicPath || publicUrl.pathname;
  publicUrl.pathname = `/${pathname.split('/').filter(Boolean).join('/')}`;
  publicUrl.search = '';
  publicUrl.hash = '';
  return publicUrl.toString().replace(/\/$/, '');
}

function isLoopbackHost(hostname: string) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';
}

function shouldRewriteAtlasCallbackForRemoteBrowser() {
  if (process.env.ATLAS_REMOTE_CALLBACK_PROXY === '1') return true;
  if (process.env.ATLAS_REMOTE_CALLBACK_PROXY === '0') return false;
  try {
    return !isLoopbackHost(new URL(serverConfig.publicWorkspaceUrl).hostname);
  } catch {
    return false;
  }
}

function publicCallbackUrl(loginId: string) {
  return `${publicWorkspaceBase()}/api/auth/atlas-callback/${encodeURIComponent(loginId)}/callback`;
}

function rewriteLocalCallbackUrl(value: string, login: PendingAtlasLogin) {
  if (!shouldRewriteAtlasCallbackForRemoteBrowser()) return value;
  try {
    const url = new URL(value);
    if ((url.hostname === 'localhost' || url.hostname === '127.0.0.1') && url.pathname === '/callback') {
      login.callbackPort = Number(url.port || process.env.ATLAS_CALLBACK_PORT || 20265);
      const rewritten = new URL(publicCallbackUrl(login.id));
      rewritten.search = url.search;
      return rewritten.toString();
    }
  } catch {
    return value;
  }
  return value;
}

function rewriteAuthUrlForRemoteBrowser(value: string | undefined, login: PendingAtlasLogin) {
  if (!value) return undefined;
  let rewritten = rewriteLocalCallbackUrl(value, login);
  try {
    const url = new URL(rewritten);
    for (const [key, rawValue] of url.searchParams.entries()) {
      let decoded = rawValue;
      try {
        decoded = decodeURIComponent(rawValue);
      } catch {
        decoded = rawValue;
      }
      const nextValue = rewriteLocalCallbackUrl(decoded, login);
      if (nextValue !== decoded) url.searchParams.set(key, nextValue);
    }
    rewritten = url.toString();
  } catch {
    // Keep the original URL if Atlas prints text that only looks like a URL fragment.
  }
  return rewritten;
}

function loginMessage(login: PendingAtlasLogin, fallback: string) {
  return trimOutput(`${login.stderr}\n${login.stdout}`) || fallback;
}

function startAtlasLoginProcess() {
  const script = atlasScriptPath();
  if (!script) throw new Error('未找到 @lilith/atlas-skillhub，请先安装莉刻 Atlas 运行时。');

  const id = randomUUID();
  return createAtlasHomeDir().then((homeDir) => {
    const login: PendingAtlasLogin = {
      id,
      homeDir,
      startedAt: Date.now(),
      stdout: '',
      stderr: '',
      closed: false,
    };
    pendingAtlasLogins.set(id, login);

    const child = spawn('node', [script, 'gateway', 'login'], {
      cwd: process.cwd(),
      env: atlasEnv(homeDir, {
        // Many CLI browser openers print the URL when BROWSER is echo.
        // If atlas-skillhub opens a browser directly, polling still catches the token file once it is written.
        BROWSER: process.env.ATLAS_BROWSER ?? 'echo',
      }),
      shell: false,
      windowsHide: true,
    });
    login.child = child;

    child.stdout.on('data', (chunk) => {
      login.stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      login.stderr += chunk.toString();
    });
    child.on('error', (error) => {
      login.stderr += `\n${error.message}`;
      login.closed = true;
    });
    child.on('close', (code) => {
      login.closeCode = code;
      login.closed = true;
    });

    return login;
  });
}

function readAtlasTokenCache(homeDir?: string) {
  const file = atlasTokenFile(homeDir);
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as AtlasTokenCache;
  } catch {
    return {};
  }
}

function decodeJwtClaims(token?: string) {
  if (!token) return {};
  const parts = token.split('.');
  if (parts.length < 2) return {};
  try {
    const json = Buffer.from(parts[1], 'base64url').toString('utf8');
    return JSON.parse(json) as AtlasClaims;
  } catch {
    return {};
  }
}

export function getAtlasIdentity(homeDir?: string) {
  const tokenCache = readAtlasTokenCache(homeDir);
  const claims = decodeJwtClaims(tokenCache.access_token);
  const email = claims.email ?? claims.username ?? claims.sub;
  const displayName = claims.name ?? claims.ouName ?? claims.idpUsername ?? email ?? 'Liclick User';
  return {
    email,
    displayName,
    userId: email ? `atlas-${email.toLowerCase()}` : undefined,
  };
}

function avatarDataUrl(displayName: string, email?: string) {
  const hue = Math.abs([...`${displayName}${email ?? ''}`].reduce((sum, char) => sum + char.charCodeAt(0), 0)) % 360;
  const initial = (displayName.trim() || email?.trim() || 'L').slice(0, 1).toUpperCase();
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96"><defs><linearGradient id="g" x1="0" x2="1" y1="0" y2="1"><stop stop-color="hsl(${hue} 88% 62%)"/><stop offset="1" stop-color="hsl(${(hue + 54) % 360} 78% 56%)"/></linearGradient></defs><rect width="96" height="96" rx="48" fill="url(#g)"/><text x="50%" y="54%" text-anchor="middle" dominant-baseline="middle" font-family="Arial, sans-serif" font-size="42" font-weight="700" fill="white">${initial}</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

export async function getAtlasStatus(homeDir?: string) {
  const result = await runAtlas(['gateway', 'status'], 30_000, true, homeDir);
  const parsed = parseJsonFromOutput(result.stdout) as AtlasStatus;
  return {
    valid: Boolean(parsed.valid),
    expiresAt: typeof parsed.expires_at === 'string' ? parsed.expires_at : undefined,
    message: parsed.valid
      ? `莉刻/Atlas 已登录，有效期 ${typeof parsed.expires_at === 'string' ? parsed.expires_at : ''}`.trim()
      : trimOutput(result.stderr || result.stdout),
  };
}

async function createLoggedInSession(homeDir: string, request: IncomingMessage, response: ServerResponse) {
  const { email, displayName } = getAtlasIdentity(homeDir);
  const user = await upsertUser({
    id: email ? `atlas-${email.toLowerCase()}` : undefined,
    displayName,
    email,
    avatarUrl: avatarDataUrl(displayName, email),
    authSource: 'feishu-oauth',
    atlasHomeDir: homeDir,
  });
  await createSession(user.id, 'feishu-oauth', request, response);
  return user;
}

export async function startAtlasLogin(request: IncomingMessage, response: ServerResponse) {
  if (serverConfig.atlasLoginMode === 'service-token') {
    const status = await getAtlasStatus().catch((error) => ({
      valid: false,
      message: error instanceof Error ? error.message : 'Atlas status unavailable.',
    }));
    if (!status.valid) {
      throw new Error('服务器还没有配置莉刻/Atlas 登录凭证，或者当前用户授权未完成。');
    }
    const user = await createLoggedInSession(os.homedir(), request, response);
    return { user, status };
  }

  prunePendingAtlasLogins();
  const login = await startAtlasLoginProcess();

  await new Promise((resolve) => setTimeout(resolve, 1200));
  const status = await getAtlasStatus(login.homeDir).catch((error) => ({
    valid: false,
    message: error instanceof Error ? error.message : 'Atlas status unavailable.',
  })) as PublicAtlasStatus;
  if (status.valid) {
    const user = await createLoggedInSession(login.homeDir, request, response);
    pendingAtlasLogins.delete(login.id);
    return { user, status };
  }

  const output = `${login.stdout}\n${login.stderr}`;
  const redirectUrl = rewriteAuthUrlForRemoteBrowser(extractFirstUrl(output), login);
  return {
    loginId: login.id,
    redirectUrl,
    status,
    message: loginMessage(login, '飞书/IDaaS 登录任务已启动，请完成浏览器授权后等待页面自动同步。'),
  };
}

export async function pollAtlasLogin(loginId: string, request: IncomingMessage, response: ServerResponse) {
  prunePendingAtlasLogins();
  const login = pendingAtlasLogins.get(loginId);
  if (!login) throw new Error('登录任务已过期，请重新点击飞书登录。');
  const status = await getAtlasStatus(login.homeDir).catch((error) => ({
    valid: false,
    message: error instanceof Error ? error.message : 'Atlas status unavailable.',
  })) as PublicAtlasStatus;
  if (status.valid) {
    const user = await createLoggedInSession(login.homeDir, request, response);
    pendingAtlasLogins.delete(login.id);
    return { done: true, user, status };
  }
  if (login.closed && login.closeCode !== 0) {
    pendingAtlasLogins.delete(login.id);
    throw new Error(loginMessage(login, `飞书/IDaaS 登录任务已结束但没有拿到授权，退出码 ${login.closeCode ?? 'unknown'}。`));
  }
  return {
    done: false,
    loginId,
    redirectUrl: rewriteAuthUrlForRemoteBrowser(extractFirstUrl(`${login.stdout}\n${login.stderr}`), login),
    status,
    message: loginMessage(login, '等待飞书/IDaaS 授权完成。'),
  };
}

function proxyLocalCallback(port: number, originalUrl: URL) {
  return new Promise<{ statusCode: number; contentType: string; body: string }>((resolve, reject) => {
    const targetPath = `/callback${originalUrl.search}`;
    const request = http.get(
      {
        hostname: '127.0.0.1',
        port,
        path: targetPath,
        timeout: 15_000,
      },
      (callbackResponse) => {
        const chunks: Buffer[] = [];
        callbackResponse.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        callbackResponse.on('end', () => {
          resolve({
            statusCode: callbackResponse.statusCode ?? 200,
            contentType: String(callbackResponse.headers['content-type'] ?? 'text/html; charset=utf-8'),
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );
    request.on('timeout', () => {
      request.destroy(new Error('Atlas local callback timed out.'));
    });
    request.on('error', reject);
  });
}

export async function handleAtlasLoginCallback(loginId: string, url: URL) {
  prunePendingAtlasLogins();
  const login = pendingAtlasLogins.get(loginId);
  if (!login) throw new Error('登录任务已过期，请重新点击飞书登录。');
  const callbackPort = login.callbackPort ?? Number(process.env.ATLAS_CALLBACK_PORT ?? 20265);
  const result = await proxyLocalCallback(callbackPort, url);
  return {
    ...result,
    body:
      result.body ||
      '<!doctype html><meta charset="utf-8"><title>Liclick 登录完成</title><body style="font-family:sans-serif;padding:32px">飞书/IDaaS 授权已返回服务器，请回到 Liclick 页面。</body>',
  };
}

export async function checkLiclickApiAccess(user?: AuthUser) {
  const status = await getAtlasStatus(user?.atlasHomeDir);
  if (!status.valid) {
    return {
      ok: false,
      status,
      tools: [] as string[],
      message: '莉刻/Atlas 未登录。',
    };
  }
  const result = await runAtlas(['gateway', 'list-tools', '--service', 'liclick'], 60_000, false, user?.atlasHomeDir);
  const toolNames = [...result.stdout.matchAll(/^\s{2}([a-zA-Z0-9_]+)\(/gm)].map((match) => match[1]);
  return {
    ok: toolNames.length > 0,
    status,
    tools: toolNames,
    message: toolNames.length > 0 ? `莉刻 API 可用，发现 ${toolNames.length} 个工具。` : '莉刻 API 已响应，但没有解析到工具。',
  };
}
