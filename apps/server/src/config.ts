import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  gpuControlLanCaExpectedSha256,
  gpuControlLanCaFilename,
} from './certs/gpuControlLanCa.js';

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
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
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
const workspaceDir = path.resolve(
  process.env.LICLICK_WORKSPACE_DIR ?? path.join(repoRoot, 'workspace'),
);
const publicWorkspaceUrl = process.env.LICLICK_PUBLIC_WORKSPACE_URL ?? `http://127.0.0.1:${port}`;
const frontendUrl = process.env.LICLICK_FRONTEND_URL ?? 'http://localhost:5173';
const serveWeb = process.env.LICLICK_SERVE_WEB === 'true';
const webDistDir = path.resolve(
  process.env.LICLICK_WEB_DIST_DIR ?? path.join(repoRoot, 'apps', 'web', 'dist'),
);
const comfyuiBaseUrl = (process.env.COMFYUI_BASE_URL ?? 'http://127.0.0.1:8188').replace(/\/$/, '');
const comfyuiTextureWorkflowPath =
  process.env.COMFYUI_TEXTURE_WORKFLOW_PATH ??
  'C:/Users/rentian/Downloads/li3d_zimage_web3d_fast_1024_to_4k_16gb.json';
const modelviewInpaintUrl =
  process.env.LICLICK_MODELVIEW_INPAINT_URL?.trim() ||
  'https://10.3.34.11/api/v1/services/modelview-inpaint';
const modelviewInpaintCaPath =
  process.env.LICLICK_MODELVIEW_INPAINT_CA_PATH?.trim() ||
  process.env.LICLICK_SUBSTANCE_BAKER_CA_PATH?.trim() ||
  '';
const modelviewInpaintApiKey =
  process.env.LICLICK_MODELVIEW_INPAINT_API_KEY?.trim() ?? '';
const modelviewInpaintTimeoutMs = Number(
  process.env.LICLICK_MODELVIEW_INPAINT_TIMEOUT_MS ?? 1_900_000,
);
const substanceBakerBaseUrl = (
  process.env.LICLICK_SUBSTANCE_BAKER_BASE_URL ?? 'https://10.3.34.11'
).replace(/\/$/, '');
const substanceBakerCaPath = process.env.LICLICK_SUBSTANCE_BAKER_CA_PATH?.trim() ?? '';
const substanceBakerApiKey = process.env.LICLICK_SUBSTANCE_BAKER_API_KEY?.trim() ?? '';
const substanceBakerTextureCacheMb = Number(
  process.env.LICLICK_SUBSTANCE_BAKER_TEXTURE_CACHE_MB ?? 32768,
);
const assetServiceBaseUrl = (
  process.env.ASSET_SERVICE_BASE_URL ?? 'https://10.3.34.11'
).replace(/\/$/, '');
const assetServiceApiToken =
  process.env.ASSET_SERVICE_API_TOKEN?.trim() ||
  // Compatibility with existing deployments while they migrate the secret
  // name. The value is always sent using the V6 Bearer scheme.
  process.env.ASSET_SERVICE_API_KEY?.trim() ||
  undefined;
const explicitAssetServiceCaCertPath = process.env.ASSET_SERVICE_CA_CERT_PATH?.trim();
const assetServiceCaCertManaged = !explicitAssetServiceCaCertPath;
const assetServiceCaCertPath = path.resolve(
  explicitAssetServiceCaCertPath ||
    path.join(workspaceDir, 'config', gpuControlLanCaFilename),
);
const assetServiceCaCertExpectedSha256 = gpuControlLanCaExpectedSha256;
const assetServiceTlsRejectUnauthorized =
  (process.env.ASSET_SERVICE_TLS_REJECT_UNAUTHORIZED ?? 'true').toLowerCase() !== 'false';

