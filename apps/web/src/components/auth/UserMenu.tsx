import { useState } from 'react';
import { Languages, LogIn, LogOut } from 'lucide-react';
import { completeFeishuLogin, devLogin, logout } from '@/services/authApiClient';
import { runFeishuLoginFlow } from '@/services/feishuLoginFlow';
import { useAuthStore } from '@/stores/authStore';
import { useI18nStore, useT } from '@/stores/i18nStore';
import { useToastStore } from '@/stores/toastStore';

export function UserMenu({ onLogout }: { onLogout: () => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loginStatus, setLoginStatus] = useState('');
  const [manualLoginId, setManualLoginId] = useState('');
  const [authWindowUrl, setAuthWindowUrl] = useState('');
  const [callbackUrl, setCallbackUrl] = useState('');
  const [manualBusy, setManualBusy] = useState(false);
  const t = useT();
  const language = useI18nStore((state) => state.language);
  const setLanguage = useI18nStore((state) => state.setLanguage);
  const user = useAuthStore((state) => state.user);
  const providerStatus = useAuthStore((state) => state.providerStatus);
  const setAuthenticated = useAuthStore((state) => state.setAuthenticated);
  const setAnonymous = useAuthStore((state) => state.setAnonymous);
  const pushToast = useToastStore((state) => state.pushToast);

  async function handleLogin() {
    if (busy) return;
    setBusy(true);
    setManualLoginId('');
    setAuthWindowUrl('');
    setCallbackUrl('');
    setLoginStatus('正在启动飞书授权...');
    try {
      if (providerStatus?.devLoginEnabled && !providerStatus.feishuOAuthEnabled) {
        const result = await devLogin({ displayName: 'Liclick Dev User', email: 'dev@liclick.local' });
        setAuthenticated(result.user, 'dev-mock', providerStatus);
        return;
      }
      const result = await runFeishuLoginFlow({
        onLoginStarted: ({ loginId, redirectUrl, requiresManualCallback }) => {
          setAuthWindowUrl(redirectUrl ?? '');
          if (requiresManualCallback || providerStatus?.feishuLoginProvider === 'atlas-cli') {
            setManualLoginId(loginId);
          }
        },
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
        setManualLoginId('');
        setAuthWindowUrl('');
        setCallbackUrl('');
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

  async function handleCompleteWithCallback() {
    if (!manualLoginId || !callbackUrl.trim() || manualBusy) return;
    setManualBusy(true);
    setLoginStatus('正在把 localhost 回调提交到 A100 服务器...');
    try {
      const result = await completeFeishuLogin({
        loginId: manualLoginId,
        callbackUrl: callbackUrl.trim(),
      });
      if (!result.user) throw new Error('回调已提交，但登录服务没有返回用户信息。');
      setAuthenticated(result.user, result.authMode ?? 'feishu-oauth', providerStatus);
      setManualLoginId('');
      setAuthWindowUrl('');
      setCallbackUrl('');
      setLoginStatus('');
      setBusy(false);
      pushToast({
        tone: 'success',
        title: t('feishuLoginSuccess'),
        description: result.message ?? t('atlasLoginReady'),
        dedupeKey: 'auth-login-success',
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : '回调提交失败。';
      setLoginStatus(message);
      pushToast({
        tone: 'error',
        title: '飞书回调提交失败',
        description: message,
        dedupeKey: 'auth-callback-complete-failed',
      });
    } finally {
      setManualBusy(false);
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
        {(busy || manualLoginId) && (
          <div className="fixed inset-0 z-[90] grid place-items-center bg-black/68 px-4 backdrop-blur-sm">
            <div className="w-full max-w-[560px] rounded-lg border border-white/14 bg-[#151520] p-5 text-white shadow-2xl">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="text-base font-semibold text-white">飞书 / IDaaS 登录</div>
                  <div className="mt-1 text-xs leading-5 text-white/58">
                    当前页面复用现有 Liclick 入口完成登录，不新增公网端口。授权窗口完成后，把
                    <span className="mx-1 font-mono text-amber-100">localhost:20265/callback</span>
                    完整地址提交回来即可。
                  </div>
                </div>
                <button
                  type="button"
                  className="grid h-8 w-8 place-items-center rounded-md text-white/60 hover:bg-white/10 hover:text-white"
                  onClick={() => {
                    setManualLoginId('');
                    setAuthWindowUrl('');
                    setCallbackUrl('');
                    setLoginStatus('');
                    setBusy(false);
                  }}
                  aria-label="关闭"
                >
                  ×
                </button>
              </div>

              <div className="mt-4 rounded-md border border-white/10 bg-white/[0.045] p-3 text-xs leading-5 text-white/68">
                <div className="font-semibold text-white/86">流程</div>
                <div className="mt-1">1. 在新窗口完成飞书 / IDaaS 授权或扫码。</div>
                <div>2. 如果新窗口最后停在 localhost 回调页，复制浏览器地址栏完整 URL。</div>
                <div>3. 粘贴到下方，Liclick 后端会通过当前端口的 API 转发给服务器上的 Atlas gateway。</div>
              </div>

              {authWindowUrl && (
                <button
                  type="button"
                  className="mt-4 h-9 rounded-md border border-white/14 bg-white/[0.06] px-3 text-xs font-semibold text-white/78 transition hover:bg-white/12 hover:text-white"
                  onClick={() => window.open(authWindowUrl, '_blank', 'noopener,noreferrer')}
                >
                  重新打开授权窗口
                </button>
              )}

            <textarea
              value={callbackUrl}
              onChange={(event) => setCallbackUrl(event.target.value)}
              placeholder="http://localhost:20265/callback?id_token=..."
              className="mt-4 h-24 w-full resize-none rounded-md border border-white/14 bg-black/24 p-3 text-xs text-white outline-none focus:border-liclick-pink"
            />
            {loginStatus && <div className="mt-2 line-clamp-2 text-xs text-white/62">{loginStatus}</div>}
            <div className="mt-3 flex justify-end gap-2">
              <button
                type="button"
                className="h-8 rounded-md px-3 text-xs font-semibold text-white/70 hover:bg-white/10"
                onClick={() => {
                  setManualLoginId('');
                  setAuthWindowUrl('');
                  setCallbackUrl('');
                  setLoginStatus('');
                  setBusy(false);
                }}
              >
                取消
              </button>
              <button
                type="button"
                disabled={!callbackUrl.trim() || manualBusy}
                className="h-8 rounded-md bg-gradient-to-r from-liclick-pink to-liclick-purple px-3 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
                onClick={() => void handleCompleteWithCallback()}
              >
                {manualBusy ? '提交中...' : '提交回调完成登录'}
              </button>
            </div>
            </div>
          </div>
        )}
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
          <button type="button" onClick={() => void handleLogout()} className="mt-1 flex w-full items-center gap-2 rounded px-3 py-2 text-left text-sm text-white/76 transition hover:bg-white/10 hover:text-white">
            <LogOut className="h-4 w-4" />
            {t('logout')}
          </button>
        </div>
      )}
    </div>
  );
}
