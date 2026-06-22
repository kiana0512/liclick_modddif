import { useEffect, useState } from 'react';
import { LogIn, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { devLogin, getProviderStatus, startFeishuLogin } from '@/services/authApiClient';
import { useAuthStore } from '@/stores/authStore';

export function LoginGate({ onAuthenticated }: { onAuthenticated: () => Promise<void> | void }) {
  const [displayName, setDisplayName] = useState('Liclick Dev User');
  const [email, setEmail] = useState('dev@liclick.local');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const providerStatus = useAuthStore((state) => state.providerStatus);
  const setAnonymous = useAuthStore((state) => state.setAnonymous);
  const setAuthenticated = useAuthStore((state) => state.setAuthenticated);

  useEffect(() => {
    void getProviderStatus()
      .then((status) => setAnonymous(status.authMode, status))
      .catch((nextError) => setError(nextError instanceof Error ? nextError.message : 'Could not load auth provider.'));
  }, [setAnonymous]);

  async function handleDevLogin() {
    setBusy(true);
    setError(undefined);
    try {
      const result = await devLogin({ displayName, email });
      setAuthenticated(result.user, 'dev-mock', providerStatus);
      await onAuthenticated();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Dev login failed.');
    } finally {
      setBusy(false);
    }
  }

  async function handleFeishuLogin() {
    setBusy(true);
    setError(undefined);
    try {
      const result = await startFeishuLogin();
      if (result.user) {
        setAuthenticated(result.user, result.authMode ?? 'feishu-oauth', providerStatus);
        await onAuthenticated();
        return;
      }
      if (result.redirectUrl) window.location.href = result.redirectUrl;
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Feishu login failed.');
      setBusy(false);
    }
  }

  return (
    <main className="liclick-surface grid min-h-screen place-items-center px-6 text-white">
      <section className="w-full max-w-md rounded-lg border border-white/12 bg-black/34 p-6 shadow-[0_22px_70px_rgba(0,0,0,0.38)] backdrop-blur-md">
        <div className="flex items-center gap-3">
          <div className="grid h-12 w-12 place-items-center rounded-md bg-gradient-to-br from-liclick-pink to-liclick-purple text-xl font-bold">
            L
          </div>
          <div>
            <h1 className="text-2xl font-semibold tracking-normal">Liclick 3D Texture</h1>
            <p className="mt-1 text-sm text-white/48">Sign in to continue</p>
          </div>
        </div>

        {providerStatus?.devLoginEnabled && (
          <div className="mt-6 grid gap-3">
            <input
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              className="h-10 rounded-md border border-white/12 bg-white/[0.06] px-3 text-sm text-white outline-none focus:border-liclick-pink"
              placeholder="Display name"
            />
            <input
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              className="h-10 rounded-md border border-white/12 bg-white/[0.06] px-3 text-sm text-white outline-none focus:border-liclick-pink"
              placeholder="Email"
            />
            <Button variant="primary" disabled={busy} onClick={handleDevLogin}>
              {busy ? <RefreshCw className="h-4 w-4 animate-spin" /> : <LogIn className="h-4 w-4" />}
              Dev Login
            </Button>
          </div>
        )}

        {providerStatus?.feishuOAuthEnabled && (
          <div className="mt-6">
            <Button variant="primary" className="w-full" disabled={busy} onClick={handleFeishuLogin}>
              {busy ? <RefreshCw className="h-4 w-4 animate-spin" /> : <LogIn className="h-4 w-4" />}
              使用飞书登录
            </Button>
            {!providerStatus.feishuConfigured && (
              <p className="mt-3 text-xs leading-5 text-amber-200/80">
                莉刻/Atlas 未登录。点击后会复用本机飞书/IDaaS 登录态发起授权。
              </p>
            )}
          </div>
        )}

        {error && <div className="mt-4 rounded-md border border-rose-300/20 bg-rose-500/12 px-3 py-2 text-sm text-rose-100">{error}</div>}
      </section>
    </main>
  );
}
