import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(serverDir, '..', '..', '..');
const serverRoot = path.resolve(repoRoot, 'apps', 'server');

function parseEnvLine(line: string) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return undefined;
  const separatorIndex = trimmed.indexOf('=');
  if (separatorIndex <= 0) return undefined;
  const key = trimmed.slice(0, separatorIndex).trim();
  let value = trimmed.slice(separatorIndex + 1).trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  return { key, value };
}

function loadEnvFile(filePath: string) {
  if (!fs.existsSync(filePath)) return;
  const content = fs.readFileSync(filePath, 'utf8');
  for (const line of content.split(/\r?\n/)) {
    const parsed = parseEnvLine(line);
    if (!parsed || process.env[parsed.key] !== undefined) continue;
    process.env[parsed.key] = parsed.value;
  }
}

loadEnvFile(path.join(repoRoot, '.env'));
loadEnvFile(path.join(serverRoot, '.env'));

const port = Number(process.env.SERVER_PORT ?? process.env.LICLICK_WORKSPACE_PORT ?? 4517);
const host = process.env.SERVER_HOST ?? process.env.LICLICK_WORKSPACE_HOST ?? '127.0.0.1';
const publicWorkspaceUrl = process.env.LICLICK_PUBLIC_WORKSPACE_URL ?? `http://127.0.0.1:${port}`;
const frontendUrl = process.env.LICLICK_FRONTEND_URL ?? 'http://localhost:5173';

function getOrigin(value: string) {
  try {
    return new URL(value).origin;
  } catch {
    return value;
  }
}

function normalizePublicPath(value?: string) {
  const fromEnv = value?.trim();
  const fromUrl = (() => {
    try {
      return new URL(publicWorkspaceUrl).pathname;
    } catch {
      return '';
    }
  })();
  const rawPath = fromEnv ?? fromUrl;
  const normalized = `/${rawPath.split('/').filter(Boolean).join('/')}`;
  return normalized === '/' ? '' : normalized;
}

function parseCsv(value?: string) {
  return (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

export const serverConfig = {
  port,
  host,
  workspaceDir: path.resolve(process.env.LICLICK_WORKSPACE_DIR ?? path.join(repoRoot, 'workspace')),
  publicWorkspaceUrl,
  publicPath: normalizePublicPath(process.env.LICLICK_PUBLIC_PATH),
  repoRoot,
  authMode: (process.env.AUTH_MODE ?? 'feishu-oauth') as 'dev-mock' | 'feishu-oauth',
  sessionCookieName: process.env.SESSION_COOKIE_NAME ?? 'liclick_3d_session',
  sessionSecret: process.env.SESSION_SECRET ?? 'dev-only-change-me',
  sessionMaxAgeDays: Number(process.env.SESSION_MAX_AGE_DAYS ?? 14),
  sessionCookieSecure: process.env.SESSION_COOKIE_SECURE === 'true',
  frontendUrl,
  frontendOrigin: getOrigin(frontendUrl),
  allowedOrigins: [
    getOrigin(frontendUrl),
    getOrigin(publicWorkspaceUrl),
    'http://127.0.0.1:5173',
    'http://localhost:5173',
    ...parseCsv(process.env.LICLICK_ALLOWED_ORIGINS).map(getOrigin),
  ],
  allowedRemoteAssetHosts: parseCsv(process.env.LICLICK_ALLOWED_REMOTE_ASSET_HOSTS),
};
