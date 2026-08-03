import { getWorkspaceApiBase } from './workspaceApiBase';

const workspaceApiBase = getWorkspaceApiBase(import.meta.env.VITE_LICLICK_WORKSPACE_API);

type LocalIdentityProofResponse = {
  proof?: string;
  expiresAt?: string;
  error?: string;
};

export async function getLocalIdentityProof() {
  let response: Response;
  try {
    response = await fetch(`${workspaceApiBase}/api/auth/local-proof`, {
      method: 'POST',
      credentials: 'include',
      cache: 'no-store',
      headers: { accept: 'application/json' },
    });
  } catch {
    throw new Error('无法连接 LI3D 登录服务验证当前飞书身份，请检查网络后重试。');
  }
  const payload = (await response.json().catch(() => undefined)) as
    | LocalIdentityProofResponse
    | undefined;
  if (!response.ok || !payload?.proof) {
    throw new Error(payload?.error || '请先完成飞书登录，再连接本地贴图组件。');
  }
  return payload.proof;
}
