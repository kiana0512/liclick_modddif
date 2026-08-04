export type LocalTextureRuntimeHealth = {
  ok: true;
  runtimeVersion: string;
  contentVersion?: string;
  workspaceDir?: string;
  capabilities: string[];
};

export type LocalTextureRuntimeState =
  | { status: 'checking' }
  | { status: 'ready'; health: LocalTextureRuntimeHealth }
  | { status: 'missing'; reason?: string }
  | { status: 'outdated'; health: LocalTextureRuntimeHealth; requiredVersion: string };

const desktopRuntimePort = '4618';
const developmentRuntimePort = '4517';

function isLoopbackHost(hostname: string) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';
}

export function getLocalTextureRuntimeApiBase() {
  const configured = import.meta.env.VITE_LI3D_LOCAL_RUNTIME_API?.trim();
  if (configured) return configured.replace(/\/$/, '');
  if (typeof window !== 'undefined' && isLoopbackHost(window.location.hostname)) {
    const port = window.location.port === '5173' ? developmentRuntimePort : desktopRuntimePort;
    return `http://${window.location.hostname === 'localhost' ? '127.0.0.1' : window.location.hostname}:${port}`;
  }
  return `http://127.0.0.1:${desktopRuntimePort}`;
}

function compareVersions(left: string, right: string) {
  const leftParts = left.split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0);
  const rightParts = right.split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

export function getLocalTextureRuntimeDownloadUrl() {
  const configured = import.meta.env.VITE_LI3D_LOCAL_RUNTIME_DOWNLOAD_URL?.trim();
  if (configured) return configured;
  const basePath = `/${(import.meta.env.BASE_URL ?? '/').split('/').filter(Boolean).join('/')}`;
  const normalizedBase = basePath === '/' ? '' : basePath;
  return `${normalizedBase}/downloads/LIclick-3D-Texture-Local-Component-Setup.exe?v=0.1.9`;
}

export async function downloadLocalTextureRuntimeInstaller() {
  const response = await fetch(getLocalTextureRuntimeDownloadUrl());
  if (!response.ok) throw new Error(`本地组件下载失败（${response.status}）。`);
  const objectUrl = URL.createObjectURL(await response.blob());
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = 'LIclick 3D Texture Local Component Setup.exe';
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 30_000);
}

export async function checkLocalTextureRuntime(): Promise<LocalTextureRuntimeState> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 1_600);
  try {
    const response = await fetch(`${getLocalTextureRuntimeApiBase()}/api/health`, {
      method: 'GET',
      cache: 'no-store',
      credentials: 'omit',
      signal: controller.signal,
    });
    if (!response.ok) {
      return { status: 'missing', reason: `本地组件响应异常（${response.status}）` };
    }
    const payload = (await response.json()) as {
      ok?: boolean;
      runtimeVersion?: string;
      workspaceVersion?: string;
      contentVersion?: string;
      workspaceDir?: string;
      capabilities?: unknown;
    };
    if (!payload.ok) return { status: 'missing', reason: '本地组件尚未就绪' };

    const health: LocalTextureRuntimeHealth = {
      ok: true,
      runtimeVersion: payload.runtimeVersion ?? payload.workspaceVersion ?? '0.0.0',
      contentVersion: payload.contentVersion,
      workspaceDir: payload.workspaceDir,
      capabilities: Array.isArray(payload.capabilities)
        ? payload.capabilities.filter((item): item is string => typeof item === 'string')
        : [],
    };
    if (!health.capabilities.includes('texture-painting')) {
      return { status: 'missing', reason: '检测到旧版程序，请安装新的贴图绘制本地组件' };
    }
    const requiredVersion = import.meta.env.VITE_LI3D_LOCAL_RUNTIME_MIN_VERSION?.trim() || '0.1.8';
    if (requiredVersion && compareVersions(health.runtimeVersion, requiredVersion) < 0) {
      return { status: 'outdated', health, requiredVersion };
    }
    return { status: 'ready', health };
  } catch (error) {
    const reason =
      error instanceof DOMException && error.name === 'AbortError'
        ? '未检测到本地组件'
        : '本地组件未安装或未启动';
    return { status: 'missing', reason };
  } finally {
    window.clearTimeout(timeout);
  }
}
