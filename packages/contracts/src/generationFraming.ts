/** GPT-CONTENT-FRAMING/1: coordinates in the original capture, never the edit mask. */
export type GenerationFraming = {
  version: 1;
  sourceWidth: number;
  sourceHeight: number;
  left: number;
  top: number;
  width: number;
  height: number;
};

export function validateGenerationFraming(value: GenerationFraming) {
  if (
    !value ||
    value.version !== 1 ||
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
  return value;
}

export function generationFramingRatio(frame: GenerationFraming) {
  validateGenerationFraming(frame);
  let a = frame.width,
    b = frame.height;
  while (b) [a, b] = [b, a % b];
  return { width: frame.width / a, height: frame.height / a };
}
