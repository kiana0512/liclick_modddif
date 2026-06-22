import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createSession, upsertUser } from './sessionService.js';

type AtlasCommandResult = {
  code: number | null;
  stdout: string;
  stderr: string;
};

type AtlasStatus = {
  valid?: boolean;
  expires_at?: string;
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

function atlasTokenFile() {
  return path.join(os.homedir(), '.atlas-ai-gateway-oauth.json');
}

function trimOutput(text: string) {
  return text.trim().replace(/\s+/g, ' ').slice(0, 1000);
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

export function runAtlas(args: string[], timeoutMs: number, allowNonZero = false) {
  const script = atlasScriptPath();
  if (!script) {
    return Promise.reject(
      new Error('未找到 @lilith/atlas-skillhub，请先安装莉刻 Atlas 运行时。'),
    );
  }
  return new Promise<AtlasCommandResult>((resolve, reject) => {
    const child = spawn('node', [script, ...args], {
      cwd: process.cwd(),
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

function readAtlasTokenCache() {
  const file = atlasTokenFile();
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

export function getAtlasIdentity() {
  const tokenCache = readAtlasTokenCache();
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

export async function getAtlasStatus() {
  const result = await runAtlas(['gateway', 'status'], 30_000, true);
  const parsed = parseJsonFromOutput(result.stdout) as AtlasStatus;
  return {
    valid: Boolean(parsed.valid),
    expiresAt: typeof parsed.expires_at === 'string' ? parsed.expires_at : undefined,
    message: parsed.valid
      ? `莉刻/Atlas 已登录，有效期 ${typeof parsed.expires_at === 'string' ? parsed.expires_at : ''}`.trim()
      : trimOutput(result.stderr || result.stdout),
  };
}

export async function ensureAtlasLogin() {
  const current = await getAtlasStatus().catch(() => ({ valid: false }));
  if (current.valid) return current;
  await runAtlas(['gateway', 'login'], 10 * 60 * 1000, true);
  return getAtlasStatus();
}

export async function completeAtlasLogin(request: IncomingMessage, response: ServerResponse) {
  const status = await ensureAtlasLogin();
  if (!status.valid) throw new Error('莉刻/Atlas 登录未完成，请在浏览器里完成飞书/IDaaS 登录后重试。');
  const { email, displayName } = getAtlasIdentity();
  const user = await upsertUser({
    id: email ? `atlas-${email.toLowerCase()}` : undefined,
    displayName,
    email,
    avatarUrl: avatarDataUrl(displayName, email),
    authSource: 'feishu-oauth',
  });
  await createSession(user.id, 'feishu-oauth', request, response);
  return { user, status };
}

export async function checkLiclickApiAccess() {
  const status = await getAtlasStatus();
  if (!status.valid) {
    return {
      ok: false,
      status,
      tools: [] as string[],
      message: '莉刻/Atlas 未登录。',
    };
  }
  const result = await runAtlas(['gateway', 'list-tools', '--service', 'liclick'], 60_000, false);
  const toolNames = [...result.stdout.matchAll(/^\s{2}([a-zA-Z0-9_]+)\(/gm)].map((match) => match[1]);
  return {
    ok: toolNames.length > 0,
    status,
    tools: toolNames,
    message: toolNames.length > 0 ? `莉刻 API 可用，发现 ${toolNames.length} 个工具。` : '莉刻 API 已响应，但没有解析到工具。',
  };
}
