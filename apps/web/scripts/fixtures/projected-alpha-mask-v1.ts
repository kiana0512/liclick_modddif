export function applyProjectedAlphaMask(
  image: ImageData,
  mask: ImageData,
  options: { ignoreSourceAlpha?: boolean } = {},
) {
  const output = new ImageData(new Uint8ClampedArray(image.data), image.width, image.height);
  for (let y = 0; y < image.height; y += 1) {
    const v = image.height <= 1 ? 0 : y / (image.height - 1);
    for (let x = 0; x < image.width; x += 1) {
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
        : output.data[sourceOffset + 3];
      const nextAlpha = Math.round(sourceAlpha * maskCoverage);
      output.data[sourceOffset + 3] = nextAlpha;
      if (nextAlpha <= 0 && !options.ignoreSourceAlpha) {
        output.data[sourceOffset] = 0;
        output.data[sourceOffset + 1] = 0;
        output.data[sourceOffset + 2] = 0;
      }
    }
  }
  return output;
}
