import type { IncomingMessage } from 'node:http';
import { serverConfig } from '../config.js';
import type { AuthUser } from '../auth/authTypes.js';
import { LocalLiclickAccountError } from './localLiclickAccountService.js';

type VerifiedIdentityResponse = {
  valid?: boolean;
  identity?: {
    id?: string;
    displayName?: string;
    email?: string;
    authSource?: AuthUser['authSource'];
  };
};

function verifierUrl() {
  const configured = process.env.LICLICK_IDENTITY_PROOF_VERIFIER_URL?.trim();
  const url = configured
    ? new URL(configured)
    : new URL('/api/auth/local-proof/verify', serverConfig.frontendUrl);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Local identity proof verifier must use HTTP or HTTPS.');
  }
  return url.toString();
}

function readProof(request: IncomingMessage) {
  const raw = request.headers['x-li3d-identity-proof'];
  return typeof raw === 'string' ? raw.trim() : '';
}

export async function verifyLocalIdentityProof(request: IncomingMessage): Promise<AuthUser> {
  const proof = readProof(request);
  if (!proof || proof.length > 256) {
    throw new LocalLiclickAccountError(
      'LOCAL_IDENTITY_PROOF_REQUIRED',
      401,
      '请先完成飞书登录，再连接本地贴图组件。',
    );
  }
  let response: Response;
  try {
    response = await fetch(verifierUrl(), {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ proof }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new LocalLiclickAccountError(
      'LOCAL_IDENTITY_VERIFIER_UNAVAILABLE',
      503,
      '无法向 LI3D 网页服务验证当前飞书身份，请检查网络后重试。',
    );
  }
  const payload = (await response.json().catch(() => undefined)) as
    | VerifiedIdentityResponse
    | undefined;
  const identity = payload?.identity;
  const email = identity?.email?.trim().toLowerCase();
  if (
    !response.ok ||
    payload?.valid !== true ||
    !identity?.id ||
    !email ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  ) {
    throw new LocalLiclickAccountError(
      'INVALID_LOCAL_IDENTITY_PROOF',
      401,
      '飞书身份证明无效或已过期，请重试。',
    );
  }
  const now = new Date().toISOString();
  return {
    id: identity.id,
    displayName: identity.displayName?.trim() || email,
    email,
    role: 'user',
    status: 'active',
    authSource: identity.authSource === 'dev-mock' ? 'dev-mock' : 'feishu-oauth',
    createdAt: now,
    updatedAt: now,
  };
}
