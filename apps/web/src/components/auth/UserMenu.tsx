import { useState } from 'react';
import { LogIn, LogOut } from 'lucide-react';
import { devLogin, logout, startFeishuLogin } from '@/services/authApiClient';
import { useAuthStore } from '@/stores/authStore';
import { useToastStore } from '@/stores/toastStore';

export function UserMenu({ onLogout }: { onLogout: () => void }) {
  const [open, setOpen] = useState(false);
  const user = useAuthStore((state) => state.user);
  const providerStatus = useAuthStore((state) => state.providerStatus);
  const setAuthenticated = useAuthStore((state) => state.setAuthenticated);
  const setAnonymous = useAuthStore((state) => state.setAnonymous);
  const pushToast = useToastStore((state) => state.pushToast);

  async function handleLogin() {
    try {
      if (providerStatus?.devLoginEnabled && !providerStatus.feishuOAuthEnabled) {
        const result = await devLogin({ displayName: 'Liclick Dev User', email: 'dev@liclick.local' });
        setAuthenticated(result.user, 'dev-mock', providerStatus);
        return;
      }
      const result = await startFeishuLogin();
      if (result.user) {
        setAuthenticated(result.user, result.authMode ?? 'feishu-oauth', providerStatus);
        pushToast({
          tone: 'success',
          title: '飞书登录成功',
          description: result.message ?? '莉刻/Atlas 登录已可用。',
          dedupeKey: 'auth-login-success',
        });
        return;
      }
      if (result.redirectUrl) window.location.href = result.redirectUrl;
    } catch (error) {
      pushToast({
        tone: 'error',
        title: '飞书登录不可用',
        description: error instanceof Error ? error.message : 'Could not start login.',
        dedupeKey: 'auth-login-failed',
      });
    }
  }

  async function handleLogout() {
    await logout().catch(() => undefined);
    setAnonymous();
    onLogout();
  }

  if (!user) {
    return (
      <button
        type="button"
        onClick={() => void handleLogin()}
        className="inline-flex h-10 items-center gap-2 rounded-md border border-white/16 bg-black/18 px-3 text-sm font-medium text-white/84 transition hover:bg-white/10 hover:text-white"
        title="使用飞书登录"
      >
        <LogIn className="h-4 w-4" />
        飞书登录
      </button>
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
          <button type="button" onClick={() => void handleLogout()} className="mt-1 flex w-full items-center gap-2 rounded px-3 py-2 text-left text-sm text-white/76 transition hover:bg-white/10 hover:text-white">
            <LogOut className="h-4 w-4" />
            退出登录
          </button>
        </div>
      )}
    </div>
  );
}
