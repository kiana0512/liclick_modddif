import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readBinaryBody, sendJson } from './httpUtils.js';
import {
  createNormalBakeJob,
  getNormalBakeJob,
  getNormalBakeOutputPath,
  getSubstanceBakerStatus,
  type BakeUpload,
  type BakeChannelId,
  type NormalBakeSettings,
} from '../services/substanceBakeService.js';

type MultipartData = { fields: Record<string, string>; files: Record<string, BakeUpload> };

function parseMultipart(contentType: string, body: Buffer): MultipartData {
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType)?.slice(1).find(Boolean)?.trim();
  if (!boundary) throw new Error('Missing multipart boundary.');
  const delimiter = Buffer.from(`--${boundary}`);
  const fields: Record<string, string> = {};
  const files: Record<string, BakeUpload> = {};
  let cursor = body.indexOf(delimiter);
  while (cursor >= 0) {
    let partStart = cursor + delimiter.length;
    if (body.subarray(partStart, partStart + 2).equals(Buffer.from('--'))) break;
    if (body.subarray(partStart, partStart + 2).equals(Buffer.from('\r\n'))) partStart += 2;
    const next = body.indexOf(delimiter, partStart);
    if (next < 0) break;
    let partEnd = next;
    if (body.subarray(partEnd - 2, partEnd).equals(Buffer.from('\r\n'))) partEnd -= 2;
    const headerEnd = body.indexOf(Buffer.from('\r\n\r\n'), partStart);
    if (headerEnd > partStart && headerEnd < partEnd) {
      const headers = body.subarray(partStart, headerEnd).toString('utf8');
      const name = /name="([^"]+)"/i.exec(headers)?.[1];
      const fileName = /filename="([^"]*)"/i.exec(headers)?.[1];
      const data = body.subarray(headerEnd + 4, partEnd);
      if (name && fileName !== undefined) files[name] = { fileName, data: Buffer.from(data) };
      else if (name) fields[name] = data.toString('utf8');
    }
    cursor = next;
  }
  return { fields, files };
}

export async function handleBakeRoute(request: IncomingMessage, response: ServerResponse, url: URL) {
  if (url.pathname === '/api/bake/status' && request.method === 'GET') {
    sendJson(response, 200, getSubstanceBakerStatus());
    return true;
  }
  if (url.pathname === '/api/bake/jobs' && request.method === 'POST') {
    const contentType = request.headers['content-type'] ?? '';
    if (!contentType.startsWith('multipart/form-data')) {
      sendJson(response, 415, { error: 'Expected multipart/form-data.' });
      return true;
    }
    const multipart = parseMultipart(contentType, await readBinaryBody(request, 256 * 1024 * 1024));
    if (!multipart.files.high || !multipart.files.low) {
      sendJson(response, 400, { error: 'High and low model files are required.' });
      return true;
    }
    const job = createNormalBakeJob({
      projectId: multipart.fields.projectId ?? '',
      objectId: multipart.fields.objectId ?? '',
      settings: JSON.parse(multipart.fields.settings ?? '{}') as NormalBakeSettings,
      high: multipart.files.high,
      low: multipart.files.low,
      cage: multipart.files.cage,
      color: multipart.files.color,
    });
    sendJson(response, 202, { job });
    return true;
  }
  const match = /^\/api\/bake\/jobs\/([^/]+)(?:\/output\/(baseColor|ambientOcclusion|normal))?$/.exec(url.pathname);
  if (!match || request.method !== 'GET') return false;
  const jobId = decodeURIComponent(match[1]);
  const outputChannel = match[2] as BakeChannelId | undefined;
  if (outputChannel) {
    const outputPath = getNormalBakeOutputPath(jobId, outputChannel);
    if (!outputPath || !fs.existsSync(outputPath)) {
      sendJson(response, 404, { error: `${outputChannel} output is not available.` });
      return true;
    }
    response.writeHead(200, {
      'content-type': 'image/png',
      'cache-control': 'no-store',
      ...(url.searchParams.get('download') === '1'
        ? { 'content-disposition': `attachment; filename="${path.basename(outputPath)}"` }
        : {}),
    });
    fs.createReadStream(outputPath).pipe(response);
    return true;
  }
  const job = getNormalBakeJob(jobId);
  if (!job) {
    sendJson(response, 404, { error: 'Bake job not found.' });
    return true;
  }
  sendJson(response, 200, { job });
  return true;
}
