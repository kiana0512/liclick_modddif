import { useState } from 'react';
import { Check, Languages, Layers, LogIn, LogOut } from 'lucide-react';
import { devLogin, logout } from '@/services/authApiClient';
import { runFeishuLoginFlow } from '@/services/feishuLoginFlow';
import { useAuthStore } from '@/stores/authStore';
import { useI18nStore, useT } from '@/stores/i18nStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useToastStore } from '@/stores/toastStore';

export function UserMenu({ onLogout }: { onLogout: () => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loginStatus, setLoginStatus] = useState('');
  const t = useT();
  const language = useI18nStore((state) => state.language);
  const setLanguage = useI18nStore((state) => state.setLanguage);
  const autoUvBakeEnabled = useSettingsStore((state) => state.autoUvBakeEnabled);
  const setAutoUvBakeEnabled = useSettingsStore((state) => state.setAutoUvBakeEnabled);
  const user = useAuthStore((state) => state.user);
  const providerStatus = useAuthStore((state) => state.providerStatus);
  const setAuthenticated = useAuthStore((state) => state.setAuthenticated);
  const setAnonymous = useAuthStore((state) => state.setAnonymous);
  const pushToast = useToastStore((state) => state.pushToast);

  async function handleLogin() {
    if (busy) return;
    setBusy(true);
    setLoginStatus('正在启动飞书授权...');
    try {
      if (providerStatus?.devLoginEnabled && !providerStatus.feishuOAuthEnabled) {
        const result = await devLogin({ displayName: 'Liclick Dev User', email: 'dev@liclick.local' });
        setAuthenticated(result.user, 'dev-mock', providerStatus);
        return;
      }
      const result = await runFeishuLoginFlow({
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
      if (result.user) {
        setAuthenticated(result.user, result.authMode ?? 'feishu-oauth', providerStatus);
        setLoginStatus('');
        pushToast({
          tone: 'success',
          title: t('feishuLoginSuccess'),
          description: result.message ?? t('atlasLoginReady'),
          dedupeKey: 'auth-login-success',
        });
        return;
      }
      throw new Error(t('loginMissingUser'));
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

  if (!user) {
    return (
      <div className="relative">
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
      </div>
    );
  }

  return (
    <div className="relative">
      <button type="button" onClick={() => setOpen((current) => !current)} className="flex items-center gap-2 rounded-md px-2 py-1.5 transition hover:bg-white/10">
        {user.avatarUrl ? (
          <img src={user.avatarUrl} alt="" className="h-8 w-8 rounded-full object-cover" />
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
            {user.avatarUrl ? (
              <img src={user.avatarUrl} alt="" className="h-11 w-11 rounded-full object-cover" />
            ) : (
              <div className="grid h-11 w-11 place-items-center rounded-full bg-gradient-to-br from-liclick-pink to-liclick-purple text-base font-semibold">
                {user.displayName.slice(0, 1).toUpperCase()}
              </div>
            )}
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold text-white">{user.displayName}</div>
              <div className="truncate text-xs text-white/46">{user.email ?? user.authSource}</div>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setLanguage(language === 'zh' ? 'en' : 'zh')}
            className="mt-1 flex w-full items-center justify-between gap-3 rounded px-3 py-2 text-left text-sm text-white/76 transition hover:bg-white/10 hover:text-white"
            title={t('switchLanguage')}
          >
            <span className="inline-flex min-w-0 items-center gap-2">
              <Languages className="h-4 w-4 shrink-0" />
              <span className="truncate">{t('language')}</span>
            </span>
            <span className="shrink-0 text-xs font-semibold text-liclick-pink">
              {language === 'zh' ? t('switchToEnglish') : t('switchToChinese')}
            </span>
          </button>
          <button
            type="button"
            onClick={() => setAutoUvBakeEnabled(!autoUvBakeEnabled)}
            className="mt-1 flex w-full items-center justify-between gap-3 rounded px-3 py-2 text-left text-sm text-white/76 transition hover:bg-white/10 hover:text-white"
            title={t('autoUvBakeHelp')}
          >
            <span className="inline-flex min-w-0 items-center gap-2">
              <Layers className="h-4 w-4 shrink-0" />
              <span className="truncate">{t('autoUvBake')}</span>
            </span>
            <span
              className={`grid h-5 w-5 shrink-0 place-items-center rounded border ${
                autoUvBakeEnabled ? 'border-liclick-pink bg-liclick-pink text-white' : 'border-white/24 text-transparent'
              }`}
            >
              <Check className="h-3.5 w-3.5" />
            </span>
          </button>
          <button type="button" onClick={() => void handleLogout()} className="mt-1 flex w-full items-center gap-2 rounded px-3 py-2 text-left text-sm text-white/76 transition hover:bg-white/10 hover:text-white">
            <LogOut className="h-4 w-4" />
            {t('logout')}
          </button>
        </div>
      )}
    </div>
  );
}
