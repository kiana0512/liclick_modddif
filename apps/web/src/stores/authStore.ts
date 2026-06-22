import { create } from 'zustand';
import type { AuthMode, AuthUser, ProviderStatus } from '@/services/authApiClient';

type AuthStore = {
  status: 'checking' | 'authenticated' | 'anonymous';
  authMode: AuthMode;
  user?: AuthUser;
  providerStatus?: ProviderStatus;
  setChecking: () => void;
  setAnonymous: (authMode?: AuthMode, providerStatus?: ProviderStatus) => void;
  setAuthenticated: (user: AuthUser, authMode: AuthMode, providerStatus?: ProviderStatus) => void;
};

export const useAuthStore = create<AuthStore>((set) => ({
  status: 'checking',
  authMode: 'dev-mock',
  setChecking: () => set({ status: 'checking' }),
  setAnonymous: (authMode = 'dev-mock', providerStatus) =>
    set({ status: 'anonymous', authMode, providerStatus, user: undefined }),
  setAuthenticated: (user, authMode, providerStatus) =>
    set({ status: 'authenticated', authMode, providerStatus, user }),
}));
