import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
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
  startedAt: number;
  child: ChildProcessWithoutNullStreams;
  callbackPort: number;
  stdout: string;
  stderr: string;
  closed: boolean;
  closeCode?: number | null;
  linkedOAuthLoginId?: string;
  email?: string;
  expiresAt?: string;
  error?: string;
};

type AtlasTokenCache = {
  access_token?: string;
  expires_at?: string;
  gateway_url?: string;
};

type AtlasTokenCacheModule = {
  readCache?: (tokenFile: string) => AtlasTokenCache | undefined;
};

export type AtlasRuntimeCompatibility = {
  ok: boolean;
  version?: string;
  minimumVersion: string;
  secureTokenCacheReader: boolean;
  message?: string;
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
const minimumCompatibleAtlasSkillhubVersion = '2.9.1';
const atlasLocalCallbackPort = 20265;
const atlasCloudAuthSignalFragments = ['ARKCLAW', 'WORKLOAD', 'TIP_TOKEN'];

function atlasScriptPath() {
  const appData = process.env.APPDATA;
  const explicitPath = process.env.ATLAS_SKILLHUB_PATH;
  const candidates = [
    explicitPath ?? '',
    appData
      ? path.join(appData, 'npm', 'node_modules', '@lilith', 'atlas-skillhub', 'dist', 'index.js')
      : '',
    path.join(
      os.homedir(),
      'AppData',
      'Roaming',
      'npm',
      'node_modules',
      '@lilith',
      'atlas-skillhub',
      'dist',
      'index.js',
    ),
    path.join(
      os.homedir(),
      '.npm-global',
      'lib',
      'node_modules',
      '@lilith',
      'atlas-skillhub',
      'dist',
      'index.js',
    ),
    path.join(
      os.homedir(),
      '.local',
      'lib',
      'node_modules',
      '@lilith',
      'atlas-skillhub',
      'dist',
      'index.js',
    ),
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
    if (first >= 0 && last > first)
      return JSON.parse(raw.slice(first, last + 1)) as Record<string, unknown>;
    return {};
  }
}

export function buildAtlasProcessEnv(
  baseEnv: NodeJS.ProcessEnv,
  homeDir?: string,
  extraEnv: NodeJS.ProcessEnv = {},
) {
  const env: NodeJS.ProcessEnv = {
    ...baseEnv,
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
  if (homeDir) {
    for (const key of Object.keys(env)) {
      const upperKey = key.toUpperCase();
      if (
        upperKey === 'KUBERNETES_SERVICE_HOST' ||
        atlasCloudAuthSignalFragments.some((fragment) => upperKey.includes(fragment))
      ) {
        delete env[key];
      }
    }
  }
  return env;
}

function atlasEnv(homeDir?: string, extraEnv: NodeJS.ProcessEnv = {}) {
  return buildAtlasProcessEnv(process.env, homeDir, extraEnv);
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

  const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {
    shell: false,
    windowsHide: true,
    stdio: 'ignore',
  });
  killer.once('error', () => child.kill('SIGKILL'));
}

export function runAtlas(
  args: string[],
  timeoutMs: number,
  allowNonZero = false,
  homeDir?: string,
  extraEnv: NodeJS.ProcessEnv = {},
) {
  const script = atlasScriptPath();
  if (!script) {
    return Promise.reject(new Error('未找到 @lilith/atlas-skillhub，请先安装莉刻 Atlas 运行时。'));
  }
  return new Promise<AtlasCommandResult>((resolve, reject) => {
    const commandArgs = [...args];
    if (commandArgs[0] === 'gateway' && !commandArgs.includes('--token-file')) {
      commandArgs.push('--token-file', atlasTokenFile(homeDir));
    }
    if (commandArgs[0] === 'gateway' && !commandArgs.includes('--gateway-env')) {
      commandArgs.push('--gateway-env', serverConfig.atlasGateway.environment);
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
      if (!login.closed) terminateAtlasProcessTree(login.child);
      pendingAtlasLogins.delete(id);
      void removeManagedAtlasHomeDir(login.homeDir);
    }
  }
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

function reserveLoopbackPort() {
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('无法分配 Atlas 授权回调端口。'));
        return;
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

function waitForLoopbackListener(login: PendingAtlasLogin, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise<void>((resolve, reject) => {
    const attempt = () => {
      if (login.closed) {
        reject(new Error(loginMessage(login, 'Atlas 安全授权进程启动失败。')));
        return;
      }
      const socket = net.createConnection({ host: '127.0.0.1', port: login.callbackPort });
      socket.once('connect', () => {
        socket.destroy();
        resolve();
      });
      socket.once('error', () => {
        socket.destroy();
        if (Date.now() >= deadline) reject(new Error('Atlas 安全授权回调启动超时。'));
        else setTimeout(attempt, 50);
      });
    };
    attempt();
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

function atlasRuntimeVersion(script: string) {
  let directory = path.dirname(script);
  for (let depth = 0; depth < 4; depth += 1) {
    const packageFile = path.join(directory, 'package.json');
    if (fs.existsSync(packageFile)) {
      try {
        const packageJson = JSON.parse(fs.readFileSync(packageFile, 'utf8')) as {
          name?: string;
          version?: string;
        };
        if (packageJson.name === '@lilith/atlas-skillhub') return packageJson.version;
      } catch {
        return undefined;
      }
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return undefined;
}

function atlasSecureTokenModulePath() {
  const script = atlasScriptPath();
  if (!script) throw new Error('ATLAS_RUNTIME_UNAVAILABLE: Atlas runtime is unavailable.');
  const runtimeDir = path.dirname(script);
  const candidates = fs
    .readdirSync(runtimeDir)
    .filter((name) => name.endsWith('.js') && name !== path.basename(script));

  for (const name of candidates) {
    const candidate = path.join(runtimeDir, name);
    const source = fs.readFileSync(candidate, 'utf8');
    if (
      source.includes('function readCache(') &&
      source.includes('readCache,') &&
      source.includes('function authenticate(') &&
      source.includes('authenticate,')
    ) {
      return candidate;
    }
  }
  const version = atlasRuntimeVersion(script) ?? 'unknown';
  throw new Error(
    `ATLAS_RUNTIME_INCOMPATIBLE: @lilith/atlas-skillhub ${version} does not expose its secure token cache reader and login bridge; minimum supported version is ${minimumCompatibleAtlasSkillhubVersion}.`,
  );
}

async function loadEncryptedTokenCacheReader() {
  const candidate = atlasSecureTokenModulePath();
  const moduleUrl = pathToFileURL(candidate);
  moduleUrl.searchParams.set('mtime', String(fs.statSync(candidate).mtimeMs));
  const module = (await import(moduleUrl.href)) as AtlasTokenCacheModule;
  if (typeof module.readCache === 'function') return module.readCache;
  throw new Error('ATLAS_RUNTIME_INCOMPATIBLE: Atlas secure token cache reader is unavailable.');
}

async function startSecureAtlasLoginProcess(
  userId: string,
  options: { linkedOAuthLoginId?: string } = {},
) {
  await getEncryptedTokenCacheReader();
  const homeDir = await createAtlasHomeDir();
  const callbackPort = serverConfig.idaasJwtSso.enabled
    ? await reserveLoopbackPort()
    : atlasLocalCallbackPort;
  const helperOptions = {
    moduleUrl: pathToFileURL(atlasSecureTokenModulePath()).href,
    gatewayBaseUrl: serverConfig.atlasGateway.url,
    gatewayEnv: serverConfig.atlasGateway.environment,
    callbackPort,
    tokenFile: atlasTokenFile(homeDir),
  };
  const helperSource = `const options=JSON.parse(Buffer.from(process.env.LI3D_ATLAS_BINDING_OPTIONS,'base64url').toString('utf8'));const runtime=await import(options.moduleUrl);await runtime.authenticate({gatewayBaseUrl:options.gatewayBaseUrl,gatewayEnv:options.gatewayEnv,callbackPort:options.callbackPort,timeoutSeconds:600,tokenFile:options.tokenFile,localOnly:true});`;
  const child = spawn(atlasNodePath(), ['--input-type=module', '--eval', helperSource], {
    cwd: process.cwd(),
    env: atlasEnv(homeDir, {
      LI3D_ATLAS_BINDING_OPTIONS: Buffer.from(JSON.stringify(helperOptions)).toString('base64url'),
      // Prevent the helper from opening a browser on the server. LI3D owns the
      // public callback and forwards the token to this loopback-only listener.
      PATH: '',
      Path: '',
    }),
    shell: false,
    windowsHide: true,
  });
  const login: PendingAtlasLogin = {
    id: randomUUID(),
    userId,
    homeDir,
    child,
    callbackPort,
    startedAt: Date.now(),
    stdout: '',
    stderr: '',
    closed: false,
    linkedOAuthLoginId: options.linkedOAuthLoginId,
  };
  pendingAtlasLogins.set(login.id, login);
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
  try {
    await waitForLoopbackListener(login);
    return login;
  } catch (error) {
    pendingAtlasLogins.delete(login.id);
    if (!login.closed) terminateAtlasProcessTree(login.child);
    await removeManagedAtlasHomeDir(homeDir);
    throw error;
  }
}

function getEncryptedTokenCacheReader() {
  if (!encryptedTokenCacheReaderPromise) {
    const attempt = loadEncryptedTokenCacheReader();
    const guarded = attempt.catch((error) => {
      if (encryptedTokenCacheReaderPromise === guarded) {
        encryptedTokenCacheReaderPromise = undefined;
      }
      throw error;
    });
    encryptedTokenCacheReaderPromise = guarded;
  }
  return encryptedTokenCacheReaderPromise;
}

export async function getAtlasRuntimeCompatibility(): Promise<AtlasRuntimeCompatibility> {
  const script = atlasScriptPath();
  const version = script ? atlasRuntimeVersion(script) : undefined;
  try {
    await getEncryptedTokenCacheReader();
    return {
      ok: true,
      version,
      minimumVersion: minimumCompatibleAtlasSkillhubVersion,
      secureTokenCacheReader: true,
    };
  } catch (error) {
    return {
      ok: false,
      version,
      minimumVersion: minimumCompatibleAtlasSkillhubVersion,
      secureTokenCacheReader: false,
      message: error instanceof Error ? error.message : 'ATLAS_RUNTIME_INCOMPATIBLE',
    };
  }
}

async function readCompatibleAtlasTokenCache(homeDir?: string) {
  const tokenFile = atlasTokenFile(homeDir);
  const plainCache = readAtlasTokenCache(homeDir);
  if (plainCache.access_token) return plainCache;
  const readSecureCache = await getEncryptedTokenCacheReader();
  return readSecureCache(tokenFile) ?? {};
}

function assertValidAtlasToken(cache: AtlasTokenCache, tokenFile: string) {
  if (!cache.access_token)
    throw new Error(`Atlas token cache is missing access_token: ${tokenFile}`);
  if (!cache.gateway_url) throw new Error(`Atlas token cache is missing gateway_url: ${tokenFile}`);
  if (
    cache.gateway_url.replace(/\/+$/, '') !== serverConfig.atlasGateway.url.replace(/\/+$/, '')
  ) {
    throw new Error(
      `Atlas 登录凭证属于其他环境，请重新绑定当前 ${serverConfig.atlasGateway.environment} 环境的莉刻账号。`,
    );
  }
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
    throw new Error(
      `Atlas gateway network error: ${error instanceof Error ? error.message : String(error)}`,
    );
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
  return (
    Boolean(relative) &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

async function removeManagedAtlasHomeDir(homeDir?: string) {
  if (!isManagedAtlasHomeDir(homeDir)) return;
  await fs.promises.rm(path.resolve(homeDir!), { recursive: true, force: true });
}

export function buildPersonalLiclickAccountCallbackUrl(
  publicWorkspaceUrl: string,
  publicPath: string,
) {
  const callbackUrl = new URL(publicWorkspaceUrl);
  const configuredPath = publicPath || callbackUrl.pathname;
  const normalizedPublicPath = `/${configuredPath.split('/').filter(Boolean).join('/')}`;
  callbackUrl.pathname = `${normalizedPublicPath === '/' ? '' : normalizedPublicPath}/api/liclick/account-binding/callback`;
  callbackUrl.search = '';
  callbackUrl.hash = '';
  return callbackUrl;
}

export function buildPersonalLiclickAccountTargetUrl(
  publicWorkspaceUrl: string,
  publicPath: string,
  loginId: string,
) {
  const targetUrl = buildPersonalLiclickAccountCallbackUrl(publicWorkspaceUrl, publicPath);
  targetUrl.pathname = targetUrl.pathname.replace(/\/callback$/, '/complete');
  targetUrl.searchParams.set('loginId', loginId);
  return targetUrl;
}

export function resolvePersonalLiclickAccountTargetLoginId(
  targetUrl: string,
  publicWorkspaceUrl: string,
  publicPath: string,
) {
  let candidate: URL;
  try {
    candidate = new URL(targetUrl);
  } catch {
    throw new Error('IDaaS 回调缺少有效的账号关联目标。');
  }
  const expected = buildPersonalLiclickAccountTargetUrl(
    publicWorkspaceUrl,
    publicPath,
    '00000000-0000-4000-8000-000000000000',
  );
  const entries = [...candidate.searchParams.entries()];
  const loginId = entries.length === 1 && entries[0]?.[0] === 'loginId' ? entries[0][1] : '';
  if (
    candidate.origin !== expected.origin ||
    candidate.pathname !== expected.pathname ||
    candidate.username ||
    candidate.password ||
    candidate.hash ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(loginId)
  ) {
    throw new Error('IDaaS 回调的账号关联目标无效。');
  }
  return loginId;
}

export function buildPersonalLiclickAccountSsoUrl(
  idaasSsoUrl: string,
  enterpriseId: string,
  targetUrl: URL,
) {
  const redirectUrl = new URL(idaasSsoUrl);
  redirectUrl.searchParams.delete('redirect_uri');
  redirectUrl.searchParams.delete('state');
  redirectUrl.searchParams.set('target_url', targetUrl.toString());
  if (enterpriseId) redirectUrl.searchParams.set('enterpriseId', enterpriseId);
  return redirectUrl;
}

export function buildLocalAtlasRuntimeSsoUrl(
  idaasSsoUrl: string,
  enterpriseId: string,
  callbackPort: number,
) {
  const redirectUrl = new URL(idaasSsoUrl);
  redirectUrl.searchParams.delete('target_url');
  redirectUrl.searchParams.delete('state');
  redirectUrl.searchParams.set('redirect_uri', `http://localhost:${callbackPort}/callback`);
  if (enterpriseId) redirectUrl.searchParams.set('enterpriseId', enterpriseId);
  return redirectUrl;
}

function bindingResponse(login: PendingAtlasLogin) {
  const redirectUrl = serverConfig.idaasJwtSso.enabled
    ? buildPersonalLiclickAccountSsoUrl(
        serverConfig.idaasJwtSso.url,
        serverConfig.idaasJwtSso.enterpriseId,
        buildPersonalLiclickAccountTargetUrl(
          serverConfig.publicWorkspaceUrl,
          serverConfig.publicPath,
          login.id,
        ),
      )
    : buildLocalAtlasRuntimeSsoUrl(
        serverConfig.idaasJwtSso.url,
        serverConfig.idaasJwtSso.enterpriseId,
        login.callbackPort,
      );
  return {
    loginId: login.id,
    status: login.email ? ('bound' as const) : ('pending' as const),
    redirectUrl: login.email ? undefined : redirectUrl.toString(),
    email: login.email,
    expiresAt: login.expiresAt,
    message: login.email
      ? '当前飞书用户的莉刻账号已自动关联。'
      : login.error ?? '正在使用当前企业身份安全关联莉刻账号。',
  };
}

export async function startPersonalLiclickAccountBinding(
  user: AuthUser,
  options: { linkedOAuthLoginId?: string } = {},
) {
  if (serverConfig.sharedLiclickTestAccount.enabled) {
    const account = await getPersonalLiclickAccount(user);
    if (!account.bound) {
      throw new Error(account.reason ?? '服务器共享测试莉刻账号不可用。');
    }
    return {
      loginId: 'shared-test-account',
      status: 'bound' as const,
      redirectUrl: undefined,
      email: account.email,
      expiresAt: account.expiresAt,
      message: '测试环境统一使用服务器配置的莉刻账号。',
    };
  }
  if (!user.email) throw new Error('当前飞书账号没有邮箱，无法校验莉刻账号归属。');
  prunePendingAtlasLogins();
  for (const login of pendingAtlasLogins.values()) {
    if (login.userId !== user.id) continue;
    if (!login.closed) terminateAtlasProcessTree(login.child);
    pendingAtlasLogins.delete(login.id);
    if (!login.email) await removeManagedAtlasHomeDir(login.homeDir);
  }
  const login = await startSecureAtlasLoginProcess(user.id, options);
  return bindingResponse(login);
}

export async function pollPersonalLiclickAccountBinding(loginId: string, user: AuthUser) {
  if (serverConfig.sharedLiclickTestAccount.enabled && loginId === 'shared-test-account') {
    return startPersonalLiclickAccountBinding(user);
  }
  prunePendingAtlasLogins();
  const login = pendingAtlasLogins.get(loginId);
  if (!login || login.userId !== user.id) throw new Error('莉刻账号授权请求不存在或已过期。');
  if (login.error) throw new Error(login.error);
  if (!serverConfig.idaasJwtSso.enabled && login.closed && !login.email) {
    try {
      if (login.closeCode !== 0) {
        throw new Error(loginMessage(login, 'Atlas 安全凭据写入失败。'));
      }
      return await finalizePersonalLiclickAccountBinding(login, user);
    } catch (error) {
      login.error = error instanceof Error ? error.message : '莉刻账号关联失败。';
      await removeManagedAtlasHomeDir(login.homeDir);
      throw error;
    }
  }
  return bindingResponse(login);
}

export function getPersonalLiclickAccountCallbackHtml(targetUrl: string, user: AuthUser) {
  const loginId = resolvePersonalLiclickAccountTargetLoginId(
    targetUrl,
    serverConfig.publicWorkspaceUrl,
    serverConfig.publicPath,
  );
  const login = pendingAtlasLogins.get(loginId);
  if (!login || login.userId !== user.id)
    throw new Error('莉刻账号授权请求不存在或不属于当前用户。');
  const serializedTargetUrl = JSON.stringify(targetUrl).replace(/</g, '\\u003c');
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>LI3D 账号关联</title><body style="font-family:Arial,'Microsoft YaHei',sans-serif;background:#090a18;color:#fff;padding:40px"><h2>正在关联莉刻账号</h2><p id="status">正在安全校验当前企业身份，请稍候…</p><script>(async()=>{const status=document.getElementById('status');try{const fragment=new URLSearchParams(location.hash.replace(/^#/,''));const query=new URLSearchParams(location.search);const idToken=fragment.get('id_token')||query.get('id_token');const accessToken=fragment.get('access_token')||query.get('access_token');const targetUrl=${serializedTargetUrl};const callbackPath=location.pathname;history.replaceState(null,'',callbackPath);if(!idToken&&!accessToken)throw new Error('IDaaS 回调缺少身份令牌');const response=await fetch(callbackPath,{method:'POST',credentials:'include',headers:{'content-type':'application/json'},body:JSON.stringify({idToken,accessToken,targetUrl})});const payload=await response.json().catch(()=>({}));if(!response.ok)throw new Error(payload.error||'账号关联失败');status.textContent='账号关联成功，可以返回 LI3D。';try{window.opener&&window.opener.postMessage({type:'liclick-auth-callback',success:true},'*')}catch{}setTimeout(()=>window.close(),500)}catch(error){status.textContent=error instanceof Error?error.message:'账号关联失败';try{window.opener&&window.opener.postMessage({type:'liclick-auth-callback',success:false},'*')}catch{}}})();</script></body></html>`;
}

function waitForAtlasLoginExit(login: PendingAtlasLogin, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise<void>((resolve, reject) => {
    const check = () => {
      if (login.closed) {
        if (login.closeCode === 0) resolve();
        else reject(new Error(loginMessage(login, 'Atlas 安全凭据写入失败。')));
        return;
      }
      if (Date.now() >= deadline) {
        terminateAtlasProcessTree(login.child);
        reject(new Error('Atlas 安全凭据写入超时。'));
        return;
      }
      setTimeout(check, 50);
    };
    check();
  });
}

async function finalizePersonalLiclickAccountBinding(login: PendingAtlasLogin, user: AuthUser) {
  const tokenCache = await readCompatibleAtlasTokenCache(login.homeDir);
  assertValidAtlasToken(tokenCache, atlasTokenFile(login.homeDir));
  await runAtlas(['gateway', 'list-tools', '--service', 'liclick'], 60_000, false, login.homeDir);
  const identity = await getAtlasIdentity(login.homeDir);
  if (!identity.email || identity.email.trim().toLowerCase() !== user.email?.trim().toLowerCase()) {
    throw new Error('莉刻账号与当前飞书登录账号不一致，已拒绝关联。');
  }
  const savedUser = await setUserAtlasHomeDir(user.id, login.homeDir);
  if (!savedUser) throw new Error('当前用户不存在，无法保存莉刻账号关联。');
  login.email = identity.email;
  login.expiresAt = tokenCache.expires_at;
  return { ...bindingResponse(login), linkedOAuthLoginId: login.linkedOAuthLoginId };
}

export async function completePersonalLiclickAccountBinding(
  loginId: string,
  user: AuthUser,
  tokens: { idToken?: string; accessToken?: string },
) {
  prunePendingAtlasLogins();
  const login = pendingAtlasLogins.get(loginId);
  if (!login || login.userId !== user.id) throw new Error('莉刻账号授权请求不存在或不属于当前用户。');
  if (!user.email) throw new Error('当前飞书账号没有邮箱，无法校验莉刻账号归属。');
  if (login.email) return { ...bindingResponse(login), linkedOAuthLoginId: login.linkedOAuthLoginId };
  const idToken = tokens.idToken?.trim();
  const accessToken = tokens.accessToken?.trim();
  if (!idToken && !accessToken) throw new Error('IDaaS 回调缺少有效身份令牌。');
  try {
    const response = await fetch(`http://127.0.0.1:${login.callbackPort}/callback/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id_token: idToken, access_token: accessToken }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error(`Atlas 安全回调返回 HTTP ${response.status}。`);
    await waitForAtlasLoginExit(login);
    return await finalizePersonalLiclickAccountBinding(login, user);
  } catch (error) {
    login.error = error instanceof Error ? error.message : '莉刻账号关联失败。';
    if (!login.closed) terminateAtlasProcessTree(login.child);
    await removeManagedAtlasHomeDir(login.homeDir);
    throw error;
  }
}

export async function getPersonalLiclickAccount(user: AuthUser) {
  const sharedAccount = serverConfig.sharedLiclickTestAccount;
  const atlasHomeDir = sharedAccount.enabled ? sharedAccount.atlasHomeDir : user.atlasHomeDir;
  if (!atlasHomeDir) {
    return {
      bound: false as const,
      sharedTestAccount: sharedAccount.enabled,
      reason: sharedAccount.enabled
        ? '服务器共享测试莉刻账号未配置。'
        : '当前飞书用户尚未绑定个人莉刻账号。',
    };
  }
  try {
    const tokenCache = await readCompatibleAtlasTokenCache(atlasHomeDir);
    assertValidAtlasToken(tokenCache, atlasTokenFile(atlasHomeDir));
    const identity = await getAtlasIdentity(atlasHomeDir);
    const expectedEmail = sharedAccount.enabled ? sharedAccount.email : user.email;
    const matches = Boolean(
      expectedEmail &&
      identity.email &&
      expectedEmail.toLowerCase() === identity.email.toLowerCase(),
    );
    return {
      bound: matches,
      email: matches ? identity.email : undefined,
      expiresAt: matches ? tokenCache.expires_at : undefined,
      sharedTestAccount: sharedAccount.enabled,
      reason: matches
        ? undefined
        : sharedAccount.enabled
          ? '服务器共享测试莉刻账号未登录、已过期或配置账号不一致。'
          : '个人莉刻账号未登录、已过期或与飞书账号不一致。',
    };
  } catch {
    return {
      bound: false as const,
      sharedTestAccount: sharedAccount.enabled,
      reason: sharedAccount.enabled
        ? '服务器共享测试莉刻账号不可用，请联系管理员更新凭据。'
        : '个人莉刻账号不可用，请重新绑定。',
    };
  }
}

export async function unlinkPersonalLiclickAccount(user: AuthUser) {
  if (serverConfig.sharedLiclickTestAccount.enabled) {
    throw new Error('测试共享莉刻账号由服务器管理，不能从用户菜单解除。');
  }
  await setUserAtlasHomeDir(user.id, undefined);
  await removeManagedAtlasHomeDir(user.atlasHomeDir);
}

export function resolveLiclickAtlasUser(
  user: AuthUser,
  sharedAccount = serverConfig.sharedLiclickTestAccount,
): AuthUser {
  if (!sharedAccount.enabled) return user;
  return { ...user, atlasHomeDir: sharedAccount.atlasHomeDir };
}

export async function checkLiclickApiAccess(user?: AuthUser) {
  const atlasUser = user ? resolveLiclickAtlasUser(user) : undefined;
  if (!atlasUser?.atlasHomeDir) {
    return {
      ok: false,
      status: { valid: false, message: '当前飞书用户尚未绑定个人莉刻账号。' },
      tools: [] as string[],
      message: '当前飞书用户尚未绑定个人莉刻账号。',
    };
  }
  const status = await getAtlasStatus(atlasUser.atlasHomeDir);
  if (!status.valid) {
    return {
      ok: false,
      status,
      tools: [] as string[],
      message: '莉刻/Atlas 未登录。',
    };
  }
  const result = await runAtlas(
    ['gateway', 'list-tools', '--service', 'liclick'],
    60_000,
    false,
    atlasUser.atlasHomeDir,
  );
  const toolNames = [...result.stdout.matchAll(/^\s{2}([a-zA-Z0-9_]+)\(/gm)].map(
    (match) => match[1],
  );
  return {
    ok: toolNames.length > 0,
    status,
    tools: toolNames,
    message:
      toolNames.length > 0
        ? `莉刻 API 可用，发现 ${toolNames.length} 个工具。`
        : '莉刻 API 已响应，但没有解析到工具。',
  };
}
