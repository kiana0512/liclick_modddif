import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { setUserAtlasHomeDir } from './sessionService.js';
import { serverConfig } from '../config.js';
import type { AuthUser } from './authTypes.js';

type AtlasCommandResult = {
  code: number | null;
  stdout: string;
  stderr: string;
};

type AtlasToolCallResult = {
  stdout: string;
  raw: unknown;
};

type AtlasStatus = {
  valid?: boolean;
  expires_at?: string;
};

type PendingAtlasLogin = {
  id: string;
  userId: string;
  homeDir: string;
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

type AtlasTokenCacheModule = {
  readCache?: (tokenFile: string) => AtlasTokenCache | undefined;
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

function atlasNodePath() {
  return process.env.ATLAS_NODE_PATH || process.execPath || 'node';
}

function atlasTokenFile(homeDir?: string) {
  if (homeDir) return path.join(homeDir, '.atlas-ai-gateway-oauth.json');
  const configuredTokenFile = process.env.ATLAS_TOKEN_FILE?.trim();
  if (configuredTokenFile) return path.resolve(configuredTokenFile);
  return path.join(os.homedir(), '.atlas-ai-gateway-oauth.json');
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

function terminateAtlasProcessTree(child: ChildProcessWithoutNullStreams) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform !== 'win32') {
    child.kill('SIGTERM');
    const fallback = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }, 1_500);
    fallback.unref();
    return;
  }

  const killer = spawn(
    'taskkill.exe',
    ['/pid', String(child.pid), '/t', '/f'],
    { shell: false, windowsHide: true, stdio: 'ignore' },
  );
  killer.once('error', () => child.kill('SIGKILL'));
}

