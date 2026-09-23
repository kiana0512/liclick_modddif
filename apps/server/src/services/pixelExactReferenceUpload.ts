import sharp from 'sharp';
import { serverConfig } from '../config.js';
import { createAssetDownloadUrl, saveProxiedObjectStorageAsset } from './assetTransferService.js';

// PIXEL-EXACT-REFERENCE-UPLOAD/1.1.0. The browser-to-control-plane body is
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
  const before = await decode(original).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const matches = async (candidate: Buffer) => {
    const after = await decode(candidate).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    return before.info.width === after.info.width && before.info.height === after.info.height &&
      before.info.channels === after.info.channels && before.data.equals(after.data);
  };
  let best = dataUrl;
  if (compressed.length < original.length) {
    if (!await matches(compressed)) throw new Error('结构引导图无损验证失败；未提交生成任务。');
    best = `data:image/png;base64,${compressed.toString('base64')}`;
  }
  if (best.length <= atlasReferenceDataUrlBudget) return best;
  // Lossless WebP often encodes textured guides better than DEFLATE. Some
  // encoders discard RGB behind zero alpha: reject those candidates too.
  if (metadata.width! <= 16383 && metadata.height! <= 16383) {
    const webp = await decode(original).webp({ lossless: true, effort: 6 }).toBuffer();
    const candidate = `data:image/webp;base64,${webp.toString('base64')}`;
    if (candidate.length < best.length && await matches(webp)) best = candidate;
  }
  return best;
}

export async function preparePixelExactUploadArguments(dataUrl: string, context: { userId?: string; projectId?: string }) {
  const lossless = await losslessReferenceDataUrl(dataUrl);
  if (lossless.length <= atlasReferenceDataUrlBudget) return { file_path: lossless };
  return prepareOwnedReferenceUpload(lossless, context);
}

async function prepareOwnedReferenceUpload(lossless: string, context: { userId?: string; projectId?: string }) {
  if (!serverConfig.objectStorage.enabled || !context.userId || !context.projectId) {
    throw new Error('结构引导图经原尺寸无损编码后仍超过 Atlas 上传限制；当前服务未配置大图对象存储上传。未提交生成任务，图片未缩小或有损压缩。');
  }
  // Use the existing ownership/checksum/verified-transfer protocol. Atlas
  // downloads the exact file instead of embedding its Base64 in JSON-RPC.
  const mimeType = lossless.slice(5, lossless.indexOf(';'));
  const extension = mimeType === 'image/jpeg' ? 'jpg' : mimeType === 'image/webp' ? 'webp' : 'png';
  const asset = await saveProxiedObjectStorageAsset({
    userId: context.userId, projectId: context.projectId, category: 'captures',
    filename: `pixel-exact-guide.${extension}`,
    mimeType,
    buffer: Buffer.from(lossless.slice(lossless.indexOf(',') + 1), 'base64'),
  });
  const assetId = asset?.relativePath.match(/^objects\/([^/]+)$/)?.[1];
  const url = assetId && await createAssetDownloadUrl(context.userId, context.projectId, assetId);
  if (!url) throw new Error('结构引导图对象资产未验证或工程不可访问；未提交生成任务。');
  return { url };
}

