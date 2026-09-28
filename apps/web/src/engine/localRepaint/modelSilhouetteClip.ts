import { blobToDataUrl, imageDataToBlob, urlToImageData } from './imageUtils';
import { yieldToBrowserTask } from '@/utils/browserScheduling';

/** ALG-LR-013 v1.2.0: 3px@2K frozen model coverage, never provider RGB or authored mask. */
export const MODEL_SILHOUETTE_CLIP_VERSION = 2;

/** ComfyUI's submitted red-channel mask is also the return-image blend weight. */
export function compositeRepaintWithSubmittedMask(
  generated: ImageData,
  original: ImageData,
  submittedMask: ImageData,
) {
  const { width, height } = generated;
  if (
    original.width !== width || original.height !== height ||
    submittedMask.width !== width || submittedMask.height !== height
  ) throw new Error('局部重绘图像尺寸不一致。');
  const output = new ImageData(new Uint8ClampedArray(original.data), width, height);
  const result = output.data;
  const source = original.data;
  const repaint = generated.data;
  const mask = submittedMask.data;
  for (let index = 0; index < width * height; index++) {
    const offset = index * 4;
    const weight = (mask[offset] / 255) * (mask[offset + 3] / 255);
    if (weight <= 0) continue;
    for (let channel = 0; channel < 4; channel++) {
      const pixel = offset + channel;
      result[pixel] = Math.round(source[pixel] + (repaint[pixel] - source[pixel]) * weight);
    }
  }
  return output;
}

export function clipRepaintToModelSilhouette(source: ImageData, depth: ImageData) {
  const { width, height } = source;
  if (width !== depth.width || height !== depth.height)
    throw new Error('返图与原模型轮廓尺寸不一致，无法安全裁切。');
  const radius = Math.max(1, Math.round((3 * Math.max(width, height)) / 2048));
  const coverage = new Uint8Array(width * height);
  let covered = 0;
  for (let i = 0; i < coverage.length; i++) {
    const p = i * 4;
    coverage[i] = depth.data[p] < 254 || depth.data[p + 1] < 254 || depth.data[p + 2] < 254 ? 1 : 0;
    covered += coverage[i];
  }
  if (!covered) throw new Error('原模型轮廓为空，已停止回贴。');
  const offsets: [number, number][] = [];
  for (let y = -radius; y <= radius; y++)
    for (let x = -radius; x <= radius; x++)
      if (x * x + y * y <= radius * radius) offsets.push([x, y]);
  const output = new ImageData(new Uint8ClampedArray(source.data), width, height);
  // Erode all foreground components: outer edges retreat, enclosed holes grow.
  // Keep RGB and the original canvas coordinates; only geometry controls alpha.
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      let keep = coverage[y * width + x];
      if (keep)
        for (const [dx, dy] of offsets) {
          const sx = x + dx,
            sy = y + dy;
          if (sx < 0 || sy < 0 || sx >= width || sy >= height || !coverage[sy * width + sx]) {
            keep = 0;
            break;
          }
        }
      output.data[(y * width + x) * 4 + 3] = keep ? 255 : 0;
    }
  return output;
}

export async function prepareModelClippedRepaint(
  sourceUrl: string,
  depthUrl: string | undefined,
  signal: AbortSignal | undefined,
  originalUrl: string,
  submittedMaskUrl: string,
) {
  if (!depthUrl) throw new Error('缺少生成视角的原模型轮廓，已停止回贴，请重试。');
  const options = { cooperative: true, signal };
  const source = await urlToImageData(sourceUrl, undefined, undefined, options);
  const depth = await urlToImageData(depthUrl, undefined, undefined, options);
  const original = await urlToImageData(originalUrl, undefined, undefined, options);
  const submittedMask = await urlToImageData(submittedMaskUrl, undefined, undefined, options);
  signal?.throwIfAborted();
  const clipped = clipRepaintToModelSilhouette(
    compositeRepaintWithSubmittedMask(source, original, submittedMask), depth,
  );
  await yieldToBrowserTask();
  signal?.throwIfAborted();
  const result = await blobToDataUrl(await imageDataToBlob(clipped));
  signal?.throwIfAborted();
  return result;
}