function positiveNumber(value: string | undefined, fallback: number, name: string) {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a finite positive number.`);
  }
  return parsed;
}

function booleanFlag(value: string | undefined, fallback: boolean, name: string) {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return fallback;
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  throw new Error(`${name} must be either true or false.`);
}

function serverHttpUrl(
  value: string,
  name: string,
  options: { allowNonLoopbackHttp?: boolean } = {},
) {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid absolute URL.`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`${name} must use http or https.`);
  }
  const isLoopback = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !isLoopback && !options.allowNonLoopbackHttp) {
    throw new Error(`${name} must use HTTPS unless it points to a loopback test server.`);
  }
  return value.replace(/\/$/, '');
}

function isNonLoopbackHttpUrl(value?: string) {
  if (!value) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === 'http:' &&
      !['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname)
    );
  } catch {
    return false;
  }
}

const assetServiceRequestTimeoutMs = positiveNumber(
  process.env.ASSET_SERVICE_REQUEST_TIMEOUT_MS,
  120_000,
  'ASSET_SERVICE_REQUEST_TIMEOUT_MS',
);
const assetServiceMaxUploadBytes = positiveNumber(
  process.env.ASSET_SERVICE_MAX_UPLOAD_BYTES,
  2 * 1024 * 1024 * 1024,
  'ASSET_SERVICE_MAX_UPLOAD_BYTES',
);
const assetServiceMaxArtifactBytes = positiveNumber(
  process.env.ASSET_SERVICE_MAX_ARTIFACT_BYTES,
  1024 * 1024 * 1024,
  'ASSET_SERVICE_MAX_ARTIFACT_BYTES',
);
const blenderExecutablePath =
  process.env.BLENDER_EXECUTABLE_PATH?.trim() ||
  process.env.LICLICK_BLENDER_PATH?.trim() ||
  undefined;
const retopologyPrepareTimeoutMs = positiveNumber(
  process.env.RETOPOLOGY_PREPARE_TIMEOUT_MS,
  10 * 60_000,
  'RETOPOLOGY_PREPARE_TIMEOUT_MS',
);
const retopologyPrepareMaxFileBytes = positiveNumber(
  process.env.RETOPOLOGY_PREPARE_MAX_FILE_BYTES,
  1024 * 1024 * 1024,
  'RETOPOLOGY_PREPARE_MAX_FILE_BYTES',
);
const retopologyPrepareMaxUploadBytes = positiveNumber(
  process.env.RETOPOLOGY_PREPARE_MAX_UPLOAD_BYTES,
  assetServiceMaxUploadBytes,
  'RETOPOLOGY_PREPARE_MAX_UPLOAD_BYTES',
);

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

function getAtlasLoginMode() {
  const value = process.env.ATLAS_LOGIN_MODE?.trim();
  if (value === 'interactive' || value === 'service-token') return value;
  return 'interactive';
}

function parseKeyValueList(value?: string) {
  return Object.fromEntries(
    parseCsv(value)
      .map((item) => {
        const separator = item.indexOf('=');
        if (separator <= 0) return undefined;
        return [item.slice(0, separator).trim(), item.slice(separator + 1).trim()] as const;
      })
      .filter((item): item is readonly [string, string] => Boolean(item?.[0])),
  );
}

function isLoopbackUrl(value?: string) {
  if (!value) return false;
  try {
    const url = new URL(value);
    return ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname);
  } catch {
    return false;
  }
}

const usesIdaasOAuthAliases = Boolean(
  !process.env.FEISHU_OAUTH_CLIENT_ID && process.env.IDAAS_OAUTH_CLIENT_ID,
);
const officialFeishuOAuth = {
  authorizeUrl: 'https://accounts.feishu.cn/open-apis/authen/v1/authorize',
  tokenUrl: 'https://open.feishu.cn/open-apis/authen/v2/oauth/token',
  userInfoUrl: 'https://open.feishu.cn/open-apis/authen/v1/user_info',
};
const configuredOAuthTokenRequestFormat =
  process.env.FEISHU_OAUTH_TOKEN_REQUEST_FORMAT ??
  process.env.IDAAS_OAUTH_TOKEN_REQUEST_FORMAT ??
  '';
