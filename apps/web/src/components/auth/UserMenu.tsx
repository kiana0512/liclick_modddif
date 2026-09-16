import { lazy, Suspense, useEffect, useState } from 'react';
import type { StorageOverview } from '@liclick/contracts';
import { HardDrive, KeyRound, LogIn, LogOut, Unlink } from 'lucide-react';
import { formatStorageBytes } from '@/features/storage/storagePresentation';
import { devLogin, logout } from '@/services/authApiClient';
import { runFeishuLoginFlow } from '@/services/feishuLoginFlow';
import { getWorkspaceApiBase } from '@/services/workspaceApiBase';
import { useAuthStore } from '@/stores/authStore';
import { useGenerationStore } from '@/stores/generationStore';
import { useT } from '@/stores/i18nStore';
import { useToastStore } from '@/stores/toastStore';
import { getStorageOverview } from '@/services/workspaceApiClient';

type UserMenuProps = { onLogout: () => void };

type LiclickAccountStatus = {
  bound: boolean;
  email?: string;
  reason?: string;
  sharedTestAccount?: boolean;
};

type LiclickBindingStatus = {
  loginId: string;
  status: 'pending' | 'bound';
  redirectUrl?: string;
  email?: string;
  message?: string;
};

const workspaceApiBase = getWorkspaceApiBase(import.meta.env.VITE_LICLICK_WORKSPACE_API);
const StorageManagementDialog = lazy(() =>
  import('@/features/storage/StorageManagementDialog').then((module) => ({
    default: module.StorageManagementDialog,
  })),
);

async function liclickAccountRequest<T>(path: string, init?: RequestInit) {
  const response = await fetch(`${workspaceApiBase}${path}`, {
    ...init,
    credentials: 'include',
  });
  const payload = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(payload.error || '莉刻账号服务暂时不可用。');
  return payload;
}

