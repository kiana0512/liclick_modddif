import { PassThrough } from 'node:stream';
import { parsePreparedRetopologySubmission } from '../apps/server/dist/services/retopologyPreparedSubmissionUploadService.js';
import { retopologyWireFileNames } from '../apps/web/src/services/retopologyWireNames.ts';

function multipartRequest(parts) {
  const boundary = `li3d-filename-smoke-${Date.now()}`;
  const chunks = [];
  for (const part of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`));
    if (part.filename) {
      chunks.push(Buffer.from(
        `Content-Disposition: form-data; name="${part.name}"; filename="${part.filename}"\r\n` +
        `Content-Type: ${part.contentType ?? 'application/octet-stream'}\r\n\r\n`,
        'utf8',
      ));
      chunks.push(Buffer.from(part.value));
    } else {
      chunks.push(Buffer.from(
        `Content-Disposition: form-data; name="${part.name}"\r\n\r\n${part.value}`,
        'utf8',
      ));
    }
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  const body = Buffer.concat(chunks);
  const request = new PassThrough();
  request.headers = {
    'content-type': `multipart/form-data; boundary=${boundary}`,
    'content-length': String(body.byteLength),
  };
  return { request, body };
}

async function parse(parts) {
  const { request, body } = multipartRequest(parts);
  const result = parsePreparedRetopologySubmission(request);
  request.end(body);
  return result;
}

const metadata = {
  external_asset_id: 'li3d-smoke-retopology',
  options: { target_faces: 500 },
  reference_views: [],
  user_request: '保留中文名称',
};

const unicodeUpload = await parse([
  { name: 'high_model', filename: '测试模型合集_scene (11).fbx', value: 'model' },
  { name: 'metadata', value: JSON.stringify(metadata) },
]);
try {
  if (unicodeUpload.sourceName !== '测试模型合集_scene (11).fbx') {
    throw new Error(`UTF-8 model filename was corrupted: ${unicodeUpload.sourceName}`);
  }
} finally {
  await unicodeUpload.cleanup();
}

const wireNames = retopologyWireFileNames({
  externalAssetId: 'li3d-sha256-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  highModelName: '中文高模.fbx',
  referenceImageNames: ['正面参考图.png', '侧面参考图 02.JPG'],
});
for (const filename of [wireNames.highModel, ...wireNames.referenceImages]) {
  if (!/^[a-z0-9._-]+$/i.test(filename)) {
    throw new Error(`Wire filename is not ASCII-safe: ${filename}`);
  }
}
if (!wireNames.highModel.endsWith('.fbx')) throw new Error('Model extension was not preserved.');
if (!wireNames.referenceImages[0]?.endsWith('.png')) throw new Error('PNG extension was not preserved.');
if (!wireNames.referenceImages[1]?.endsWith('.jpg')) throw new Error('JPG extension was not normalized.');

const wireMetadata = {
  ...metadata,
  reference_views: wireNames.referenceImages.map((filename, index) => ({
    filename,
    view: index === 0 ? 'front' : 'side',
  })),
};
const wireUpload = await parse([
  { name: 'high_model', filename: wireNames.highModel, value: 'model' },
  ...wireNames.referenceImages.map((filename) => ({
    name: 'reference_images',
    filename,
    contentType: 'image/png',
    value: 'image',
  })),
  { name: 'metadata', value: JSON.stringify(wireMetadata) },
]);
try {
  const normalized = JSON.parse(wireUpload.metadata);
  const normalizedNames = normalized.reference_views.map((entry) => entry.filename);
  if (JSON.stringify(normalizedNames) !== JSON.stringify(wireNames.referenceImages)) {
    throw new Error('reference_views no longer matches the uploaded ASCII wire filenames.');
  }
  if (wireUpload.referenceImages.some((image) => !/^[a-z0-9._-]+$/i.test(image.filename))) {
    throw new Error('Parsed reference filename is not ASCII-safe.');
  }
} finally {
  await wireUpload.cleanup();
}

const encodedHistoryName = encodeURIComponent('中文模型😀.fbx');
if (decodeURIComponent(encodedHistoryName) !== '中文模型😀.fbx') {
  throw new Error('History source name did not survive URL encoding.');
}

process.stdout.write('Retopology filename smoke passed: UTF-8 history and ASCII wire names are stable.\n');
