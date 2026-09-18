import {
  generationOutputSize,
  validateGenerationFraming,
  type GenerationFraming,
} from '@liclick/contracts';

type CoverageImage = Pick<ImageData, 'width' | 'height' | 'data'>;

/** GPT-CONTENT-BOUNDS/1.0.0. Bounds depend only on each row's first/last
 * covered pixel. Interior holes/colours never change the exact outer bounds.
 * Yield every 16 rows, including empty rows, for cancellable cooperative scans.
 */
function* contentBounds({ width, height, data }: CoverageImage, normal: boolean, alpha: number) {
  let left = width, top = height, right = -1, bottom = -1;
  for (let y = 0; y < height; y++) {
    const row = y * width * 4;
    let first = 0, last = width - 1;
    for (; first < width; first++) {
      const i = row + first * 4;
      if (data[i + 3] >= alpha && (normal || data[i] > 0)) break;
    }
    if (first < width) {
      for (; last > first; last--) {
        const i = row + last * 4;
        if (data[i + 3] >= alpha && (normal || data[i] > 0)) break;
      }
      left = Math.min(left, first); right = Math.max(right, last);
      top = Math.min(top, y); bottom = y;
    }
    if (y % 16 === 15) yield;
  }
  return [left, top, right, bottom] as const;
}

export async function cooperativeBounds(image: CoverageImage, normal: boolean, alpha: number, checkpoint?: () => Promise<void>) {
  await checkpoint?.();
  const scan = contentBounds(image, normal, alpha);
  let step = scan.next(), started = performance.now();
  while (!step.done) {
    if (checkpoint && performance.now() - started >= 4) {
      await checkpoint(); started = performance.now();
    }
    step = scan.next();
  }
  return step.value;
}

/** Full geometry coverage: mask white channel or geometry-normal alpha, not material RGB. */
export function findContentFraming(
  image: Pick<ImageData, 'width' | 'height' | 'data'>,
  normal = false,
  imageSize = '2K',
): GenerationFraming {
  const scan = contentBounds(image, normal, 1);
  let step = scan.next();
  while (!step.done) step = scan.next();
  return frameFromBounds(image, step.value, imageSize);
}

export async function findContentFramingCooperatively(image: CoverageImage, normal: boolean, imageSize: string, checkpoint: () => Promise<void>) {
  return frameFromBounds(image, await cooperativeBounds(image, normal, 1, checkpoint), imageSize);
}

function frameFromBounds({ width, height }: CoverageImage, [x0, y0, x1, y1]: readonly number[], imageSize: string) {
  if (x1 < x0) throw new Error('未找到模型轮廓，未提交生成任务。');
  const w = x1 - x0 + 1,
    h = y1 - y0 + 1;
  const border = Math.max(2, Math.ceil(Math.max(w, h) * 0.01));
  const content = {
    left: x0 - border,
    top: y0 - border,
    width: w + border * 2,
    height: h + border * 2,
  };
  // Square crop and generation; preserve source pixels without resampling.
  const output = generationOutputSize(1, 1, imageSize);
  const cw = Math.max(content.width, content.height), ch = cw;
  return validateGenerationFraming({
    version: 2,
    sourceWidth: width,
    sourceHeight: height,
    left: Math.floor((x0 + x1 + 1 - cw) / 2),
    top: Math.floor((y0 + y1 + 1 - ch) / 2),
    width: cw,
    height: ch,
    cropBounds: content,
    subject: { left: x0, top: y0, width: w, height: h },
    ratioWidth: 1,
    ratioHeight: 1,
    outputWidth: output.width,
    outputHeight: output.height,
  });
}

/** Retain the provider's detail; restore only transparent canvas padding, never shrink to the old screenshot. */
// GPT-CONTENT-FRAMING/2.2.1: validate geometry ratio, not provider-native pixel dimensions.
export function restoredFrameLayout(frame: GenerationFraming, width: number, height: number) {
  validateGenerationFraming(frame);
  // Both dimensions must admit the SAME scale before independent grid rounding.
  const lower = Math.max((width - 8) / frame.width, (height - 8) / frame.height);
  const upper = Math.min((width + 8) / frame.width, (height + 8) / frame.height);
  const gridRounded = width % 16 === 0 && height % 16 === 0 && lower <= upper;
  const ratioMismatch =
    Math.abs(width / height / (frame.width / frame.height) - 1) >
    Math.max(0.005, 2 / Math.min(width, height));
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    !(width > 0 && height > 0) ||
    (ratioMismatch && !gridRounded)
  ) {
    const mismatch = new Error(
      `远端回图比例异常（提交 ${frame.width}×${frame.height} → 返回 ${width}×${height}），已保留结果并停止回贴。`,
    ) as Error & { code: string };
    mismatch.code = 'GPT_RETURN_FRAME_RATIO_MISMATCH';
    throw mismatch;
  }
  const scale = Math.max(width / frame.width, height / frame.height);
  const fullWidth = Math.ceil(frame.sourceWidth * scale),
    fullHeight = Math.ceil(frame.sourceHeight * scale);
  if (fullWidth > 16384 || fullHeight > 16384 || fullWidth * fullHeight > 64 * 1024 * 1024)
    throw new Error('模型在原视口中过小，回贴画布超出安全范围；请放大模型后重新生成。');
  if (ratioMismatch || frame.version === 2) {
    // Preserve the entire native output with integer translation and padding.
    // No stretch, crop, resolution reduction or change to the author's mask.
    return {
      width: fullWidth,
      height: fullHeight,
      left: Math.round(frame.left * scale + (frame.width * scale - width) / 2),
      top: Math.round(frame.top * scale + (frame.height * scale - height) / 2),
      patchWidth: width,
      patchHeight: height,
    };
  }
  return {
    width: fullWidth,
    height: fullHeight,
    left: (frame.left * fullWidth) / frame.sourceWidth,
    top: (frame.top * fullHeight) / frame.sourceHeight,
    patchWidth: (frame.width * fullWidth) / frame.sourceWidth,
    patchHeight: (frame.height * fullHeight) / frame.sourceHeight,
  };
}
