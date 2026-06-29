export type ImageSample = [number, number, number, number];
const COLOR_ALPHA_REJECT_THRESHOLD = 3;

export async function loadImageData(url: string, maxDimension = Number.POSITIVE_INFINITY): Promise<ImageData> {
  const image = new Image();
  image.crossOrigin = 'anonymous';
  image.decoding = 'async';
  image.src = url;

  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error('Could not load projected layer image for baking.'));
  });

  const sourceWidth = image.naturalWidth || image.width;
  const sourceHeight = image.naturalHeight || image.height;
  const scale = Math.min(1, maxDimension / Math.max(sourceWidth, sourceHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(sourceWidth * scale));
  canvas.height = Math.max(1, Math.round(sourceHeight * scale));
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('Could not create image sampling canvas.');
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return context.getImageData(0, 0, canvas.width, canvas.height);
}

export function sampleImageNearest(image: ImageData, u: number, v: number): ImageSample {
  const clampedU = Math.min(1, Math.max(0, u));
  const clampedV = Math.min(1, Math.max(0, v));
  const x = Math.min(image.width - 1, Math.max(0, Math.round(clampedU * (image.width - 1))));
  const y = Math.min(image.height - 1, Math.max(0, Math.round(clampedV * (image.height - 1))));
  const offset = (y * image.width + x) * 4;
  return [
    image.data[offset],
    image.data[offset + 1],
    image.data[offset + 2],
    image.data[offset + 3],
  ];
}

function getPixel(image: ImageData, x: number, y: number): ImageSample {
  const offset = (y * image.width + x) * 4;
  return [
    image.data[offset],
    image.data[offset + 1],
    image.data[offset + 2],
    image.data[offset + 3],
  ];
}

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
  const pixels = [
    { pixel: getPixel(image, x0, y0), weight: (1 - tx) * (1 - ty) },
    { pixel: getPixel(image, x1, y0), weight: tx * (1 - ty) },
    { pixel: getPixel(image, x0, y1), weight: (1 - tx) * ty },
    { pixel: getPixel(image, x1, y1), weight: tx * ty },
  ];

  let red = 0;
  let green = 0;
  let blue = 0;
  let alpha = 0;

  for (const { pixel, weight } of pixels) {
    const pixelAlpha = (pixel[3] / 255) * weight;
    red += pixel[0] * pixelAlpha;
    green += pixel[1] * pixelAlpha;
    blue += pixel[2] * pixelAlpha;
    alpha += pixelAlpha;
  }

  if (alpha <= 0.00001) return [0, 0, 0, 0];

  return [
    Math.round(red / alpha),
    Math.round(green / alpha),
    Math.round(blue / alpha),
    Math.round(alpha * 255),
  ];
}

export function sampleImageBilinearCleanColor(image: ImageData, u: number, v: number): ImageSample {
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
  const pixels = [
    { pixel: getPixel(image, x0, y0), weight: (1 - tx) * (1 - ty) },
    { pixel: getPixel(image, x1, y0), weight: tx * (1 - ty) },
    { pixel: getPixel(image, x0, y1), weight: (1 - tx) * ty },
    { pixel: getPixel(image, x1, y1), weight: tx * ty },
  ];

  let red = 0;
  let green = 0;
  let blue = 0;
  let totalWeight = 0;
  let maxAlpha = 0;

  for (const { pixel, weight } of pixels) {
    if (weight <= 0 || pixel[3] < COLOR_ALPHA_REJECT_THRESHOLD) continue;
    red += pixel[0] * weight;
    green += pixel[1] * weight;
    blue += pixel[2] * weight;
    totalWeight += weight;
    maxAlpha = Math.max(maxAlpha, pixel[3]);
  }

  if (totalWeight <= 0.00001) return [0, 0, 0, 0];
  return [
    Math.round(red / totalWeight),
    Math.round(green / totalWeight),
    Math.round(blue / totalWeight),
    maxAlpha,
  ];
}
