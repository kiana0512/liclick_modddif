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
const publicWorkspaceUrl = process.env.LICLICK_PUBLIC_WORKSPACE_URL ?? `http://127.0.0.1:${port}`;
const feishuLocalCallbackPort = Number(process.env.FEISHU_OAUTH_PORT ?? process.env.OAUTH_PORT ?? 53682);
const defaultFeishuAppId = 'cli_aa92bbd326b85bd9';

export const serverConfig = {
  port,
  workspaceDir: path.resolve(process.env.LICLICK_WORKSPACE_DIR ?? path.join(repoRoot, 'workspace')),
  publicWorkspaceUrl,
  repoRoot,
  authMode: (process.env.AUTH_MODE ?? 'feishu-oauth') as 'dev-mock' | 'feishu-oauth',
  sessionCookieName: process.env.SESSION_COOKIE_NAME ?? 'liclick_3d_session',
  sessionSecret: process.env.SESSION_SECRET ?? 'dev-only-change-me',
  sessionMaxAgeDays: Number(process.env.SESSION_MAX_AGE_DAYS ?? 14),
  sessionCookieSecure: process.env.SESSION_COOKIE_SECURE === 'true',
  frontendUrl: process.env.LICLICK_FRONTEND_URL ?? 'http://localhost:5173',
  feishu: {
    appId: process.env.FEISHU_APP_ID ?? process.env.FEISHU_CLIENT_ID ?? defaultFeishuAppId,
    appSecret: process.env.FEISHU_APP_SECRET ?? process.env.FEISHU_CLIENT_SECRET,
    redirectUri: process.env.FEISHU_REDIRECT_URI ?? `http://localhost:${feishuLocalCallbackPort}/callback`,
    localCallbackPort: feishuLocalCallbackPort,
    authUrl: process.env.FEISHU_AUTH_URL ?? 'https://open.feishu.cn/open-apis/authen/v1/authorize',
    appAccessTokenUrl:
      process.env.FEISHU_APP_ACCESS_TOKEN_URL ?? 'https://open.feishu.cn/open-apis/auth/v3/app_access_token/internal',
    tokenUrl: process.env.FEISHU_TOKEN_URL ?? 'https://open.feishu.cn/open-apis/authen/v1/access_token',
    userinfoUrl: process.env.FEISHU_USERINFO_URL ?? 'https://open.feishu.cn/open-apis/authen/v1/user_info',
    scope: process.env.FEISHU_SCOPE,
  },
};
