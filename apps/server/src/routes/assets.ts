import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  parseCompleteAssetUploadIntent,
  parseCreateAssetUploadIntent,
} from '@liclick/contracts';
import { requireAuth } from '../auth/authMiddleware.js';
import { serverConfig } from '../config.js';
import { maxLocalAssetBytes, saveBinaryAsset, saveDataUrlAsset, saveRemoteImageAsset } from '../services/assetFileService.js';
import {
  AssetTransferError,
  completeAssetUploadIntent,
  createAssetDownloadUrl,
  createInternalAssetDownload,
  createAssetUploadIntent,
  saveProxiedObjectStorageAsset,
} from '../services/assetTransferService.js';
import type { AssetCategory } from '../types/asset.js';
import { corsHeaders, getPathSegments, readBinaryBody, readJsonBody, sendJson } from './httpUtils.js';

function sendAssetTransferError(response: ServerResponse, error: unknown) {
  if (!(error instanceof AssetTransferError)) return false;
  sendJson(response, error.statusCode, { error: error.message, code: error.code });
  return true;
}

export async function handleAssetsRoute(request: IncomingMessage, response: ServerResponse, url: URL) {
  const segments = getPathSegments(url);
  const projectId = segments[2];
  if (segments[1] !== 'projects' || !projectId || segments[3] !== 'assets') {
    return false;
  }
  const user = await requireAuth(request, response);
  if (!user) return true;

  if (request.method === 'POST' && segments.length === 5 && segments[4] === 'intents') {
    let input;
    try {
      input = parseCreateAssetUploadIntent(await readJsonBody<unknown>(request));
    } catch (error) {
      sendJson(response, 400, {
        error: error instanceof Error ? error.message : 'Invalid asset upload intent.',
        code: 'INVALID_ASSET_UPLOAD_INTENT',
      });
      return true;
    }
    try {
      const intent = await createAssetUploadIntent(user.id, projectId, input);
      if (!intent) sendJson(response, 404, { error: 'Project not found.' });
      else sendJson(response, 201, { intent });
    } catch (error) {
      if (!sendAssetTransferError(response, error)) throw error;
    }
    return true;
  }

  if (
    request.method === 'POST' &&
    segments.length === 7 &&
    segments[4] === 'intents' &&
    segments[6] === 'complete'
  ) {
    let input;
    try {
      input = parseCompleteAssetUploadIntent(await readJsonBody<unknown>(request));
    } catch (error) {
      sendJson(response, 400, {
        error: error instanceof Error ? error.message : 'Invalid asset upload completion.',
        code: 'INVALID_ASSET_UPLOAD_COMPLETION',
      });
      return true;
    }
    try {
      const result = await completeAssetUploadIntent(
        user.id,
        projectId,
        segments[5],
        input,
      );
      sendJson(response, 200, result);
    } catch (error) {
      if (!sendAssetTransferError(response, error)) throw error;
    }
    return true;
  }

  if (request.method === 'GET' && segments.length === 6 && segments[5] === 'content') {
    try {
      if (url.searchParams.get('proxy') === '1') {
        const asset = await createInternalAssetDownload(user.id, projectId, segments[4]);
        if (!asset) {
          sendJson(response, 404, { error: 'Asset not found.' });
          return true;
        }
        const controller = new AbortController();
        const onClose = () => controller.abort();
        response.once('close', onClose);
        try {
          const upstream = await fetch(asset.url, {
            headers: { 'accept-encoding': 'identity' },
            redirect: 'error',
            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(90_000)]),
          });
          if (upstream.status !== 200 || !upstream.body) {
            await upstream.body?.cancel();
            sendJson(response, 502, { code: 'ASSET_STORAGE_READ_FAILED', error: 'Object storage could not read the verified asset.' });
            return true;
          }
          if (upstream.headers.get('content-length') !== String(asset.sizeBytes)
            || upstream.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== asset.mimeType.toLowerCase()
            || ![null, 'identity'].includes(upstream.headers.get('content-encoding'))) {
            await upstream.body.cancel();
            sendJson(response, 502, { code: 'ASSET_METADATA_MISMATCH', error: 'Object storage asset metadata changed.' });
            return true;
          }
          response.writeHead(200, {
            ...corsHeaders(response),
            'content-type': asset.mimeType,
            'content-length': String(asset.sizeBytes),
            'cache-control': 'private, no-store',
            'x-content-type-options': 'nosniff',
          });
          await pipeline(Readable.from(upstream.body as unknown as AsyncIterable<Uint8Array>), response);
        } finally {
          response.off('close', onClose);
          controller.abort();
        }
        return true;
      }
      const downloadUrl = await createAssetDownloadUrl(user.id, projectId, segments[4]);
      if (!downloadUrl) {
        sendJson(response, 404, { error: 'Asset not found.' });
      } else if (url.searchParams.get('resolve') === '1') {
        response.setHeader('cache-control', 'private, no-store');
        sendJson(response, 200, { downloadUrl });
      } else {
        response.writeHead(307, {
          ...corsHeaders(response),
          location: downloadUrl,
          'cache-control': 'private, no-store',
          'x-content-type-options': 'nosniff',
        });
        response.end();
      }
    } catch (error) {
      if (!sendAssetTransferError(response, error)) throw error;
    }
    return true;
  }

  if (request.method !== 'POST' || segments.length !== 4) return false;

  if (url.searchParams.get('format') === 'blob') {
    const category = url.searchParams.get('category') as AssetCategory | null;
    const filename = url.searchParams.get('filename');
    if (!category || !filename) {
      sendJson(response, 400, { error: 'Asset category and filename are required.' });
      return true;
    }
    const mime = request.headers['content-type']?.split(';')[0]?.trim().toLowerCase() || 'application/octet-stream';
    let buffer: Buffer;
    try {
      buffer = await readBinaryBody(request, maxLocalAssetBytes);
    } catch (error) {
      sendJson(response, 413, { error: error instanceof Error ? error.message : 'Asset is too large.' });
      return true;
    }
    const asset = serverConfig.objectStorage.enabled
      ? await saveProxiedObjectStorageAsset({
          userId: user.id,
          projectId,
          category,
          mimeType: mime,
          buffer,
          filename,
        })
      : await saveBinaryAsset({
          userId: user.id,
          projectId,
          category,
          mime,
          buffer,
          filename,
        });
    if (!asset) sendJson(response, 404, { error: 'Project not found.' });
    else sendJson(response, 201, { asset });
    return true;
  }

  const body = await readJsonBody<{
    category: AssetCategory;
    dataUrl?: string;
    url?: string;
    filename: string;
  }>(request);
  if (!body.dataUrl && !body.url) {
    sendJson(response, 400, { error: 'Asset dataUrl or url is required.' });
    return true;
  }
  const asset = body.url
    ? await saveRemoteImageAsset({
        userId: user.id,
        projectId,
        category: body.category,
        url: body.url,
        filename: body.filename,
      })
    : await saveDataUrlAsset({
        userId: user.id,
        projectId,
        category: body.category,
        dataUrl: body.dataUrl ?? '',
        filename: body.filename,
      });
  if (!asset) sendJson(response, 404, { error: 'Project not found.' });
  else sendJson(response, 201, { asset });
  return true;
}