const feishuWebOAuth = {
  clientId: process.env.FEISHU_OAUTH_CLIENT_ID ?? process.env.IDAAS_OAUTH_CLIENT_ID ?? '',
  clientSecret:
    process.env.FEISHU_OAUTH_CLIENT_SECRET ?? process.env.IDAAS_OAUTH_CLIENT_SECRET ?? '',
  authorizeUrl:
    process.env.FEISHU_OAUTH_AUTHORIZE_URL ??
    process.env.IDAAS_OAUTH_AUTHORIZE_URL ??
    (usesIdaasOAuthAliases ? '' : officialFeishuOAuth.authorizeUrl),
  tokenUrl:
    process.env.FEISHU_OAUTH_TOKEN_URL ??
    process.env.IDAAS_OAUTH_TOKEN_URL ??
    (usesIdaasOAuthAliases ? '' : officialFeishuOAuth.tokenUrl),
  userInfoUrl:
    process.env.FEISHU_OAUTH_USERINFO_URL ??
    process.env.IDAAS_OAUTH_USERINFO_URL ??
    (usesIdaasOAuthAliases ? '' : officialFeishuOAuth.userInfoUrl),
  redirectUrl: process.env.FEISHU_OAUTH_REDIRECT_URL ?? process.env.IDAAS_OAUTH_REDIRECT_URL ?? '',
  scope:
    process.env.FEISHU_OAUTH_SCOPE ??
    process.env.IDAAS_OAUTH_SCOPE ??
    (usesIdaasOAuthAliases ? 'openid profile email' : ''),
  tokenAuthMethod:
    process.env.FEISHU_OAUTH_TOKEN_AUTH_METHOD ??
    process.env.IDAAS_OAUTH_TOKEN_AUTH_METHOD ??
    'client_secret_post',
  tokenRequestFormat:
    configuredOAuthTokenRequestFormat === 'json' || configuredOAuthTokenRequestFormat === 'form'
      ? configuredOAuthTokenRequestFormat
      : usesIdaasOAuthAliases
        ? 'form'
        : 'json',
  extraAuthorizeParams: parseKeyValueList(
    process.env.FEISHU_OAUTH_EXTRA_AUTHORIZE_PARAMS ??
      process.env.IDAAS_OAUTH_EXTRA_AUTHORIZE_PARAMS,
  ),
};
const reservedOAuthAuthorizeParameters = new Set([
  'response_type',
  'client_id',
  'redirect_uri',
  'state',
  'code_challenge',
  'code_challenge_method',
  'scope',
]);
const overriddenOAuthParameters = Object.keys(feishuWebOAuth.extraAuthorizeParams).filter((key) =>
  reservedOAuthAuthorizeParameters.has(key.toLowerCase()),
);
if (overriddenOAuthParameters.length > 0) {
  throw new Error(
    `FEISHU_OAUTH_EXTRA_AUTHORIZE_PARAMS must not override protected OAuth parameters: ${overriddenOAuthParameters.join(', ')}.`,
  );
}

const idaasJwtSso = {
  enabled: process.env.IDAAS_JWT_SSO_ENABLED === 'true',
  url:
    process.env.IDAAS_JWT_SSO_URL ?? 'https://idaas.lilith.com/enduser/sp/sso/lilithplugin_jwt62',
  enterpriseId: process.env.IDAAS_ENTERPRISE_ID ?? 'lilith',
  serviceUrl: process.env.IDAAS_SP_SERVICE_URL ?? process.env.IDAAS_JWT_SERVICE_URL ?? '',
};
const idaasJwtSsoEffectiveServiceUrl =
  idaasJwtSso.serviceUrl ||
  feishuWebOAuth.redirectUrl ||
  `${publicWorkspaceUrl.replace(/\/$/, '')}/api/auth/feishu/callback`;