// MATERIAL-REFERENCE-UPLOAD/1.0.0. Only identified material references
// may use this adaptive transport copy. Never use for geometry,
// normals, masks, captures or saved/exported textures. Keep original assets.
export async function prepareMaterialReferenceUploadArguments(dataUrl: string, context: { userId?: string; projectId?: string }) {
  const lossless = dataUrl.startsWith('data:image/png;') ? await losslessReferenceDataUrl(dataUrl) : dataUrl;
  // The caller also checks the complete JSON-RPC envelope against 4,000,000.
  // Reserve 64 KiB for framing without confusing file bytes with Base64 bytes.
  const budget = 4_000_000 - 64 * 1024;
  if (lossless.length <= budget) return { file_path: lossless };
  if (!/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(dataUrl) ||
      dataUrl.length > Math.ceil(maxImageBytes / 3) * 4 + 32) throw new Error('参考图格式无效或超过 16 MiB 安全上限。');
  const source = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
  const decode = (buffer: Buffer) => sharp(buffer, { limitInputPixels: maxImagePixels, failOn: 'error' });
  const metadata = await decode(source).metadata();
  if (source.length > maxImageBytes || metadata.depth !== 'uchar' || (metadata.pages ?? 1) > 1) throw new Error('参考图必须为 16 MiB 内的单帧 8 位图片。');
  if (serverConfig.objectStorage.enabled) return prepareOwnedReferenceUpload(lossless, context);
  const before = await decode(source).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const acceptable = async (bytes: Buffer, bounded: boolean) => {
    const after = await decode(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    if (before.info.width !== after.info.width || before.info.height !== after.info.height ||
        before.data.length !== after.data.length) return false;
    const candidateMetadata = await decode(bytes).metadata();
    if (metadata.icc && !candidateMetadata.icc?.equals(metadata.icc)) return false;
    let squaredError = 0;
    for (let i = 0; i < before.data.length; i++) {
      const delta = Math.abs(before.data[i]! - after.data[i]!);
      if (i % 4 === 3 ? delta !== 0 : bounded && delta > 2) return false;
      squaredError += delta * delta;
    }
    return !bounded || squaredError / (before.info.width * before.info.height * 3) <= 255 ** 2 / 10 ** 4.5;
  };
  const dataUrlFor = (bytes: Buffer) => `data:image/webp;base64,${bytes.toString('base64')}`;
  if (before.info.width <= 16383 && before.info.height <= 16383) {
    // WebP near-lossless retains full chroma resolution. These three levels
    // try exact, then at most 1/2 RGB steps; the decoded bytes are authoritative.
    for (const quality of [100, 80, 60]) {
      const bytes = await decode(source).keepIccProfile().webp({ nearLossless: true, quality, effort: 6 }).toBuffer();
      const candidate = dataUrlFor(bytes);
      if (candidate.length > budget) continue;
      // RGB PSNR >= 45 dB, exact alpha and max error <= 2/255 per channel.
      if (await acceptable(bytes, true)) return { file_path: candidate };
    }
    // The adaptive WebP preprocessor deliberately leaves noisy edges alone.
    // A one-step RGB rounding copy can remove their redundant low bit without
    // subsampling chroma, blurring or changing alpha. Colour-profiled images
    // stay on the profile-preserving encoder below.
    if (!metadata.icc) {
      const pixels = Buffer.from(before.data);
      for (let i = 0; i < pixels.length; i++) {
        if (i % 4 !== 3) pixels[i] = Math.min(255, Math.round(pixels[i]! / 2) * 2);
      }
      const bytes = await sharp(pixels, { raw: before.info }).webp({ lossless: true, quality: 100, effort: 6 }).toBuffer();
      if (dataUrlFor(bytes).length <= budget && await acceptable(bytes, true)) return { file_path: dataUrlFor(bytes) };
    }
    // Hard provider limit: only after all high-fidelity attempts, select the
    // highest fitting WebP quality at unchanged dimensions and exact alpha.
    const encode = (quality: number) => decode(source).keepIccProfile()
      .webp({ quality, alphaQuality: 100, smartSubsample: true, effort: 6 }).toBuffer();
    let best = await encode(100);
    if (dataUrlFor(best).length > budget) {
      best = await encode(1);
      if (dataUrlFor(best).length <= budget) {
        let low = 1, high = 100;
        while (high - low > 1) {
          const quality = Math.floor((low + high) / 2), bytes = await encode(quality);
          if (dataUrlFor(bytes).length <= budget) { low = quality; best = bytes; } else high = quality;
        }
      }
    }
    if (dataUrlFor(best).length <= budget && await acceptable(best, false)) return { file_path: dataUrlFor(best) };
  }
  throw new Error('参考图透明通道或尺寸无法在莉刻上传限制内保留；原图已保留，未提交生成任务。');
}
