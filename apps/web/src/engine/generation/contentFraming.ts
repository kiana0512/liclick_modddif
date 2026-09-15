import { validateGenerationFraming, type GenerationFraming } from '@liclick/contracts';

/** Full geometry coverage: mask white channel or geometry-normal alpha, not material RGB. */
export function findContentFraming(
  image: Pick<ImageData, 'width' | 'height' | 'data'>,
  normal = false,
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
  let cw = w + border * 2,
    ch = h + border * 2;
  cw = Math.max(cw, Math.ceil(ch / 3));
  ch = Math.max(ch, Math.ceil(cw / 3));
  return validateGenerationFraming({
    version: 1,
    sourceWidth: width,
    sourceHeight: height,
    left: Math.floor((x0 + x1 + 1 - cw) / 2),
    top: Math.floor((y0 + y1 + 1 - ch) / 2),
    width: cw,
    height: ch,
  });
}

/** Retain the provider's detail; restore only transparent canvas padding, never shrink to the old screenshot. */
export function restoredFrameLayout(frame: GenerationFraming, width: number, height: number) {
  validateGenerationFraming(frame);
  // GPT-CONTENT-FRAMING/1.0.1: recognise a nearest-16 output rectangle,
  // rather than broadening the arbitrary aspect-ratio tolerance.
  const nativeScale = Math.sqrt(width * height / (frame.width * frame.height));
  const gridRounded = width % 16 === 0 && height % 16 === 0 &&
    Math.abs(width - frame.width * nativeScale) <= 8 &&
    Math.abs(height - frame.height * nativeScale) <= 8;
  const ratioMismatch = Math.abs(width / height / (frame.width / frame.height) - 1) >
    Math.max(0.005, 2 / Math.min(width, height));
  if (
    !(width > 0 && height > 0) ||
    (ratioMismatch && !gridRounded)
  )
    throw new Error('远端返回图片比例与提交比例不一致，已停止回贴，未拉伸图片。');
  const scale = Math.max(width / frame.width, height / frame.height);
  const fullWidth = Math.ceil(frame.sourceWidth * scale),
    fullHeight = Math.ceil(frame.sourceHeight * scale);
  if (fullWidth > 16384 || fullHeight > 16384 || fullWidth * fullHeight > 64 * 1024 * 1024)
    throw new Error('模型在原视口中过小，回贴画布超出安全范围；请放大模型后重新生成。');
  if (ratioMismatch) {
    // Preserve the entire native output with integer translation and padding.
    // No stretch, crop, resolution reduction or change to the author's mask.
    return {
      width: fullWidth, height: fullHeight,
      left: Math.round(frame.left * scale + (frame.width * scale - width) / 2),
      top: Math.round(frame.top * scale + (frame.height * scale - height) / 2),
      patchWidth: width, patchHeight: height,
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
