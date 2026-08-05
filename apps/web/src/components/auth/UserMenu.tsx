import { useEffect, useState } from 'react';
import { KeyRound, Languages, LogIn, LogOut, RefreshCw, Unlink } from 'lucide-react';
import { devLogin, logout } from '@/services/authApiClient';
import { runFeishuLoginFlow } from '@/services/feishuLoginFlow';
import {
  usesLocalAtlasLogin,
  usesPersonalLiclickAccount,
} from '@/services/liclickAuthStrategy';
import { runPersonalLiclickAccountBindingFlow } from '@/services/liclickAccountBindingFlow';
import {
  getPersonalLiclickAccountStatus,
  isPersonalLiclickAccountForEmail,
  unbindPersonalLiclickAccount,
  type PersonalLiclickAccountStatus,
} from '@/services/liclickAccountApiClient';
import { useAuthStore } from '@/stores/authStore';
import { useI18nStore, useT } from '@/stores/i18nStore';
import { useToastStore } from '@/stores/toastStore';

type UserMenuProps = {
  onLogout: () => void;
};

export function UserMenu({ onLogout }: UserMenuProps) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loginStatus, setLoginStatus] = useState('');
  const [liclickBusy, setLiclickBusy] = useState(false);
  const [liclickStatusLoading, setLiclickStatusLoading] = useState(false);
  const [liclickStatus, setLiclickStatus] = useState<PersonalLiclickAccountStatus>();
  const [liclickStatusError, setLiclickStatusError] = useState('');
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
  const hasPersonalLiclickAccount = usesPersonalLiclickAccount(providerStatus);

  useEffect(() => {
    if (!open || providerStatus) return;
    void refreshProviderStatus().catch(() => undefined);
  }, [open, providerStatus, refreshProviderStatus]);

  useEffect(() => {
    if (!open || !user || !hasPersonalLiclickAccount) return undefined;
    let cancelled = false;
    setLiclickStatusLoading(true);
    setLiclickStatusError('');
    void getPersonalLiclickAccountStatus()
      .then((status) => {
        if (!cancelled) setLiclickStatus(status);
      })
      .catch((error) => {
        if (cancelled) return;
        setLiclickStatus(undefined);
        setLiclickStatusError(
          error instanceof Error ? error.message : '无法读取此电脑的莉刻账号状态。',
        );
      })
      .finally(() => {
        if (!cancelled) setLiclickStatusLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, user, hasPersonalLiclickAccount]);

  async function handleLogin() {
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
        const loginProviderStatus = result.providerStatus ?? activeProviderStatus;
        setAuthenticated(result.user, result.authMode ?? 'feishu-oauth', loginProviderStatus);
        setLoginStatus('');
        pushToast({
          tone: 'success',
          title: t('feishuLoginSuccess'),
          description: usesLocalAtlasLogin(loginProviderStatus)
            ? result.message ?? t('atlasLoginReady')
            : '飞书员工身份已验证。莉刻生图账号需要在当前电脑单独绑定。',
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

  async function handlePersonalLiclickBinding() {
    if (!user || liclickBusy) return;
    const expectedEmail = user.email?.trim();
    if (!expectedEmail && user.authSource !== 'dev-mock') {
      pushToast({
        tone: 'error',
        title: '无法绑定个人莉刻账号',
        description:
          '飞书登录没有返回企业邮箱，无法校验账号归属。请让管理员开通用户邮箱读取权限后重新登录。',
        dedupeKey: 'user-menu-liclick-email-missing',
      });
      return;
    }
    setLiclickBusy(true);
    setLiclickStatusError('');
    try {
      const account = await runPersonalLiclickAccountBindingFlow({
        expectedEmail: user.authSource === 'dev-mock' ? undefined : expectedEmail,
        onStatus: (message) => setLoginStatus(message),
      });
      setLiclickStatus(account);
      setLoginStatus('');
      pushToast({
        tone: 'success',
        title: '个人莉刻账号绑定成功',
        description: account.email
          ? `此电脑将使用 ${account.email} 提交莉刻生图任务。`
          : '此电脑已绑定你的个人莉刻账号。',
        dedupeKey: 'user-menu-liclick-bound',
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : '个人莉刻账号绑定失败。';
      setLoginStatus('');
      setLiclickStatusError(message);
      pushToast({
        tone: 'error',
        title: '个人莉刻账号绑定失败',
        description: message,
        dedupeKey: 'user-menu-liclick-bind-failed',
      });
    } finally {
      setLiclickBusy(false);
    }
  }

  async function handlePersonalLiclickUnbind() {
    if (liclickBusy || !liclickStatus?.bound) return;
    if (!window.confirm('确定解除当前电脑上的个人莉刻账号吗？不会影响飞书登录。')) return;
    setLiclickBusy(true);
    setLiclickStatusError('');
    try {
      await unbindPersonalLiclickAccount();
      setLiclickStatus({ bound: false, valid: false, message: '尚未绑定' });
      pushToast({
        tone: 'success',
        title: '已解除个人莉刻账号',
        description: '此电脑不再保存该莉刻账号凭证，飞书登录保持不变。',
        dedupeKey: 'user-menu-liclick-unbound',
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : '解除个人莉刻账号失败。';
      setLiclickStatusError(message);
      pushToast({
        tone: 'error',
        title: '解除失败',
        description: message,
        dedupeKey: 'user-menu-liclick-unbind-failed',
      });
    } finally {
      setLiclickBusy(false);
    }
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

  const visibleAvatarUrl = localProfile.avatarDataUrl ?? user.avatarUrl;
  const liclickMatchesUser = isPersonalLiclickAccountForEmail(
    liclickStatus,
    user.authSource === 'dev-mock' ? undefined : user.email,
  );

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
              {localProfile.customId && (
                <div className="truncate text-xs font-medium text-liclick-pink">@{localProfile.customId}</div>
              )}
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
          {hasPersonalLiclickAccount && (
          <div className="mt-1 border-t border-white/8 pt-1">
            <button
              type="button"
              onClick={() => void handlePersonalLiclickBinding()}
              disabled={liclickBusy || liclickStatusLoading}
              className="flex w-full items-center gap-2 rounded px-3 py-2 text-left text-sm text-white/76 transition hover:bg-white/10 hover:text-white disabled:cursor-wait disabled:opacity-65"
              title={liclickStatusError || '绑定或更换当前电脑使用的个人莉刻账号'}
            >
              {liclickBusy || liclickStatusLoading ? (
                <RefreshCw className="h-4 w-4 shrink-0 animate-spin" />
              ) : (
                <KeyRound className="h-4 w-4 shrink-0" />
              )}
              <span className="min-w-0 flex-1">
                <span className="block truncate">此电脑的莉刻账号</span>
                <span
                  className={`block truncate text-xs ${
                    liclickStatusError
                      ? 'text-red-300'
                      : liclickMatchesUser
                        ? 'text-emerald-300'
                        : liclickStatus?.valid
                          ? 'text-amber-300'
                        : 'text-white/42'
                  }`}
                >
                  {liclickBusy && loginStatus
                    ? loginStatus
                    : liclickStatusLoading
                    ? '正在检查…'
                    : liclickStatusError
                      ? '组件不可用或需升级'
                      : liclickMatchesUser
                        ? liclickStatus?.email || liclickStatus?.displayName || '已绑定'
                        : liclickStatus?.valid
                          ? `与当前飞书账号不一致：${liclickStatus.email ?? '其他账号'}`
                        : liclickStatus?.bound
                          ? '授权已失效，请重新绑定'
                          : '尚未绑定'}
                </span>
              </span>
              <span className="shrink-0 text-xs font-semibold text-liclick-pink">
                {liclickStatus?.valid ? '更换' : '绑定'}
              </span>
            </button>
            {liclickStatus?.bound && (
              <button
                type="button"
                onClick={() => void handlePersonalLiclickUnbind()}
                disabled={liclickBusy}
                className="flex w-full items-center gap-2 rounded px-3 py-2 text-left text-xs text-white/48 transition hover:bg-white/10 hover:text-white disabled:cursor-wait disabled:opacity-60"
              >
                <Unlink className="h-3.5 w-3.5" />
                解除当前电脑的莉刻账号
              </button>
            )}
          </div>
          )}
          <button type="button" onClick={() => void handleLogout()} className="mt-1 flex w-full items-center gap-2 rounded px-3 py-2 text-left text-sm text-white/76 transition hover:bg-white/10 hover:text-white">
            <LogOut className="h-4 w-4" />
            {t('logout')}
          </button>
        </div>
      )}
    </div>
  );
}
