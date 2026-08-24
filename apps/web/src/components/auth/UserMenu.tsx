import { useState } from 'react';
import { KeyRound, Languages, LogIn, LogOut, Unlink } from 'lucide-react';
import { devLogin, logout } from '@/services/authApiClient';
import { clearClientIdentity } from '@/services/clientIdentity';
import { runFeishuLoginFlow } from '@/services/feishuLoginFlow';
import { useAuthStore } from '@/stores/authStore';
import { useI18nStore, useT } from '@/stores/i18nStore';
import { useToastStore } from '@/stores/toastStore';

type UserMenuProps = { onLogout: () => void };

export function UserMenu({ onLogout }: UserMenuProps) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loginStatus, setLoginStatus] = useState('');
  const t = useT();
  const language = useI18nStore((state) => state.language);
  const setLanguage = useI18nStore((state) => state.setLanguage);
  const user = useAuthStore((state) => state.user);
  const localProfile = useAuthStore((state) => state.localProfile);
  const providerStatus = useAuthStore((state) => state.providerStatus);
  const setAuthenticated = useAuthStore((state) => state.setAuthenticated);
  const setAnonymous = useAuthStore((state) => state.setAnonymous);
  const refreshProviderStatus = useAuthStore((state) => state.refreshProviderStatus);
  const pushToast = useToastStore((state) => state.pushToast);

  async function handleLogin(forceReauthorize = false) {
    if (busy) return;
    setBusy(true);
    setLoginStatus('正在启动飞书授权...');
    try {
      const activeProviderStatus = providerStatus ?? (await refreshProviderStatus());
      if (activeProviderStatus.devLoginEnabled && !activeProviderStatus.feishuOAuthEnabled) {
        const result = await devLogin({ displayName: 'Liclick Dev User', email: 'dev@liclick.local' });
        setAuthenticated(result.user, 'dev-mock', activeProviderStatus);
        return;
      }
      const result = await runFeishuLoginFlow({
        forceReauthorize,
        onStatus: (message) => {
          setLoginStatus(message);
          pushToast({
            tone: 'info',
            title: '等待飞书授权',
            description: message,
            dedupeKey: 'auth-login-progress',
          });
        },
      });
      if (!result.user) throw new Error(t('loginMissingUser'));
      setAuthenticated(
        result.user,
        result.authMode ?? 'feishu-oauth',
        result.providerStatus ?? activeProviderStatus,
      );
      setLoginStatus('');
      pushToast({
        tone: 'success',
        title: t('feishuLoginSuccess'),
        description: '平台账号已验证，云端生产服务可使用当前会话。',
        dedupeKey: 'auth-login-success',
      });
    } catch (error) {
      setLoginStatus('');
      pushToast({
        tone: 'error',
        title: t('feishuLoginUnavailable'),
        description: error instanceof Error ? error.message : 'Could not start login.',
        dedupeKey: 'auth-login-failed',
      });
    } finally {
      setBusy(false);
    }
  }

  async function handleLogout() {
    await logout().catch(() => undefined);
    setAnonymous();
    onLogout();
  }

  async function handleSwitchAccount() {
    if (busy) return;
    setOpen(false);
    await handleLogin(true);
  }

  async function handleUnlinkAccount() {
    setOpen(false);
    clearClientIdentity();
    await handleLogout();
  }

  if (!user) {
    return (
      <button
        type="button"
        onClick={() => void handleLogin()}
        disabled={busy}
        className="inline-flex h-10 items-center gap-2 rounded-md border border-white/16 bg-black/18 px-3 text-sm font-medium text-white/84 transition hover:bg-white/10 hover:text-white disabled:cursor-wait disabled:opacity-80"
        title={t('useFeishuLogin')}
      >
        <LogIn className={busy ? 'h-4 w-4 animate-pulse' : 'h-4 w-4'} />
        {busy ? '等待授权' : t('feishuLogin')}
        {busy && loginStatus && <span className="sr-only">{loginStatus}</span>}
      </button>
    );
  }

  const visibleAvatarUrl = localProfile.avatarDataUrl ?? user.avatarUrl;
  return (
    <div className="relative">
      <button type="button" onClick={() => setOpen((current) => !current)} className="flex items-center gap-2 rounded-md px-2 py-1.5 transition hover:bg-white/10">
        {visibleAvatarUrl ? (
          <img src={visibleAvatarUrl} alt="" className="h-8 w-8 rounded-full object-cover" />
        ) : (
          <div className="grid h-8 w-8 place-items-center rounded-full bg-gradient-to-br from-liclick-pink to-liclick-purple text-sm font-semibold">
            {user.displayName.slice(0, 1).toUpperCase()}
          </div>
        )}
        <span className="hidden max-w-36 truncate text-sm font-medium text-white/86 sm:block">{user.displayName}</span>
      </button>
      {open && (
        <div className="absolute right-0 top-11 z-30 w-64 rounded-md border border-white/10 bg-[#1d1d1d] p-2 shadow-[0_18px_45px_rgba(0,0,0,0.48)]">
          <div className="flex gap-3 p-2">
            {visibleAvatarUrl ? (
              <img src={visibleAvatarUrl} alt="" className="h-11 w-11 rounded-full object-cover" />
            ) : (
              <div className="grid h-11 w-11 place-items-center rounded-full bg-gradient-to-br from-liclick-pink to-liclick-purple text-base font-semibold">
                {user.displayName.slice(0, 1).toUpperCase()}
              </div>
            )}
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold text-white">{user.displayName}</div>
              {localProfile.customId && <div className="truncate text-xs font-medium text-liclick-pink">@{localProfile.customId}</div>}
              <div className="truncate text-xs text-white/46">{user.email ?? user.authSource}</div>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setLanguage(language === 'zh' ? 'en' : 'zh')}
            className="mt-1 flex w-full items-center justify-between gap-3 rounded px-3 py-2 text-left text-sm text-white/76 transition hover:bg-white/10 hover:text-white"
            title={t('switchLanguage')}
          >
            <span className="inline-flex min-w-0 items-center gap-2"><Languages className="h-4 w-4 shrink-0" /><span className="truncate">{t('language')}</span></span>
            <span className="shrink-0 text-xs font-semibold text-liclick-pink">{language === 'zh' ? t('switchToEnglish') : t('switchToChinese')}</span>
          </button>
          <div className="my-1 h-px bg-white/28" />
          <div className="flex items-center justify-between gap-3 rounded px-3 py-2 text-left text-sm text-white/88">
            <span className="inline-flex min-w-0 items-start gap-2">
              <KeyRound className="mt-0.5 h-4 w-4 shrink-0" />
              <span className="min-w-0">
                <span className="block truncate font-medium">此电脑的莉刻账号</span>
                <span className="block truncate text-xs font-medium text-emerald-400">{user.email ?? user.displayName}</span>
              </span>
            </span>
            <button
              type="button"
              onClick={() => void handleSwitchAccount()}
              disabled={busy}
              className="shrink-0 text-xs font-semibold text-liclick-pink transition hover:text-white disabled:opacity-50"
            >
              更换
            </button>
          </div>
          <button
            type="button"
            onClick={() => void handleUnlinkAccount()}
            className="mt-1 flex w-full items-center gap-2 rounded px-3 py-2 text-left text-sm text-white/76 transition hover:bg-white/10 hover:text-white"
          >
            <Unlink className="h-4 w-4" />解除当前电脑的莉刻账号
          </button>
          <button type="button" onClick={() => void handleLogout()} className="mt-1 flex w-full items-center gap-2 rounded px-3 py-2 text-left text-sm text-white/76 transition hover:bg-white/10 hover:text-white">
            <LogOut className="h-4 w-4" />{t('logout')}
          </button>
        </div>
      )}
    </div>
  );
}
