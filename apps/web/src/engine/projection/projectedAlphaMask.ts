import { sampleImageBilinear } from '../bake/bilinearImageSampling';

export function applyProjectedAlphaMask(
  image: ImageData,
  mask: ImageData,
  options: { ignoreSourceAlpha?: boolean } = {},
) {
  // Pixels outside the nonzero mask's bilinear footprint are provably zero.
  // Sparse repaint masks need not sample four neighbours across the whole image.
  let left = mask.width, right = -1, top = mask.height, bottom = -1;
  for (let y = 0; y < mask.height; y++) for (let x = 0; x < mask.width; x++) {
    const i = (y * mask.width + x) * 4;
    if (mask.data[i + 3] && (mask.data[i] || mask.data[i + 1] || mask.data[i + 2])) {
      left = Math.min(left, x); right = Math.max(right, x);
      top = Math.min(top, y); bottom = Math.max(bottom, y);
    }
  }
  const output = new ImageData(options.ignoreSourceAlpha ? new Uint8ClampedArray(image.data)
    : new Uint8ClampedArray(image.data.length), image.width, image.height);
  if (options.ignoreSourceAlpha) for (let i = 3; i < output.data.length; i += 4) output.data[i] = 0;
  if (right < left) return output;
  const minX = mask.width <= 1 ? 0 : Math.max(0, Math.floor((left - 1) / (mask.width - 1) * (image.width - 1)) - 1);
  const maxX = mask.width <= 1 ? image.width - 1 : Math.min(image.width - 1, Math.ceil((right + 1) / (mask.width - 1) * (image.width - 1)) + 1);
  const minY = mask.height <= 1 ? 0 : Math.max(0, Math.floor((top - 1) / (mask.height - 1) * (image.height - 1)) - 1);
  const maxY = mask.height <= 1 ? image.height - 1 : Math.min(image.height - 1, Math.ceil((bottom + 1) / (mask.height - 1) * (image.height - 1)) + 1);
  for (let y = minY; y <= maxY; y += 1) {
    const v = image.height <= 1 ? 0 : y / (image.height - 1);
    for (let x = minX; x <= maxX; x += 1) {
      const u = image.width <= 1 ? 0 : x / (image.width - 1);
      const sourceOffset = (y * image.width + x) * 4;
      const maskSample = sampleImageBilinear(mask, u, v);
      const maskLuminance = maskSample[0] * 0.299 + maskSample[1] * 0.587 + maskSample[2] * 0.114;
      const maskCoverage = (maskLuminance / 255) * (maskSample[3] / 255);
      // Local repaint and other explicitly mask-authored projections use the
      // camera/brush mask as their only coverage authority. Generated-image
      // alpha may have already been damaged by an earlier dark-background
      // heuristic, so it must not be allowed to punch new holes in the model.
      const sourceAlpha = options.ignoreSourceAlpha
        ? 255
        : image.data[sourceOffset + 3];
      const nextAlpha = Math.round(sourceAlpha * maskCoverage);
      output.data[sourceOffset + 3] = nextAlpha;
      if (nextAlpha > 0 && !options.ignoreSourceAlpha) {
        output.data[sourceOffset] = image.data[sourceOffset];
        output.data[sourceOffset + 1] = image.data[sourceOffset + 1];
        output.data[sourceOffset + 2] = image.data[sourceOffset + 2];
      }
    }
  }
  return output;
}

