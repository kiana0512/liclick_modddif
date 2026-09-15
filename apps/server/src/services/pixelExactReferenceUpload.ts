import sharp from 'sharp';
import { serverConfig } from '../config.js';
import { createAssetDownloadUrl, saveProxiedObjectStorageAsset } from './assetTransferService.js';

// PIXEL-EXACT-REFERENCE-UPLOAD/1.0.0. The browser-to-control-plane body is
// separate from Atlas's 4 MiB JSON-RPC envelope. Never resize geometry guides.
export const atlasReferenceDataUrlBudget = 4 * 1024 * 1024 - 512 * 1024;
const maxImageBytes = 16 * 1024 * 1024;
const maxImagePixels = 64 * 1024 * 1024;

export async function losslessReferenceDataUrl(dataUrl: string) {
  if (dataUrl.length <= atlasReferenceDataUrlBudget) return dataUrl;
  const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!match || match[1].length > Math.ceil(maxImageBytes / 3) * 4) {
    throw new Error('结构引导图必须为不超过 16 MiB 的原尺寸 PNG；未提交生成任务。');
  }
  const original = Buffer.from(match[1], 'base64');
  if (original.length > maxImageBytes) throw new Error('结构引导图超过 16 MiB；未提交生成任务。');
  const decode = (buffer: Buffer) => sharp(buffer, { limitInputPixels: maxImagePixels, failOn: 'error' });
  const metadata = await decode(original).metadata();
  if (metadata.format !== 'png' || metadata.depth !== 'uchar') {
    throw new Error('结构引导图必须为 8 位 PNG；未提交生成任务。');
  }
  // Embedded colour profiles must keep their original encoded bytes.
  if (metadata.icc) return dataUrl;
  const compressed = await decode(original).png({ compressionLevel: 9, adaptiveFiltering: true, palette: false }).toBuffer();
  if (compressed.length >= original.length) return dataUrl;
  const before = await decode(original).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const after = await decode(compressed).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  if (before.info.width !== after.info.width || before.info.height !== after.info.height ||
      before.info.channels !== after.info.channels || !before.data.equals(after.data)) {
    throw new Error('结构引导图无损验证失败；未提交生成任务。');
  }
  return `data:image/png;base64,${compressed.toString('base64')}`;
}

export async function preparePixelExactUploadArguments(dataUrl: string, context: { userId?: string; projectId?: string }) {
  const lossless = await losslessReferenceDataUrl(dataUrl);
  if (lossless.length <= atlasReferenceDataUrlBudget) return { file_path: lossless };
  if (!serverConfig.objectStorage.enabled || !context.userId || !context.projectId) {
    throw new Error('结构引导图经原尺寸无损编码后仍超过 Atlas 上传限制；当前服务未配置大图对象存储上传。未提交生成任务，图片未缩小或有损压缩。');
  }
  // Use the existing ownership/checksum/verified-transfer protocol. Atlas
  // downloads the exact file instead of embedding its Base64 in JSON-RPC.
  const asset = await saveProxiedObjectStorageAsset({
    userId: context.userId, projectId: context.projectId, category: 'captures',
    filename: 'pixel-exact-guide.png', mimeType: 'image/png',
    buffer: Buffer.from(lossless.slice(lossless.indexOf(',') + 1), 'base64'),
  });
  const assetId = asset?.relativePath.match(/^objects\/([^/]+)$/)?.[1];
  const url = assetId && await createAssetDownloadUrl(context.userId, context.projectId, assetId);
  if (!url) throw new Error('结构引导图对象资产未验证或工程不可访问；未提交生成任务。');
  return { url };
}
