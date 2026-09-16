/** GPT-CONTENT-FRAMING/2: coordinates in the original capture, never the edit mask. */
type FramingRect = { left: number; top: number; width: number; height: number };
export function generationOutputSize(w: number, h: number, size: string) {
  const edge = ({ '1K': 1024, '2K': 2048, '4K': 4096 } as Record<string, number>)[size];
  if (!edge || !Number.isFinite(w / h) || w <= 0 || h <= 0)
    throw new Error('生成补边需要有效比例和明确的分辨率档位。');
  return {
    width: Math.round((edge * Math.sqrt(w / h)) / 16) * 16,
    height: Math.round((edge * Math.sqrt(h / w)) / 16) * 16,
  };
}
export type GenerationFraming = {
  version: 1 | 2;
  sourceWidth: number;
  sourceHeight: number;
  left: number;
  top: number;
  width: number;
  height: number;
  cropBounds?: FramingRect;
  subject?: FramingRect;
  ratioWidth?: number;
  ratioHeight?: number;
  outputWidth?: number;
  outputHeight?: number;
};

export function validateGenerationFraming(value: GenerationFraming) {
  if (
    !value ||
    ![1, 2].includes(value.version) ||
    ![
      value.sourceWidth,
      value.sourceHeight,
      value.left,
      value.top,
      value.width,
      value.height,
    ].every(Number.isSafeInteger) ||
    value.sourceWidth < 1 ||
    value.sourceHeight < 1 ||
    value.sourceWidth > 8192 ||
    value.sourceHeight > 8192 ||
    value.width < 1 ||
    value.height < 1 ||
    value.width > 24576 ||
    value.height > 24576 ||
    Math.max(value.width / value.height, value.height / value.width) > 3 ||
    value.left >= value.sourceWidth ||
    value.top >= value.sourceHeight ||
    value.left + value.width <= 0 ||
    value.top + value.height <= 0 ||
    Math.abs(value.left) > 24576 ||
    Math.abs(value.top) > 24576
  )
    throw new Error('无效的生成裁切范围。');
  if (value.version === 2) {
    for (const rect of [value.cropBounds, value.subject]) {
      if (
        !rect ||
        ![rect.left, rect.top, rect.width, rect.height].every(Number.isSafeInteger) ||
        rect.width < 1 ||
        rect.height < 1 ||
        rect.left < value.left ||
        rect.top < value.top ||
        rect.left + rect.width > value.left + value.width ||
        rect.top + rect.height > value.top + value.height
      )
        throw new Error('无效的生成补边范围。');
    }
    const c = value.cropBounds!,
      s = value.subject!;
    if (
      s.left < c.left ||
      s.top < c.top ||
      s.left + s.width > c.left + c.width ||
      s.top + s.height > c.top + c.height ||
      s.left < 0 ||
      s.top < 0 ||
      s.left + s.width > value.sourceWidth ||
      s.top + s.height > value.sourceHeight ||
      value.width * value.height > 64 * 1024 * 1024 ||
      ![value.ratioWidth, value.ratioHeight, value.outputWidth, value.outputHeight].every(
        (n) => Number.isSafeInteger(n) && n! > 0,
      ) ||
      Math.max(value.ratioWidth!, value.ratioHeight!) > 100 ||
      Math.max(value.ratioWidth! / value.ratioHeight!, value.ratioHeight! / value.ratioWidth!) >
        3 ||
      value.outputWidth! > 8192 ||
      value.outputHeight! > 8192 ||
      value.outputWidth! % 16 !== 0 ||
      value.outputHeight! % 16 !== 0 ||
      value.width * value.outputHeight! !== value.height * value.outputWidth!
    )
      throw new Error('无效的生成补边比例。');
  }
  return value;
}

export function generationFramingRatio(frame: GenerationFraming) {
  validateGenerationFraming(frame);
  const width = frame.version === 2 ? frame.ratioWidth! : frame.width;
  const height = frame.version === 2 ? frame.ratioHeight! : frame.height;
  let a = width,
    b = height;
  while (b) [a, b] = [b, a % b];
  return { width: width / a, height: height / a };
}