export function UserMenu({ onLogout }: UserMenuProps) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loginStatus, setLoginStatus] = useState('');
  const [liclickAccount, setLiclickAccount] = useState<LiclickAccountStatus>();
  const [storageOverview, setStorageOverview] = useState<StorageOverview>();
  const [storageOpen, setStorageOpen] = useState(false);
  const t = useT();
  const user = useAuthStore((state) => state.user);
  const localProfile = useAuthStore((state) => state.localProfile);
  const providerStatus = useAuthStore((state) => state.providerStatus);
  const setAuthenticated = useAuthStore((state) => state.setAuthenticated);
  const setAnonymous = useAuthStore((state) => state.setAnonymous);
  const refreshProviderStatus = useAuthStore((state) => state.refreshProviderStatus);
  const pushToast = useToastStore((state) => state.pushToast);
  const generationRunning = useGenerationStore((state) => state.isGenerating);

  useEffect(() => {
    if (!open || !user) return;
    let cancelled = false;
    void liclickAccountRequest<LiclickAccountStatus>('/api/liclick/account')
      .then((status) => {
        if (!cancelled) setLiclickAccount(status);
      })
      .catch(() => {
        if (!cancelled) setLiclickAccount({ bound: false, reason: '账号状态读取失败' });
      });
    void getStorageOverview()
      .then(({ overview }) => {
        if (!cancelled) setStorageOverview(overview);
      })
      .catch(() => {
        if (!cancelled) setStorageOverview(undefined);
      });
    return () => {
      cancelled = true;
    };
  }, [open, user]);

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
    if (
      generationRunning &&
      !window.confirm('当前生图任务仍在运行。退出登录可能导致任务进度或结果丢失，确定退出吗？')
    ) {
      return;
    }
    await logout().catch(() => undefined);
    setAnonymous();
    onLogout();
  }

  async function handleSwitchAccount() {
    if (busy) return;
    const popup = window.open('about:blank', 'liclick-account-auth', 'popup,width=720,height=780');
    setBusy(true);
    setLoginStatus('正在启动莉刻账号授权...');
    try {
      let status = await liclickAccountRequest<LiclickBindingStatus>(
        '/api/liclick/account-binding/start',
        { method: 'POST' },
      );
      let openedUrl = '';
      const deadline = Date.now() + 10 * 60 * 1000;
      while (status.status !== 'bound' && Date.now() < deadline) {
        if (status.redirectUrl && status.redirectUrl !== openedUrl) {
          openedUrl = status.redirectUrl;
          if (popup) popup.location.href = openedUrl;
          else window.open(openedUrl, '_blank', 'noopener,noreferrer');
        }
        setLoginStatus(status.message || '请在授权窗口完成莉刻账号授权...');
        await new Promise((resolve) => window.setTimeout(resolve, 1_000));
        status = await liclickAccountRequest<LiclickBindingStatus>(
          `/api/liclick/account-binding/${encodeURIComponent(status.loginId)}`,
        );
      }
      if (status.status !== 'bound') throw new Error('莉刻账号授权超时，请重试。');
      popup?.close();
      setLiclickAccount({ bound: true, email: status.email });
      setLoginStatus('');
      pushToast({
        tone: 'success',
        title: '莉刻账号已绑定',
        description: `后续生图只会使用 ${status.email ?? '当前用户'} 的个人额度。`,
        dedupeKey: 'liclick-account-bound',
      });
    } catch (error) {
      popup?.close();
      const message = error instanceof Error ? error.message : '莉刻账号绑定失败。';
      setLoginStatus('');
      pushToast({
        tone: 'error',
        title: '莉刻账号绑定失败',
        description: message,
        dedupeKey: 'liclick-account-bind-failed',
      });
    } finally {
      setBusy(false);
    }
  }

  async function handleUnlinkAccount() {
    if (
      generationRunning &&
      !window.confirm('当前生图任务仍在运行。解除莉刻账号可能导致任务轮询或结果获取失败，确定解除吗？')
    ) {
      return;
    }
    setBusy(true);
    try {
      await liclickAccountRequest<LiclickAccountStatus>('/api/liclick/account', {
        method: 'DELETE',
      });
      setLiclickAccount({ bound: false });
      pushToast({
        tone: 'success',
        title: '已解除莉刻账号',
        description: '飞书会话仍然有效；重新绑定个人莉刻账号后才能继续生图。',
        dedupeKey: 'liclick-account-unlinked',
      });
    } catch (error) {
      pushToast({
        tone: 'error',
        title: '解除莉刻账号失败',
        description: error instanceof Error ? error.message : '请稍后重试。',
        dedupeKey: 'liclick-account-unlink-failed',
      });
    } finally {
      setBusy(false);
    }
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
          <div className="flex items-center justify-between gap-3 rounded px-3 py-2 text-left text-sm text-white/88">
            <span className="inline-flex min-w-0 items-start gap-2">
              <KeyRound className="mt-0.5 h-4 w-4 shrink-0" />
              <span className="min-w-0">
                <span className="block truncate font-medium">
                  {liclickAccount?.sharedTestAccount ? '测试共享莉刻账号' : '当前用户的莉刻账号'}
                </span>
                <span className={`block truncate text-xs font-medium ${liclickAccount?.bound ? 'text-emerald-400' : 'text-amber-400'}`}>
                  {liclickAccount?.bound ? liclickAccount.email : liclickAccount ? '未绑定' : '检查中...'}
                </span>
              </span>
            </span>
            {!liclickAccount?.sharedTestAccount && (
              <button
                type="button"
                onClick={() => void handleSwitchAccount()}
                disabled={busy}
                className="shrink-0 text-xs font-semibold text-liclick-pink transition hover:text-white disabled:opacity-50"
              >
                {liclickAccount?.bound ? '更换' : '绑定'}
              </button>
            )}
          </div>
          {!liclickAccount?.sharedTestAccount && (
            <button
              type="button"
              onClick={() => void handleUnlinkAccount()}
              className="mt-1 flex w-full items-center gap-2 rounded px-3 py-2 text-left text-sm text-white/76 transition hover:bg-white/10 hover:text-white"
            >
              <Unlink className="h-4 w-4" />解除当前用户的莉刻账号
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              setStorageOpen(true);
            }}
            className="mt-1 flex w-full items-center justify-between gap-3 rounded px-3 py-2 text-left text-sm text-white/76 transition hover:bg-white/10 hover:text-white"
          >
            <span className="inline-flex min-w-0 items-start gap-2">
              <HardDrive className="mt-0.5 h-4 w-4 shrink-0" />
              <span className="min-w-0">
                <span className="block font-medium text-white/88">存储空间</span>
                <span className="block truncate text-xs text-white/44">
                  {storageOverview?.status === 'ready'
                    ? `已用 ${formatStorageBytes(storageOverview.usedBytes)} · 可清理 ${formatStorageBytes(storageOverview.reclaimableBytes)}`
                    : storageOverview?.status === 'failed'
                      ? '读取失败'
                      : storageOverview?.status === 'scanning'
                        ? '正在扫描...'
                        : '待扫描'}
                </span>
              </span>
            </span>
            <span className="shrink-0 text-xs font-semibold text-liclick-pink">管理</span>
          </button>
          {user.performanceLabAdmin && (
            <a href={`${import.meta.env.BASE_URL}performance-lab-admin`}
              className="mt-1 block rounded px-3 py-2 text-sm text-white/76 hover:bg-white/10">
              日志监测
            </a>
          )}
          <button type="button" onClick={() => void handleLogout()} className="mt-1 flex w-full items-center gap-2 rounded px-3 py-2 text-left text-sm text-white/76 transition hover:bg-white/10 hover:text-white">
            <LogOut className="h-4 w-4" />{t('logout')}
          </button>
          {/* Product label stays fixed until launch; independent of deployment metadata. */}
          <div className="mt-2 border-t border-white/10 px-3 pb-1 pt-3 text-xs text-white/46">
            版本 0.1
          </div>
        </div>
      )}
      {storageOpen ? (
        <Suspense fallback={null}>
          <StorageManagementDialog
            initialOverview={storageOverview}
            onOverviewChange={setStorageOverview}
            onClose={() => setStorageOpen(false)}
          />
        </Suspense>
      ) : null}
    </div>
  );
}
