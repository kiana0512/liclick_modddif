export type PersonalLiclickAccountStatus = {
  bound: boolean;
  valid: boolean;
  email?: string;
  displayName?: string;
  expiresAt?: string;
  reason?: string;
  message?: string;
};

export type PersonalLiclickBindingStart = {
  loginId: string;
  redirectUrl: string;
  expiresAt?: string;
  message?: string;
};

export type PersonalLiclickBindingProgress = {
  done: boolean;
  status: 'pending' | 'succeeded' | 'failed';
  account?: PersonalLiclickAccountStatus;
  message?: string;
  error?: string;
};

let cachedAccountStatus: PersonalLiclickAccountStatus | undefined;

export class LocalLiclickAccountApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'LocalLiclickAccountApiError';
  }
}

function cloudAccountError() {
  return new LocalLiclickAccountApiError('Cloud Build 使用平台统一身份，不支持设备级账号绑定。');
}

export async function requirePersonalLiclickRuntime(): Promise<never> {
  throw cloudAccountError();
}

export async function getPersonalLiclickAccountStatus() {
  cachedAccountStatus = {
    bound: false,
    valid: false,
    message: 'Cloud Build 使用平台统一身份。',
  };
  return cachedAccountStatus;
}

export function getCachedPersonalLiclickAccountStatus() {
  return cachedAccountStatus;
}

export function invalidateCachedPersonalLiclickAccountStatus() {
  cachedAccountStatus = undefined;
}

export function isPersonalLiclickAccountForEmail(
  account: PersonalLiclickAccountStatus | undefined,
  expectedEmail: string | undefined,
) {
  if (!account?.valid) return false;
  if (!expectedEmail) return true;
  return account.email?.trim().toLowerCase() === expectedEmail.trim().toLowerCase();
}

export async function startPersonalLiclickAccountBinding(): Promise<PersonalLiclickBindingStart> {
  throw cloudAccountError();
}

export async function pollPersonalLiclickAccountBinding(): Promise<PersonalLiclickBindingProgress> {
  throw cloudAccountError();
}

export async function unbindPersonalLiclickAccount(): Promise<never> {
  throw cloudAccountError();
}