const feishuWebOAuthMissingConfigKeys = [
  ['FEISHU_OAUTH_CLIENT_ID or IDAAS_OAUTH_CLIENT_ID', feishuWebOAuth.clientId],
  ['FEISHU_OAUTH_CLIENT_SECRET or IDAAS_OAUTH_CLIENT_SECRET', feishuWebOAuth.clientSecret],
  ['FEISHU_OAUTH_AUTHORIZE_URL or IDAAS_OAUTH_AUTHORIZE_URL', feishuWebOAuth.authorizeUrl],
  ['FEISHU_OAUTH_TOKEN_URL or IDAAS_OAUTH_TOKEN_URL', feishuWebOAuth.tokenUrl],
].flatMap(([key, value]) => (value ? [] : [key]));

const feishuWebOAuthConfigured = Boolean(
  feishuWebOAuth.clientId &&
    feishuWebOAuth.clientSecret &&
    feishuWebOAuth.authorizeUrl &&
    feishuWebOAuth.tokenUrl,
);
const feishuWebOAuthRedirectUrl =
  feishuWebOAuth.redirectUrl ||
  `${publicWorkspaceUrl.replace(/\/$/, '')}/api/auth/feishu/callback`;
const feishuWebOAuthAllowInsecureHttpCallback = booleanFlag(
  process.env.FEISHU_OAUTH_ALLOW_INSECURE_HTTP_CALLBACK,
  false,
  'FEISHU_OAUTH_ALLOW_INSECURE_HTTP_CALLBACK',
);
const feishuWebOAuthInsecureHttpCallbackActive = Boolean(
  feishuWebOAuthConfigured &&
    feishuWebOAuthAllowInsecureHttpCallback &&
    isNonLoopbackHttpUrl(feishuWebOAuthRedirectUrl),
);
if (feishuWebOAuthConfigured) {
  serverHttpUrl(feishuWebOAuth.authorizeUrl, 'FEISHU_OAUTH_AUTHORIZE_URL');
  serverHttpUrl(feishuWebOAuth.tokenUrl, 'FEISHU_OAUTH_TOKEN_URL');
  if (feishuWebOAuth.userInfoUrl) {
    serverHttpUrl(feishuWebOAuth.userInfoUrl, 'FEISHU_OAUTH_USERINFO_URL');
  }
  serverHttpUrl(
    feishuWebOAuthRedirectUrl,
    'FEISHU_OAUTH_REDIRECT_URL',
    { allowNonLoopbackHttp: feishuWebOAuthAllowInsecureHttpCallback },
  );
}
const feishuWebOAuthLoopbackProvider = [
  feishuWebOAuth.authorizeUrl,
  feishuWebOAuth.tokenUrl,
  feishuWebOAuth.userInfoUrl,
].some(isLoopbackUrl);
const feishuWebOAuthAllowLoopbackProvider =
  process.env.FEISHU_OAUTH_ALLOW_LOOPBACK_PROVIDER === 'true';
const feishuWebOAuthBlockedReason =
  feishuWebOAuthConfigured && feishuWebOAuthLoopbackProvider && !feishuWebOAuthAllowLoopbackProvider
    ? 'OAuth provider points to a loopback/mock URL. Set FEISHU_OAUTH_ALLOW_LOOPBACK_PROVIDER=true only for automated smoke tests, or configure the real IDaaS/Feishu authorize/token URLs.'
    : '';
