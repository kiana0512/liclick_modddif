const defaultWorkspacePort = '4517';

function isLoopbackHost(hostname: string) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';
}

function normalizeBasePath(pathname: string) {
  const normalized = `/${pathname.split('/').filter(Boolean).join('/')}`;
  return normalized === '/' ? '' : normalized;
}

function getCurrentPageApiBase() {
  if (typeof window === 'undefined') return `http://127.0.0.1:${defaultWorkspacePort}`;
  const viteBase = normalizeBasePath(import.meta.env.BASE_URL ?? '/');
  const pagePort = window.location.port;
  if (isLoopbackHost(window.location.hostname) && pagePort && pagePort !== defaultWorkspacePort) {
    return `${window.location.protocol}//${window.location.hostname}:${defaultWorkspacePort}`;
  }
  return `${window.location.origin}${viteBase}`;
}

export function getWorkspaceApiBase(configuredBase?: string) {
  const fallbackBase = getCurrentPageApiBase();
  const trimmedBase = configuredBase?.trim();
  if (!trimmedBase) return fallbackBase;

  if (typeof window === 'undefined') return trimmedBase;

  try {
    const configuredUrl = new URL(trimmedBase);
    const pageHost = window.location.hostname;
    if (isLoopbackHost(configuredUrl.hostname) && !isLoopbackHost(pageHost)) {
      return fallbackBase;
    }
    if (isLoopbackHost(configuredUrl.hostname) && isLoopbackHost(pageHost) && configuredUrl.hostname !== pageHost) {
      configuredUrl.hostname = pageHost;
      return configuredUrl.href.replace(/\/$/, '');
    }
    return configuredUrl.href.replace(/\/$/, '');
  } catch {
    return trimmedBase.replace(/\/$/, '');
  }
}
