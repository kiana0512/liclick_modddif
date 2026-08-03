import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleLiclickRoute } from './liclick.js';
import { getPathSegments, sendJson } from './httpUtils.js';
import { getLocalLiclickAccountStatus } from '../services/localLiclickAccountService.js';
import { verifyLocalIdentityProof } from '../services/localIdentityProofService.js';

export async function handleLocalLiclickRoute(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
) {
  const segments = getPathSegments(url);
  const isLiclickRoute = segments[0] === 'api' && segments[1] === 'liclick';
  const isLegacyGenerateRoute = segments[0] === 'api' && segments[1] === 'generate-image';
  if (!isLiclickRoute && !isLegacyGenerateRoute) return false;

  let identity;
  try {
    identity = await verifyLocalIdentityProof(request);
  } catch (error) {
    const statusCode =
      error && typeof error === 'object' && 'statusCode' in error && typeof error.statusCode === 'number'
        ? error.statusCode
        : 401;
    const code =
      error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
        ? error.code
        : 'INVALID_LOCAL_IDENTITY_PROOF';
    sendJson(response, statusCode, {
      code,
      error: error instanceof Error ? error.message : '飞书身份证明校验失败。',
    });
    return true;
  }

  const account = getLocalLiclickAccountStatus();
  if (request.method === 'GET' && isLiclickRoute && segments[2] === 'status') {
    const matchesIdentity =
      account.valid && Boolean(account.email) && account.email!.toLowerCase() === identity.email!.toLowerCase();
    sendJson(response, matchesIdentity ? 200 : account.valid ? 409 : 428, {
      ok: matchesIdentity,
      code: account.valid && !matchesIdentity ? 'LICLICK_ACCOUNT_EMAIL_MISMATCH' : undefined,
      status: {
        valid: matchesIdentity,
        expiresAt: account.expiresAt,
        message: account.message,
      },
      account,
      tools: matchesIdentity ? ['generate_image', 'get_task_status', 'upload_asset'] : [],
      message: matchesIdentity
        ? account.message
        : account.valid
          ? '当前飞书账号与此电脑绑定的个人莉刻账号不一致，请重新绑定本人账号。'
          : account.message,
    });
    return true;
  }

  if (!account.valid) {
    sendJson(response, 428, {
      code: 'LICLICK_ACCOUNT_BINDING_REQUIRED',
      error: '请先在此电脑绑定当前员工自己的莉刻账号，再开始生成。',
      account,
    });
    return true;
  }
  if (!account.email || account.email.toLowerCase() !== identity.email!.toLowerCase()) {
    sendJson(response, 409, {
      code: 'LICLICK_ACCOUNT_EMAIL_MISMATCH',
      error: '当前飞书账号与此电脑绑定的个人莉刻账号不一致，请重新绑定本人账号。',
    });
    return true;
  }

  return handleLiclickRoute(request, response, url, identity);
}
