import { create } from 'zustand';
import {
  getProviderStatus,
  type AuthMode,
  type AuthUser,
  type ProviderStatus,
} from '@/services/authApiClient';
import {
  activateLocalSettings,
  getLocalSettings,
  type LocalProfile,
  type LocalSettingsResponse,
} from '@/services/localSettingsApiClient';
import { useSettingsStore } from '@/stores/settingsStore';
import { useShortcutStore } from '@/stores/shortcutStore';

type AuthStore = {
  status: 'checking' | 'authenticated' | 'anonymous';
  authMode: AuthMode;
  user?: AuthUser;
  providerStatus?: ProviderStatus;
  localProfile: LocalProfile;
  setChecking: () => void;
  setAnonymous: (authMode?: AuthMode, providerStatus?: ProviderStatus) => void;
  setAuthenticated: (user: AuthUser, authMode: AuthMode, providerStatus?: ProviderStatus) => void;
  setProviderStatus: (providerStatus: ProviderStatus) => void;
  refreshProviderStatus: () => Promise<ProviderStatus>;
  refreshLocalSettings: () => Promise<void>;
};

function applyLocalSettings(
  response: LocalSettingsResponse,
  set: (next: Partial<AuthStore>) => void,
) {
  useShortcutStore.getState().replaceOverrides(response.shortcutOverrides);
  useSettingsStore
    .getState()
    .setPerformanceTestModeEnabled(response.performanceTestModeEnabled);
  set({ localProfile: response.profile });
}

function activateAndApplyLocalSettings(
  userId: string,
  set: (next: Partial<AuthStore>) => void,
) {
  return activateLocalSettings(userId, {
    performanceTestModeEnabled: useSettingsStore.getState().performanceTestModeEnabled,
    shortcutOverrides: useShortcutStore.getState().overrides,
  }).then((response) => applyLocalSettings(response, set));
}

export const useAuthStore = create<AuthStore>((set, get) => ({
  status: 'checking',
  authMode: 'dev-mock',
  localProfile: { customId: '' },
  setChecking: () => set({ status: 'checking' }),
  setAnonymous: (authMode, providerStatus) => {
    const current = get();
    useShortcutStore.getState().setActiveUser('anonymous');
    set({
      status: 'anonymous',
      authMode: authMode ?? current.authMode,
      providerStatus: providerStatus ?? current.providerStatus,
      user: undefined,
      localProfile: { customId: '' },
    });
    void activateAndApplyLocalSettings('anonymous', set).catch(() => undefined);
  },
  setAuthenticated: (user, authMode, providerStatus) => {
    const current = get();
    useShortcutStore.getState().setActiveUser(user.id);
    set({
      status: 'authenticated',
      authMode,
      providerStatus: providerStatus ?? current.providerStatus,
      user,
      localProfile: { customId: '' },
    });
    void activateAndApplyLocalSettings(user.id, set).catch(() => undefined);
  },
  setProviderStatus: (providerStatus) => set({ providerStatus, authMode: providerStatus.authMode }),
  refreshProviderStatus: async () => {
    const providerStatus = await getProviderStatus();
    set({ providerStatus, authMode: providerStatus.authMode });
    return providerStatus;
  },
  refreshLocalSettings: async () => {
    const userId = get().user?.id ?? 'anonymous';
    const response = await getLocalSettings(userId);
    applyLocalSettings(response, set);
  },
}));
