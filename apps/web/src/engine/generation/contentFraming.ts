import {
  generationOutputSize,
  validateGenerationFraming,
  type GenerationFraming,
} from '@liclick/contracts';

/** Full geometry coverage: mask white channel or geometry-normal alpha, not material RGB. */
export function findContentFraming(
  image: Pick<ImageData, 'width' | 'height' | 'data'>,
  normal = false,
  imageSize = '2K',
): GenerationFraming {
  const { width, height, data } = image;
  let x0 = width,
    y0 = height,
    x1 = -1,
    y1 = -1;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (data[i + 3] > 0 && (normal || data[i] > 0)) {
        x0 = Math.min(x0, x);
        y0 = Math.min(y0, y);
        x1 = Math.max(x1, x);
        y1 = Math.max(y1, y);
      }
    }
  if (x1 < x0) throw new Error('未找到模型轮廓，未提交生成任务。');
  const w = x1 - x0 + 1,
    h = y1 - y0 + 1;
  const border = Math.max(2, Math.ceil(Math.max(w, h) * 0.03));
  const content = {
    left: x0 - border,
    top: y0 - border,
    width: w + border * 2,
    height: h + border * 2,
  };
  // UI-like ratio controls (at most 100), NOT image pixel dimensions.
  const ratio = Math.max(1 / 3, Math.min(3, content.width / content.height));
  let rw = ratio >= 1 ? 100 : Math.round(100 * ratio);
  let rh = ratio >= 1 ? Math.round(100 / ratio) : 100;
  if (rw > rh * 3) {
    rw = 3;
    rh = 1;
  }
  if (rh > rw * 3) {
    rw = 1;
    rh = 3;
  }
  const output = generationOutputSize(rw, rh, imageSize);
  let a = output.width,
    b = output.height;
  while (b) [a, b] = [b, a % b];
  const pw = output.width / a,
    ph = output.height / a;
  const k = Math.ceil(Math.max(content.width / pw, content.height / ph));
  const cw = pw * k,
    ch = ph * k;
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
    ratioWidth: rw,
    ratioHeight: rh,
    outputWidth: output.width,
    outputHeight: output.height,
  });
}

/** Retain the provider's detail; restore only transparent canvas padding, never shrink to the old screenshot. */
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
    (frame.version === 2
      ? width !== frame.outputWidth || height !== frame.outputHeight
      : ratioMismatch && !gridRounded)
  )
    throw new Error(
      `远端回图比例异常（提交 ${frame.width}×${frame.height} → 返回 ${width}×${height}），已保留结果并停止回贴。`,
    );
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

/** Conservative silhouette check only: no claim to detect internal deformation. */
export async function validateFramedSilhouette(
  frame: GenerationFraming,
  image: Pick<ImageData, 'width' | 'height' | 'data'>,
  checkpoint?: () => Promise<void>,
) {
  if (frame.version !== 2) return;
  const layout = restoredFrameLayout(frame, image.width, image.height),
    s = frame.subject!;
  let left = image.width,
    top = image.height,
    right = -1,
    bottom = -1;
  const rows = Math.max(1, Math.floor(262144 / image.width));
  for (let y = 0; y < image.height; y++) {
    if (y % rows === 0) await checkpoint?.();
    for (let x = 0; x < image.width; x++) {
      if (image.data[(y * image.width + x) * 4 + 3] < 128) continue;
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x);
      bottom = Math.max(bottom, y);
    }
  }
  const sx = layout.width / frame.sourceWidth,
    sy = layout.height / frame.sourceHeight;
  const expected = [
    s.left * sx - layout.left,
    s.top * sy - layout.top,
    (s.left + s.width) * sx - layout.left,
    (s.top + s.height) * sy - layout.top,
  ];
  const actual = [left, top, right + 1, bottom + 1];
  const tolerance = Math.max(16, Math.max(s.width * sx, s.height * sy) * 0.02);
  if (right < left || actual.some((v, i) => Math.abs(v - expected[i]) > tolerance))
    throw new Error('远端回图透明轮廓与模型不对齐，已保留结果并停止回贴，未自动重新生成。');
}
