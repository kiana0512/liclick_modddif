import { useState } from 'react';
import { LoaderCircle, LogIn, ShieldCheck } from 'lucide-react';
import { Li3dLogo } from '@/components/common/Li3dLogo';
import { devLogin } from '@/services/authApiClient';
import { runFeishuLoginFlow } from '@/services/feishuLoginFlow';
import { useAuthStore } from '@/stores/authStore';

export function AppAuthGate() {
  const authStatus = useAuthStore((state) => state.status);
  const providerStatus = useAuthStore((state) => state.providerStatus);
  const setAuthenticated = useAuthStore((state) => state.setAuthenticated);
  const [busy, setBusy] = useState(false);
  const [statusMessage, setStatusMessage] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const checking = authStatus === 'checking';

  async function handleLogin() {
    if (busy || checking) return;
    setBusy(true);
    setErrorMessage('');
    setStatusMessage('正在启动飞书授权…');
    try {
      if (providerStatus?.devLoginEnabled && !providerStatus.feishuOAuthEnabled) {
        const result = await devLogin({ displayName: 'Liclick Dev User', email: 'dev@liclick.local' });
        setAuthenticated(result.user, 'dev-mock', providerStatus);
        return;
      }
      const result = await runFeishuLoginFlow({ onStatus: setStatusMessage });
      if (!result.user) throw new Error('登录服务没有返回用户信息，请重新完成飞书授权。');
      setStatusMessage('登录成功，正在进入 Li3D…');
      setAuthenticated(result.user, result.authMode ?? 'feishu-oauth', providerStatus);
    } catch (error) {
      setStatusMessage('');
      setErrorMessage(error instanceof Error ? error.message : '飞书登录失败，请稍后重试。');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="liclick-surface relative flex min-h-screen overflow-hidden bg-[#070813] text-white">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_42%,rgba(126,74,246,0.17),transparent_32%),radial-gradient(circle_at_12%_0%,rgba(217,63,190,0.11),transparent_28%)]" />
      <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-violet-400/40 to-transparent" />
      <div className="relative m-auto flex w-full max-w-[460px] flex-col items-center px-6 py-12 text-center">
        <div className="mb-7 grid h-28 w-28 place-items-center rounded-[32px] border border-white/10 bg-white/[0.045] shadow-[0_28px_80px_rgba(56,25,128,0.35)] backdrop-blur-xl">
          <Li3dLogo className="h-24 w-24 drop-shadow-[0_0_24px_rgba(139,92,246,0.32)]" />
        </div>
        <div className="mt-2 text-xs font-semibold tracking-[0.24em] text-white/42">AI 3D CREATION SUITE</div>
        <section className="mt-10 w-full rounded-2xl border border-white/10 bg-white/[0.045] p-5 text-left shadow-[0_24px_80px_rgba(0,0,0,0.26)] backdrop-blur-xl">
          <div className="flex items-start gap-3">
            <div className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-violet-500/15 text-violet-300">
              <ShieldCheck className="h-[18px] w-[18px]" aria-hidden="true" />
            </div>
            <div>
              <h1 className="text-base font-semibold text-white/92">登录后进入 Li3D</h1>
              <p className="mt-1 text-sm leading-6 text-white/50">使用飞书完成身份认证。登录成功后将继续打开你当前访问的页面。</p>
            </div>
          </div>
          <button
            type="button"
            disabled={checking || busy}
            onClick={() => void handleLogin()}
            className="mt-5 flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-fuchsia-500 to-violet-500 px-4 text-sm font-semibold text-white shadow-[0_12px_34px_rgba(168,85,247,0.28)] transition hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-300/80 disabled:cursor-wait disabled:opacity-60"
          >
            {checking || busy ? <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" /> : <LogIn className="h-4 w-4" aria-hidden="true" />}
            {checking ? '正在确认登录状态…' : busy ? '等待飞书授权…' : '使用飞书认证登录'}
          </button>
          {statusMessage ? <p className="mt-3 text-center text-xs leading-5 text-violet-200/70">{statusMessage}</p> : null}
          {errorMessage ? <p role="alert" className="mt-3 rounded-lg border border-rose-400/20 bg-rose-500/10 px-3 py-2 text-xs leading-5 text-rose-200">{errorMessage}</p> : null}
        </section>
        <p className="mt-5 text-xs text-white/28">仅用于公司内部身份认证</p>
      </div>
    </main>
  );
}
