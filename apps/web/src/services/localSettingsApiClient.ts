import type { ShortcutOverrides } from '@/stores/shortcutStore';
import { getWorkspaceApiBase } from './workspaceApiBase';

const workspaceApiBase = getWorkspaceApiBase(import.meta.env.VITE_LICLICK_WORKSPACE_API);

export type LocalProfile = {
  customId: string;
  avatarDataUrl?: string;
};

export type LocalSettingsResponse = {
  version: 1;
  activeUserId: string;
  performanceTestModeEnabled: boolean;
  performanceTestModeConfigured: boolean;
  profile: LocalProfile;
  shortcutOverrides: ShortcutOverrides;
  shortcutOverridesConfigured: boolean;
};

async function requestLocalSettings(path: string, init?: RequestInit) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 4_000);
  try {
    const response = await fetch(`${workspaceApiBase}${path}`, {
      ...init,
      signal: controller.signal,
      credentials: 'include',
      headers: {
        ...(init?.body ? { 'content-type': 'application/json' } : {}),
        ...init?.headers,
      },
    });
    if (!response.ok) throw new Error(`Local settings request failed: ${response.status}`);
    return response.json() as Promise<LocalSettingsResponse>;
  } finally {
    window.clearTimeout(timeout);
  }
}

export function getLocalSettings(userId: string) {
  return requestLocalSettings(`/api/local-settings?userId=${encodeURIComponent(userId)}`);
}

export function activateLocalSettings(
  userId: string,
  migration: {
    performanceTestModeEnabled: boolean;
    shortcutOverrides: ShortcutOverrides;
  },
) {
  return requestLocalSettings('/api/local-settings', {
    method: 'PUT',
    body: JSON.stringify({
      userId,
      activate: true,
      migrationPerformanceTestModeEnabled: migration.performanceTestModeEnabled,
      migrationShortcutOverrides: migration.shortcutOverrides,
    }),
  });
}