const feishuWebOAuthEnabled = Boolean(feishuWebOAuthConfigured && !feishuWebOAuthBlockedReason);
const feishuDirectoryEnrichmentEnabled = booleanFlag(
  process.env.FEISHU_DIRECTORY_ENRICHMENT_ENABLED,
  false,
  'FEISHU_DIRECTORY_ENRICHMENT_ENABLED',
);
const feishuBitableSyncEnabled = booleanFlag(
  process.env.FEISHU_BITABLE_SYNC_ENABLED,
  false,
  'FEISHU_BITABLE_SYNC_ENABLED',
);
const feishuPlatformAppId = process.env.FEISHU_OAUTH_CLIENT_ID?.trim() ?? '';
const feishuPlatformAppSecret = process.env.FEISHU_OAUTH_CLIENT_SECRET?.trim() ?? '';
const feishuTenantTokenUrl =
  process.env.FEISHU_TENANT_TOKEN_URL?.trim() ||
  'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal';
const feishuContactBaseUrl =
  process.env.FEISHU_CONTACT_BASE_URL?.trim() ||
  'https://open.feishu.cn/open-apis/contact/v3';
const feishuBitableBaseUrl =
  process.env.FEISHU_BITABLE_BASE_URL?.trim() ||
  'https://open.feishu.cn/open-apis/bitable/v1';
const feishuBitableAppToken = process.env.FEISHU_BITABLE_APP_TOKEN?.trim() ?? '';
const feishuBitableTableId = process.env.FEISHU_BITABLE_TABLE_ID?.trim() ?? '';
const feishuBitableSyncIntervalMs = positiveNumber(
  process.env.FEISHU_BITABLE_SYNC_INTERVAL_MS,
  30_000,
  'FEISHU_BITABLE_SYNC_INTERVAL_MS',
);

if (feishuDirectoryEnrichmentEnabled || feishuBitableSyncEnabled) {
  const missingPlatformKeys = [
    ['FEISHU_OAUTH_CLIENT_ID', feishuPlatformAppId],
    ['FEISHU_OAUTH_CLIENT_SECRET', feishuPlatformAppSecret],
  ].flatMap(([name, value]) => (value ? [] : [name]));
  if (missingPlatformKeys.length > 0) {
    throw new Error(
      `Feishu server-side integration is enabled but required configuration is missing: ${missingPlatformKeys.join(', ')}.`,
    );
  }
  serverHttpUrl(feishuTenantTokenUrl, 'FEISHU_TENANT_TOKEN_URL');
}

if (feishuDirectoryEnrichmentEnabled) {
  serverHttpUrl(feishuContactBaseUrl, 'FEISHU_CONTACT_BASE_URL');
}

if (feishuBitableSyncEnabled) {
  const missingBitableKeys = [
    ['FEISHU_BITABLE_APP_TOKEN', feishuBitableAppToken],
    ['FEISHU_BITABLE_TABLE_ID', feishuBitableTableId],
  ].flatMap(([name, value]) => (value ? [] : [name]));
  if (missingBitableKeys.length > 0) {
    throw new Error(
      `Feishu Bitable sync is enabled but required configuration is missing: ${missingBitableKeys.join(', ')}.`,
    );
  }
  if (!/^[A-Za-z0-9_-]+$/.test(feishuBitableAppToken)) {
    throw new Error('FEISHU_BITABLE_APP_TOKEN has an invalid format.');
  }
  if (!/^tbl[A-Za-z0-9_-]+$/.test(feishuBitableTableId)) {
    throw new Error('FEISHU_BITABLE_TABLE_ID must be a table ID beginning with tbl.');
  }
  serverHttpUrl(feishuBitableBaseUrl, 'FEISHU_BITABLE_BASE_URL');
}
const idaasJwtSsoBlockedReason =
  idaasJwtSso.enabled &&
  idaasJwtSso.url &&
  isLoopbackUrl(idaasJwtSsoEffectiveServiceUrl) &&
  !idaasJwtSso.serviceUrl
    ? `IDaaS SP Service URL points to ${idaasJwtSsoEffectiveServiceUrl}. Configure IDAAS_SP_SERVICE_URL with an IDaaS-registered Liclick callback URL; loopback URLs are rejected unless explicitly registered in IDaaS.`
    : '';
