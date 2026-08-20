export type LocalRepaintSeamMode = 'enhanced' | 'legacy';

export const LOCAL_REPAINT_SEAM_MODE_STORAGE_KEY = 'liclick.localRepaintSeamMode';
export const LOCAL_REPAINT_SEAM_MODE_QUERY_KEY = 'localRepaintSeamMode';

function parseMode(value: string | null | undefined): LocalRepaintSeamMode | undefined {
  return value === 'enhanced' || value === 'legacy' ? value : undefined;
}

export function getLocalRepaintSeamMode(): LocalRepaintSeamMode {
  if (typeof window === 'undefined') return 'legacy';
  const queryMode = parseMode(
    new URLSearchParams(window.location.search).get(LOCAL_REPAINT_SEAM_MODE_QUERY_KEY),
  );
  if (queryMode) return queryMode;
  try {
    return parseMode(window.localStorage.getItem(LOCAL_REPAINT_SEAM_MODE_STORAGE_KEY)) ?? 'legacy';
  } catch {
    return 'legacy';
  }
}

export function setLocalRepaintSeamMode(mode: LocalRepaintSeamMode) {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(LOCAL_REPAINT_SEAM_MODE_STORAGE_KEY, mode);
  window.dispatchEvent(new CustomEvent('liclick:local-repaint-seam-mode-changed', { detail: mode }));
}