export function runAtlas(args: string[], timeoutMs: number, allowNonZero = false, homeDir?: string, extraEnv: NodeJS.ProcessEnv = {}) {
  const script = atlasScriptPath();
  if (!script) {
    return Promise.reject(
      new Error('未找到 @lilith/atlas-skillhub，请先安装莉刻 Atlas 运行时。'),
    );
  }
  return new Promise<AtlasCommandResult>((resolve, reject) => {
    const commandArgs = [...args];
    if (commandArgs[0] === 'gateway' && !commandArgs.includes('--token-file')) {
      commandArgs.push('--token-file', atlasTokenFile(homeDir));
    }
    const child = spawn(atlasNodePath(), [script, ...commandArgs], {
      cwd: process.cwd(),
      env: atlasEnv(homeDir, extraEnv),
      shell: false,
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let forcedSettlement: NodeJS.Timeout | undefined;
    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forcedSettlement) clearTimeout(forcedSettlement);
      callback();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminateAtlasProcessTree(child);
      forcedSettlement = setTimeout(() => {
        settle(() => reject(new Error('atlas-skillhub 调用超时，子进程已强制清理。')));
      }, 3_000);
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.once('error', (error) => {
      settle(() => reject(error));
    });
    child.once('close', (code) => {
      settle(() => {
        if (timedOut) {
          reject(new Error('atlas-skillhub 调用超时，子进程已清理。'));
        } else if (code === 0 || allowNonZero) {
          resolve({ code, stdout, stderr });
        } else {
          reject(new Error(trimOutput(stderr || stdout || `atlas-skillhub exited ${code}`)));
        }
      });
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

function sanitizeAtlasLoginMessage(text: string) {
  return trimOutput(
    text
      .replace(/https?:\/\/[^\s"'<>]+/g, '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .join('\n'),
  );
}

function loginMessage(login: PendingAtlasLogin, fallback: string) {
  return sanitizeAtlasLoginMessage(`${login.stderr}\n${login.stdout}`) || fallback;
}

function startAtlasLoginProcess(userId: string) {
  const script = atlasScriptPath();
  if (!script) throw new Error('未找到 @lilith/atlas-skillhub，请先安装莉刻 Atlas 运行时。');

  const id = randomUUID();
  return createAtlasHomeDir().then((homeDir) => {
    const login: PendingAtlasLogin = {
      id,
      userId,
      homeDir,
      startedAt: Date.now(),
      stdout: '',
      stderr: '',
      closed: false,
    };
    pendingAtlasLogins.set(id, login);

    const child = spawn(
      atlasNodePath(),
      [script, 'gateway', 'login', '--token-file', atlasTokenFile(homeDir)],
      {
        cwd: process.cwd(),
        env: atlasEnv(homeDir, {
          // Many CLI browser openers print the URL when BROWSER is echo.
          // If atlas-skillhub opens a browser directly, polling still catches the token file once it is written.
          BROWSER: process.env.ATLAS_BROWSER ?? 'echo',
        }),
        shell: false,
        windowsHide: true,
      },
    );
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

let encryptedTokenCacheReaderPromise:
  | Promise<(tokenFile: string) => AtlasTokenCache | undefined>
  | undefined;

function getEncryptedTokenCacheReader() {
  encryptedTokenCacheReaderPromise ??= (async () => {
    const script = atlasScriptPath();
    if (!script) throw new Error('Atlas runtime is unavailable.');
    const runtimeDir = path.dirname(script);
    const candidates = fs
      .readdirSync(runtimeDir)
      .filter((name) => name.endsWith('.js') && name !== path.basename(script));

    for (const name of candidates) {
      const candidate = path.join(runtimeDir, name);
      const source = fs.readFileSync(candidate, 'utf8');
      if (!source.includes('function readCache(') || !source.includes('readCache,')) continue;
      const module = (await import(pathToFileURL(candidate).href)) as AtlasTokenCacheModule;
      if (typeof module.readCache === 'function') return module.readCache;
    }
    throw new Error('Installed Atlas runtime does not expose its secure token cache reader.');
  })();
  return encryptedTokenCacheReaderPromise;
}

async function readCompatibleAtlasTokenCache(homeDir?: string) {
  const tokenFile = atlasTokenFile(homeDir);
  const plainCache = readAtlasTokenCache(homeDir);
  if (plainCache.access_token) return plainCache;
  const readSecureCache = await getEncryptedTokenCacheReader();
  return readSecureCache(tokenFile) ?? {};
}

function assertValidAtlasToken(cache: AtlasTokenCache, tokenFile: string) {
  if (!cache.access_token) throw new Error(`Atlas token cache is missing access_token: ${tokenFile}`);
  if (!cache.gateway_url) throw new Error(`Atlas token cache is missing gateway_url: ${tokenFile}`);
  if (!cache.expires_at) throw new Error(`Atlas token cache is missing expires_at: ${tokenFile}`);
  const expiresAt = new Date(cache.expires_at);
  if (Number.isNaN(expiresAt.getTime()) || expiresAt <= new Date()) {
    throw new Error('Atlas 登录凭证已过期，请重新登录莉刻/Atlas。');
  }
}

export async function callAtlasToolJson(
  service: string,
  tool: string,
  toolArguments: Record<string, unknown>,
  timeoutMs: number,
  homeDir?: string,
): Promise<AtlasToolCallResult> {
  if (!homeDir?.trim()) {
    throw new Error('LICLICK_PERSONAL_ACCOUNT_REQUIRED: 禁止使用服务器共享 Atlas 凭据调用莉刻。');
  }
  const tokenFile = atlasTokenFile(homeDir);
  const cache = await readCompatibleAtlasTokenCache(homeDir);
  assertValidAtlasToken(cache, tokenFile);
  const gatewayUrl = String(cache.gateway_url).replace(/\/+$/, '');
  const body = JSON.stringify({
    jsonrpc: '2.0',
    method: 'tools/call',
    id: Date.now(),
    params: {
      name: tool,
      arguments: toolArguments,
    },
  });
  let response: Response;
  try {
    response = await fetch(`${gatewayUrl}/mcp-servers/${service}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        authorization: `Bearer ${cache.access_token}`,
        'user-agent': 'liclick-3d-texture/0.1.0',
        'x-auth-method': 'idaas-jwt',
        'x-atlas-cli-domain': 'gateway',
        'x-atlas-cli-command': 'call-tool',
      },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new Error(`Atlas gateway network error: ${error instanceof Error ? error.message : String(error)}`);
  }
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Atlas gateway HTTP ${response.status}: ${trimOutput(text)}`);
  }
  const raw = text.trim() ? (JSON.parse(text) as Record<string, unknown>) : {};
  if (raw.error && typeof raw.error === 'object') {
    const error = raw.error as Record<string, unknown>;
    throw new Error(typeof error.message === 'string' ? error.message : JSON.stringify(error));
  }
  const result = raw.result ?? raw;
  return {
    stdout: JSON.stringify(result),
    raw,
  };
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

export async function getAtlasIdentity(homeDir?: string) {
  const tokenCache = await readCompatibleAtlasTokenCache(homeDir);
  const claims = decodeJwtClaims(tokenCache.access_token);
  const email = claims.email ?? claims.username ?? claims.sub;
  const displayName = claims.name ?? claims.ouName ?? claims.idpUsername ?? email ?? 'Liclick User';
  return {
    email,
    displayName,
    userId: email ? `atlas-${email.toLowerCase()}` : undefined,
  };
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

function isManagedAtlasHomeDir(homeDir?: string) {
  if (!homeDir) return false;
  const relative = path.relative(userAtlasHomesRoot(), path.resolve(homeDir));
  return Boolean(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function removeManagedAtlasHomeDir(homeDir?: string) {
  if (!isManagedAtlasHomeDir(homeDir)) return;
  await fs.promises.rm(path.resolve(homeDir!), { recursive: true, force: true });
}

function bindingResponse(login: PendingAtlasLogin) {
  return {
    loginId: login.id,
    status: 'pending' as const,
    redirectUrl: extractFirstUrl(`${login.stdout}\n${login.stderr}`),
    message: loginMessage(login, '请在莉刻授权页面完成当前账号授权。'),
  };
}

export async function startPersonalLiclickAccountBinding(user: AuthUser) {
  if (!user.email) throw new Error('当前飞书账号没有邮箱，无法校验莉刻账号归属。');
  prunePendingAtlasLogins();
  for (const login of pendingAtlasLogins.values()) {
    if (login.userId !== user.id) continue;
    if (!login.closed) login.child?.kill('SIGTERM');
    pendingAtlasLogins.delete(login.id);
    await removeManagedAtlasHomeDir(login.homeDir);
  }
  const login = await startAtlasLoginProcess(user.id);
  const deadline = Date.now() + 3_000;
  while (!login.closed && !extractFirstUrl(`${login.stdout}\n${login.stderr}`) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return bindingResponse(login);
}

export async function pollPersonalLiclickAccountBinding(loginId: string, user: AuthUser) {
  prunePendingAtlasLogins();
  const login = pendingAtlasLogins.get(loginId);
  if (!login || login.userId !== user.id) throw new Error('莉刻账号授权请求不存在或已过期。');
  const tokenFile = atlasTokenFile(login.homeDir);
  if (fs.existsSync(tokenFile)) {
    const status = await getAtlasStatus(login.homeDir);
    if (status.valid) {
      const identity = await getAtlasIdentity(login.homeDir);
      if (!user.email || !identity.email || user.email.toLowerCase() !== identity.email.toLowerCase()) {
        pendingAtlasLogins.delete(login.id);
        if (!login.closed) login.child?.kill('SIGTERM');
        await removeManagedAtlasHomeDir(login.homeDir);
        throw new Error('莉刻账号与当前飞书登录账号不一致，已拒绝绑定。');
      }
      const savedUser = await setUserAtlasHomeDir(user.id, login.homeDir);
      if (!savedUser) throw new Error('当前用户不存在，无法保存莉刻账号绑定。');
      pendingAtlasLogins.delete(login.id);
      if (!login.closed) login.child?.kill('SIGTERM');
      return {
        loginId: login.id,
        status: 'bound' as const,
        email: identity.email,
        expiresAt: status.expiresAt,
        message: '莉刻账号已绑定到当前飞书用户。',
      };
    }
  }
  if (login.closed && login.closeCode !== 0) {
    pendingAtlasLogins.delete(login.id);
    await removeManagedAtlasHomeDir(login.homeDir);
    throw new Error(loginMessage(login, '莉刻账号授权失败，请重试。'));
  }
  return bindingResponse(login);
}

export async function getPersonalLiclickAccount(user: AuthUser) {
  if (!user.atlasHomeDir) return { bound: false as const };
  try {
    const [status, identity] = await Promise.all([
      getAtlasStatus(user.atlasHomeDir),
      getAtlasIdentity(user.atlasHomeDir),
    ]);
    const matches = Boolean(
      status.valid && user.email && identity.email && user.email.toLowerCase() === identity.email.toLowerCase(),
    );
    return {
      bound: matches,
      email: matches ? identity.email : undefined,
      expiresAt: matches ? status.expiresAt : undefined,
      reason: matches ? undefined : '个人莉刻账号未登录、已过期或与飞书账号不一致。',
    };
  } catch {
    return { bound: false as const, reason: '个人莉刻账号不可用，请重新绑定。' };
  }
}

export async function unlinkPersonalLiclickAccount(user: AuthUser) {
  await setUserAtlasHomeDir(user.id, undefined);
  await removeManagedAtlasHomeDir(user.atlasHomeDir);
}

export async function checkLiclickApiAccess(user?: AuthUser) {
  if (!user?.atlasHomeDir) {
    return {
      ok: false,
      status: { valid: false, message: '当前飞书用户尚未绑定个人莉刻账号。' },
      tools: [] as string[],
      message: '当前飞书用户尚未绑定个人莉刻账号。',
    };
  }
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
