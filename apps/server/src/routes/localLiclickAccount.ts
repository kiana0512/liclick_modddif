import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  getLocalLiclickAccountBindingProgress,
  getLocalLiclickAccountStatus,
  LocalLiclickAccountError,
  startLocalLiclickAccountBinding,
  unbindLocalLiclickAccount,
} from '../services/localLiclickAccountService.js';
import { verifyLocalIdentityProof } from '../services/localIdentityProofService.js';
import { getPathSegments, sendJson } from './httpUtils.js';

function sendRouteError(response: ServerResponse, error: unknown) {
  if (error instanceof LocalLiclickAccountError) {
    sendJson(response, error.statusCode, { code: error.code, error: error.message });
    return;
  }
  console.error('[LIclick Local Account]', error);
  sendJson(response, 500, {
    code: 'LOCAL_LICLICK_ACCOUNT_ERROR',
    error: error instanceof Error ? error.message : '个人莉刻账号操作失败。',
  });
}

export async function handleLocalLiclickAccountRoute(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
) {
  const segments = getPathSegments(url);
  if (segments[0] !== 'api' || segments[1] !== 'local-liclick-account') return false;

  try {
    const identity = await verifyLocalIdentityProof(request);
    const verifiedEmail = identity.email;
    if (request.method === 'GET' && segments[2] === 'status' && segments.length === 3) {
      sendJson(response, 200, getLocalLiclickAccountStatus());
      return true;
    }
    if (
      request.method === 'POST' &&
      segments[2] === 'bind' &&
      segments[3] === 'start' &&
      segments.length === 4
    ) {
      sendJson(response, 200, await startLocalLiclickAccountBinding(verifiedEmail));
      return true;
    }
    if (
      request.method === 'GET' &&
      segments[2] === 'bind' &&
      segments[3] === 'poll' &&
      segments[4] &&
      segments.length === 5
    ) {
      sendJson(response, 200, getLocalLiclickAccountBindingProgress(segments[4], verifiedEmail));
      return true;
    }
    if (request.method === 'POST' && segments[2] === 'unbind' && segments.length === 3) {
      sendJson(response, 200, await unbindLocalLiclickAccount(verifiedEmail));
      return true;
    }
    sendJson(response, 404, { error: 'Local Liclick account route not found.' });
    return true;
  } catch (error) {
    sendRouteError(response, error);
    return true;
  }
}
