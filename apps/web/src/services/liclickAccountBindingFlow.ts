import {
  getCachedPersonalLiclickAccountStatus,
  getPersonalLiclickAccountStatus,
  isPersonalLiclickAccountForEmail,
  pollPersonalLiclickAccountBinding,
  startPersonalLiclickAccountBinding,
  type PersonalLiclickAccountStatus,
} from './liclickAccountApiClient';

type PersonalLiclickBindingFlowOptions = {
  expectedEmail?: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
  onStatus?: (message: string) => void;
};

type FeishuAccountIdentity = {
  email?: string;
  authSource?: string;
};

function wait(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function preparePopup(popup: Window) {
  try {
    popup.document.title = '绑定个人莉刻账号';
    popup.document.body.style.cssText =
      'margin:0;background:#090917;color:#fff;font:16px system-ui;display:grid;place-items:center;min-height:100vh';
    popup.document.body.textContent = '正在准备莉刻账号授权…';
  } catch {
    // The popup may already have navigated. Its content is not required by the flow.
  }
  popup.opener = null;
}

export async function runPersonalLiclickAccountBindingFlow(
  options: PersonalLiclickBindingFlowOptions = {},
): Promise<PersonalLiclickAccountStatus> {
  const popup = window.open(
    'about:blank',
    'li3d-personal-liclick-account',
    'popup,width=760,height=780',
  );
  if (!popup) {
    throw new Error('浏览器拦截了莉刻账号授权窗口，请允许弹窗后重新点击绑定。');
  }
  preparePopup(popup);

  try {
    options.onStatus?.('正在联系这台电脑上的贴图组件。');
    const existing = await getPersonalLiclickAccountStatus();
    if (isPersonalLiclickAccountForEmail(existing, options.expectedEmail)) {
      popup.close();
      return existing;
    }
    if (existing.valid && options.expectedEmail) {
      options.onStatus?.(
        `此电脑当前绑定的是 ${existing.email ?? '其他账号'}，请改用 ${options.expectedEmail} 完成授权。`,
      );
    }
    const started = await startPersonalLiclickAccountBinding(options.expectedEmail);
    options.onStatus?.(started.message ?? '授权窗口已打开，请登录你自己的莉刻账号。');
    popup.location.replace(started.redirectUrl);

    const deadline = Date.now() + (options.timeoutMs ?? 5 * 60 * 1000);
    const pollIntervalMs = options.pollIntervalMs ?? 1_200;
    while (Date.now() < deadline) {
      await wait(pollIntervalMs);
      const progress = await pollPersonalLiclickAccountBinding(started.loginId);
      if (progress.message) options.onStatus?.(progress.message);
      if (progress.status === 'failed') {
        throw new Error(progress.error || progress.message || '个人莉刻账号授权失败，请重新绑定。');
      }
      if (progress.status === 'succeeded') {
        const account = await getPersonalLiclickAccountStatus({ verifyRuntime: false });
        if (!isPersonalLiclickAccountForEmail(account, options.expectedEmail)) {
          throw new Error(account.message || '莉刻授权已返回，但账号凭证未通过验证，请重新绑定。');
        }
        popup.close();
        return account;
      }
      if (popup.closed) {
        throw new Error('莉刻账号授权窗口已关闭，请重新点击绑定并完成授权。');
      }
    }
    throw new Error('等待个人莉刻账号授权超时，请重新点击绑定。');
  } catch (error) {
    popup.close();
    throw error;
  }
}

export function ensurePersonalLiclickAccountForUser(
  user: FeishuAccountIdentity | undefined,
  options: Omit<PersonalLiclickBindingFlowOptions, 'expectedEmail'> = {},
) {
  if (!user) {
    return Promise.reject(new Error('请先完成飞书登录，再绑定个人莉刻账号。'));
  }
  const expectedEmail = user.email?.trim();
  if (!expectedEmail && user.authSource !== 'dev-mock') {
    return Promise.reject(
      new Error(
        '飞书登录没有返回企业邮箱，无法校验莉刻账号归属。请让管理员为应用开通用户邮箱读取权限后重新登录。',
      ),
    );
  }
  const cached = getCachedPersonalLiclickAccountStatus();
  if (isPersonalLiclickAccountForEmail(cached, expectedEmail)) {
    return Promise.resolve(cached!);
  }
  return runPersonalLiclickAccountBindingFlow({
    ...options,
    expectedEmail: user.authSource === 'dev-mock' ? undefined : expectedEmail,
  });
}