const idaasJwtSsoEnabled = Boolean(
  idaasJwtSso.enabled && idaasJwtSso.url && !idaasJwtSsoBlockedReason,
);
const atlasLocalLoginEnabled = process.env.LICLICK_ENABLE_ATLAS_LOCAL_LOGIN !== 'false';
const sessionSecret = process.env.SESSION_SECRET ?? 'dev-only-change-me';
const loopbackHosts = new Set(['127.0.0.1', 'localhost', '::1']);

if (!loopbackHosts.has(host) && sessionSecret === 'dev-only-change-me') {
  throw new Error(
    'SESSION_SECRET must be set to a strong unique value before the server listens on a non-loopback host.',
  );
}

export const serverConfig = {
  port,
  host,
  workspaceDir,
  localSettingsPath: path.resolve(
    process.env.LICLICK_LOCAL_SETTINGS_PATH ??
      path.join(
        process.env.LICLICK_WORKSPACE_DIR ?? path.join(repoRoot, 'workspace'),
        'config',
        'local-settings.json',
      ),
  ),
  publicWorkspaceUrl,
  publicPath: normalizePublicPath(process.env.LICLICK_PUBLIC_PATH),
  repoRoot,
  authMode: (process.env.AUTH_MODE ?? 'feishu-oauth') as 'dev-mock' | 'feishu-oauth',
  atlasLoginMode: getAtlasLoginMode(),
  feishuWebOAuthConfigured,
  feishuWebOAuthEnabled,
  feishuWebOAuthBlockedReason,
  feishuWebOAuthMissingConfigKeys,
  feishuWebOAuthAllowInsecureHttpCallback,
  feishuWebOAuthInsecureHttpCallbackActive,
  feishuWebOAuth,
  feishuPlatform: {
    appId: feishuPlatformAppId,
    appSecret: feishuPlatformAppSecret,
    tenantTokenUrl: feishuTenantTokenUrl,
    directory: {
      enabled: feishuDirectoryEnrichmentEnabled,
      contactBaseUrl: feishuContactBaseUrl,
    },
    bitable: {
      enabled: feishuBitableSyncEnabled,
      baseUrl: feishuBitableBaseUrl,
      appToken: feishuBitableAppToken,
      tableId: feishuBitableTableId,
      syncIntervalMs: feishuBitableSyncIntervalMs,
    },
  },
  idaasJwtSso,
  idaasJwtSsoBlockedReason,
  idaasJwtSsoEnabled,
  atlasLocalLoginEnabled,
  sessionCookieName: process.env.SESSION_COOKIE_NAME ?? 'liclick_3d_session',
  sessionSecret,
  sessionMaxAgeDays: Number(process.env.SESSION_MAX_AGE_DAYS ?? 14),
  sessionCookieSecure: process.env.SESSION_COOKIE_SECURE === 'true',
  frontendUrl,
  serveWeb,
  webDistDir,
  comfyuiBaseUrl,
  comfyuiTextureWorkflowPath,
  modelviewInpaintUrl,
  modelviewInpaintCaPath,
  modelviewInpaintApiKey,
  modelviewInpaintTimeoutMs,
  substanceBakerBaseUrl,
  substanceBakerCaPath,
  substanceBakerApiKey,
  substanceBakerTextureCacheMb,
  assetServiceBaseUrl,
  assetServiceApiToken,
  assetServiceCaCertPath,
  assetServiceCaCertManaged,
  assetServiceCaCertExpectedSha256,
  assetServiceTlsRejectUnauthorized,
  assetServiceRequestTimeoutMs,
  assetServiceMaxUploadBytes,
  assetServiceMaxArtifactBytes,
  blenderExecutablePath,
  retopologyPrepareTimeoutMs,
  retopologyPrepareMaxFileBytes,
  retopologyPrepareMaxUploadBytes,
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
