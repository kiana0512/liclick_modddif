import sharp from 'sharp';
import { atlasReferenceDataUrlBudget, losslessReferenceDataUrl } from './pixelExactReferenceUpload.js';

// GPT-COLOR-REFERENCE-UPLOAD/1.1.0. Only the explicitly identified GPT repaint
// or texture-map combined colour guide may change RGB. Dimensions and alpha stay exact;
// normals, author masks, original captures and output textures are untouched.
export async function prepareRepaintColorUploadArguments(dataUrl: string) {
  const lossless = await losslessReferenceDataUrl(dataUrl);
  if (lossless.length <= atlasReferenceDataUrlBudget) return { file_path: lossless };
  const source = Buffer.from(lossless.slice(lossless.indexOf(',') + 1), 'base64');
  const decode = (buffer: Buffer) => sharp(buffer, { limitInputPixels: 64 * 1024 * 1024, failOn: 'error' });
  const before = await decode(source).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  if (before.info.width > 16383 || before.info.height > 16383) {
    throw new Error('结合参考图尺寸超过 WebP 编码限制，未提交生成任务；图片未缩小。');
  }
  const encode = async (quality: number) => {
    const bytes = await decode(source).keepIccProfile().webp({ quality, alphaQuality: 100, effort: 4 }).toBuffer();
    return `data:image/webp;base64,${bytes.toString('base64')}`;
  };
  let best = await encode(95);
  if (best.length > atlasReferenceDataUrlBudget) {
    // At most seven encodes. Every accepted candidate is checked against the
    // Base64 envelope budget; a noisy alpha plane can still be incompressible.
    best = await encode(1);
    if (best.length > atlasReferenceDataUrlBudget) {
      throw new Error('结合参考图保持原尺寸和透明度压缩后仍超过 4MB 上传限制，未提交生成任务。');
    }
    let low = 1, high = 95;
    for (let probe = 0; probe < 5 && high - low > 1; probe++) {
      const quality = Math.floor((low + high) / 2);
      const candidate = await encode(quality);
      if (candidate.length <= atlasReferenceDataUrlBudget) { low = quality; best = candidate; }
      else high = quality;
    }
  }
  const after = await decode(Buffer.from(best.slice(best.indexOf(',') + 1), 'base64'))
    .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  if (after.info.width !== before.info.width || after.info.height !== before.info.height ||
    after.info.channels !== before.info.channels) {
    throw new Error('结合参考图压缩尺寸校验失败，未提交生成任务。');
  }
  for (let offset = 3; offset < before.data.length; offset += 4) {
    if (before.data[offset] !== after.data[offset]) {
      throw new Error('结合参考图压缩透明度校验失败，未提交生成任务。');
    }
  }
  return { file_path: best };
}
