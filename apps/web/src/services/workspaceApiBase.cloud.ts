function normalizeBasePath(pathname: string) {
  const normalized = `/${pathname.split('/').filter(Boolean).join('/')}`;
  return normalized === '/' ? '' : normalized;
}

/** Cloud control-plane URLs are configured explicitly or remain same-origin. */
export function getWorkspaceApiBase(configuredBase?: string) {
  const trimmedBase = configuredBase?.trim();
  if (trimmedBase) return trimmedBase.replace(/\/$/, '');
  if (typeof window === 'undefined') return '';
  const viteBase = normalizeBasePath(import.meta.env.BASE_URL ?? '/');
  return `${window.location.origin}${viteBase}`;
}
