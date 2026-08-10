import { getWorkspaceApiBase } from './workspaceApiBase';

const workspaceApiBase = getWorkspaceApiBase(import.meta.env.VITE_LICLICK_WORKSPACE_API);

type LocalIdentityProofResponse = {
  proof?: string;
  expiresAt?: string;
  error?: string;
};

type LocalIdentityProofRequestOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
};

async function isRejectedOneTimeProof(response: Response) {
  if (response.status !== 401) return false;
  const payload = (await response.clone().json().catch(() => undefined)) as
    | { code?: string }
    | undefined;
  return payload?.code === 'INVALID_LOCAL_IDENTITY_PROOF';
}

export async function getLocalIdentityProof(
  options: LocalIdentityProofRequestOptions = {},
) {
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? 8_000;
  let timedOut = false;
  const abortFromCaller = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) abortFromCaller();
  else options.signal?.addEventListener('abort', abortFromCaller, { once: true });
  const timeout = window.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  let response: Response;
  try {
    response = await fetch(`${workspaceApiBase}/api/auth/local-proof`, {
      method: 'POST',
      credentials: 'include',
      cache: 'no-store',
      headers: { accept: 'application/json' },
      signal: controller.signal,
    });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    if (timedOut) {
      throw new Error('LI3D 登录服务响应超时，正在自动重试。');
    }
    throw new Error('无法连接 LI3D 登录服务验证当前飞书身份，请检查网络后重试。');
  } finally {
    window.clearTimeout(timeout);
    options.signal?.removeEventListener('abort', abortFromCaller);
  }
  const payload = (await response.json().catch(() => undefined)) as
    | LocalIdentityProofResponse
    | undefined;
  if (!response.ok || !payload?.proof) {
    throw new Error(payload?.error || '请先完成飞书登录，再连接本地贴图组件。');
  }
  return payload.proof;
}

/**
 * A local identity proof is intentionally single-use. If a component request
 * reaches the verifier after a transient retry/replay consumed that proof,
 * obtain a brand-new proof and replay the original request exactly once. This
 * repairs the bridge without logging out a still-valid Feishu browser session.
 */
export async function fetchWithLocalIdentityProof(
  input: string | URL,
  init: RequestInit,
  proofOptions: LocalIdentityProofRequestOptions = {},
) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const headers = new Headers(init.headers);
    headers.set('x-li3d-identity-proof', await getLocalIdentityProof(proofOptions));
    const response = await fetch(input, { ...init, headers });
    if (attempt === 0 && (await isRejectedOneTimeProof(response))) continue;
    return response;
  }
  throw new Error('无法刷新本地飞书身份证明，请重试。');
}
