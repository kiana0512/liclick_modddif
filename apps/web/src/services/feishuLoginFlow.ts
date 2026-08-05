import { getAuthMe, getProviderStatus, pollFeishuLogin, startFeishuLogin } from './authApiClient';
import {
  getIdentityStatus,
  IdentityApiError,
  startIdentityBinding,
} from './identityApiClient';

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
  const pollIntervalMs = options.pollIntervalMs ?? 1500;
  const popup = window.open('about:blank', '_blank', 'popup,width=720,height=760');
  if (!popup) {
    throw new Error('浏览器拦截了飞书/IDaaS 授权窗口，请允许弹窗后重新点击登录。');
  }
  // The OAuth page must not retain a scripting handle back to the LI3D page.
  // The parent can still navigate and close the WindowProxy it created.
  popup.opener = null;

  try {
    const providerStatus = await getProviderStatus().catch(() => undefined);
    let identityStatus;
    try {
      identityStatus = await getIdentityStatus();
    } catch (error) {
      // Older workspace servers do not expose identity binding yet. Keep their
      // existing OAuth start endpoint usable during a rolling deployment.
      if (!(error instanceof IdentityApiError && error.status === 404)) throw error;
    }

    if (identityStatus?.ambiguous) {
      options.onStatus?.('这台设备绑定过多个账号，需要重新完成飞书授权。');
    } else if (identityStatus?.bound) {
      const current = await getAuthMe().catch(() => undefined);
      if (current?.authenticated && current.user) {
        popup.close();
        return {
          user: current.user,
          authMode: current.authMode,
          message: `已恢复 ${identityStatus.user_name ?? current.user.displayName} 的登录状态。`,
        };
      }
      options.onStatus?.('已识别设备绑定，正在恢复飞书登录状态。');
    }

    let started;
    if (providerStatus?.feishuLoginProvider === 'atlas-cli') {
      // Device-binding start is a browser OAuth endpoint. The local development
      // server may instead authenticate through the already installed Atlas
      // CLI/token cache; use the normal auth endpoint and bind the device after
      // that endpoint has created the Feishu-authenticated browser session.
      started = await startFeishuLogin();
    } else {
      try {
        started = await startIdentityBinding();
      } catch (error) {
        if (!(error instanceof IdentityApiError && (error.status === 404 || error.status === 409))) {
          throw error;
        }
        started = await startFeishuLogin();
      }
    }
    if (started.user) {
      await getIdentityStatus().catch(() => undefined);
      popup.close();
      return started;
    }
    options.onStatus?.(started.message ?? '飞书/IDaaS 授权任务已启动，正在等待授权窗口。');

    let loginId = started.loginId;
    let openedUrl = '';
    if (started.redirectUrl) {
      openedUrl = started.redirectUrl;
      popup.location.href = started.redirectUrl;
      options.onStatus?.('授权窗口已打开，请在飞书/IDaaS 页面完成登录。');
    } else {
      options.onStatus?.('服务器正在准备飞书/IDaaS 授权链接，请稍等。');
    }
    if (!loginId) {
      throw new Error(started.message ?? '登录服务没有返回用户信息，请确认飞书/IDaaS 登录已完成。');
    }
    options.onLoginStarted?.({
      loginId,
      redirectUrl: started.redirectUrl,
    });

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await wait(pollIntervalMs);
      const polled = await pollFeishuLogin(loginId);
      if (polled.user) {
        await getIdentityStatus().catch(() => undefined);
        popup.close();
        return polled;
      }
      loginId = polled.loginId ?? loginId;
      if (polled.message) options.onStatus?.(polled.message);
      if (polled.redirectUrl && polled.redirectUrl !== openedUrl) {
        if (popup.closed) {
          throw new Error('授权窗口已关闭，请重新点击飞书登录。');
        }
        openedUrl = polled.redirectUrl;
        popup.location.href = polled.redirectUrl;
      }
    }

    throw new Error('飞书/IDaaS 登录等待超时，可能是用户取消授权或授权窗口未完成。请重新点击飞书登录。');
  } catch (error) {
    popup.close();
    throw error;
  }
}
