import { pollFeishuLogin, startFeishuLogin } from './authApiClient';

type FeishuLoginFlowOptions = {
  timeoutMs?: number;
  pollIntervalMs?: number;
  onStatus?: (message: string) => void;
  onLoginStarted?: (login: { loginId: string; redirectUrl?: string }) => void;
};

function wait(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

export async function runFeishuLoginFlow(options: FeishuLoginFlowOptions = {}) {
  const timeoutMs = options.timeoutMs ?? 5 * 60 * 1000;
  const pollIntervalMs = options.pollIntervalMs ?? 2500;
  const started = await startFeishuLogin();
  if (started.user) return started;
  options.onStatus?.(started.message ?? '飞书/IDaaS 授权任务已启动，正在等待授权窗口。');

  let loginId = started.loginId;
  let openedUrl = '';
  if (started.redirectUrl) {
    openedUrl = started.redirectUrl;
    const popup = window.open(started.redirectUrl, '_blank', 'noopener,noreferrer');
    if (!popup) {
      throw new Error('浏览器拦截了飞书/IDaaS 授权窗口，请允许弹窗后重新点击登录。');
    }
    options.onStatus?.('授权窗口已打开，请在 Atlas gateway 授权页面完成登录。');
  } else {
    options.onStatus?.('服务器正在等待 Atlas 返回授权链接，请稍等。');
  }
  if (!loginId) {
    throw new Error(started.message ?? '登录服务没有返回用户信息，请确认 Atlas/莉刻登录已完成。');
  }
  options.onLoginStarted?.({
    loginId,
    redirectUrl: started.redirectUrl,
  });

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await wait(pollIntervalMs);
    const polled = await pollFeishuLogin(loginId);
    if (polled.user) return polled;
    loginId = polled.loginId ?? loginId;
    if (polled.message) options.onStatus?.(polled.message);
    if (polled.redirectUrl && polled.redirectUrl !== openedUrl) {
      openedUrl = polled.redirectUrl;
      const popup = window.open(polled.redirectUrl, '_blank', 'noopener,noreferrer');
      if (!popup) {
        throw new Error('浏览器拦截了飞书/IDaaS 授权窗口，请允许弹窗后重新点击登录。');
      }
    }
  }

  throw new Error('飞书/IDaaS 登录等待超时，可能是用户取消授权或授权窗口未完成。请重新点击飞书登录。');
}
