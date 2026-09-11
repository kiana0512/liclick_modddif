/** Pure byte sampling shared by viewport, CPU bake and workers. */
type ImageSample = [number, number, number, number];

export function sampleImageBilinear(image: ImageData, u: number, v: number): ImageSample {
  const clampedU = Math.min(1, Math.max(0, u));
  const clampedV = Math.min(1, Math.max(0, v));
  const sourceX = clampedU * (image.width - 1);
  const sourceY = clampedV * (image.height - 1);
  const x0 = Math.max(0, Math.min(image.width - 1, Math.floor(sourceX)));
  const y0 = Math.max(0, Math.min(image.height - 1, Math.floor(sourceY)));
  const x1 = Math.max(0, Math.min(image.width - 1, x0 + 1));
  const y1 = Math.max(0, Math.min(image.height - 1, y0 + 1));
  const tx = sourceX - x0;
  const ty = sourceY - y0;
  const data = image.data;
  const offset00 = (y0 * image.width + x0) * 4;
  const offset10 = (y0 * image.width + x1) * 4;
  const offset01 = (y1 * image.width + x0) * 4;
  const offset11 = (y1 * image.width + x1) * 4;
  const weight00 = (1 - tx) * (1 - ty);
  const weight10 = tx * (1 - ty);
  const weight01 = (1 - tx) * ty;
  const weight11 = tx * ty;
  const alpha00 = (data[offset00 + 3] / 255) * weight00;
  const alpha10 = (data[offset10 + 3] / 255) * weight10;
  const alpha01 = (data[offset01 + 3] / 255) * weight01;
  const alpha11 = (data[offset11 + 3] / 255) * weight11;
  let red = 0;
  let green = 0;
  let blue = 0;
  const alpha = alpha00 + alpha10 + alpha01 + alpha11;

  if (alpha <= 0.00001) return [0, 0, 0, 0];

  red +=
    data[offset00] * alpha00 +
    data[offset10] * alpha10 +
    data[offset01] * alpha01 +
    data[offset11] * alpha11;
  green +=
    data[offset00 + 1] * alpha00 +
    data[offset10 + 1] * alpha10 +
    data[offset01 + 1] * alpha01 +
    data[offset11 + 1] * alpha11;
  blue +=
    data[offset00 + 2] * alpha00 +
    data[offset10 + 2] * alpha10 +
    data[offset01 + 2] * alpha01 +
    data[offset11 + 2] * alpha11;

  return [
    Math.round(red / alpha),
    Math.round(green / alpha),
    Math.round(blue / alpha),
    Math.round(alpha * 255),
  ];
}

