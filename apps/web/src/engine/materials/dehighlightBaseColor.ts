const MAX_DIMENSION = 2048;

export type DehighlightBaseColorOptions = {
  strength: number;
  threshold?: number;
  radius?: number;
  preserve?: number;
  maxDimension?: number;
};

type FloatChannels = {
  red: Float32Array;
  green: Float32Array;
  blue: Float32Array;
  luminance: Float32Array;
};

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
const toByte = (value: number) => Math.round(clamp01(value) * 255);

function clampIndex(value: number, length: number) {
  return Math.min(length - 1, Math.max(0, value));
}

function smoothstep(edge0: number, edge1: number, value: number) {
  if (edge0 === edge1) return value < edge0 ? 0 : 1;
  const t = clamp01((value - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

function boxBlur(source: Float32Array, width: number, height: number, radius: number) {
  if (radius <= 0) return source;

  const temporary = new Float32Array(source.length);
  const output = new Float32Array(source.length);
  const diameter = radius * 2 + 1;

  for (let y = 0; y < height; y += 1) {
    let sum = 0;
    for (let x = -radius; x <= radius; x += 1) {
      sum += source[y * width + clampIndex(x, width)];
    }

    for (let x = 0; x < width; x += 1) {
      temporary[y * width + x] = sum / diameter;
      const removeX = clampIndex(x - radius, width);
      const addX = clampIndex(x + radius + 1, width);
      sum += source[y * width + addX] - source[y * width + removeX];
    }
  }

  for (let x = 0; x < width; x += 1) {
    let sum = 0;
    for (let y = -radius; y <= radius; y += 1) {
      sum += temporary[clampIndex(y, height) * width + x];
    }

    for (let y = 0; y < height; y += 1) {
      output[y * width + x] = sum / diameter;
      const removeY = clampIndex(y - radius, height);
      const addY = clampIndex(y + radius + 1, height);
      sum += temporary[addY * width + x] - temporary[removeY * width + x];
    }
  }

  return output;
}

function splitChannels(imageData: ImageData): FloatChannels {
  const { data, width, height } = imageData;
  const pixelCount = width * height;
  const red = new Float32Array(pixelCount);
  const green = new Float32Array(pixelCount);
  const blue = new Float32Array(pixelCount);
  const luminance = new Float32Array(pixelCount);

  for (let index = 0, pixel = 0; index < data.length; index += 4, pixel += 1) {
    const r = data[index] / 255;
    const g = data[index + 1] / 255;
    const b = data[index + 2] / 255;
    red[pixel] = r;
    green[pixel] = g;
    blue[pixel] = b;
    luminance[pixel] = r * 0.2126 + g * 0.7152 + b * 0.0722;
  }

  return { red, green, blue, luminance };
}

export function dehighlightBaseColorImageData(
  imageData: ImageData,
  options: DehighlightBaseColorOptions,
) {
  const strength = clamp01(Number(options.strength));
  if (strength <= 0) return new ImageData(new Uint8ClampedArray(imageData.data), imageData.width);

  const threshold = clamp01(Number(options.threshold ?? 0.63));
  const radius = Math.max(0, Math.round(Number(options.radius ?? 6)));
  const preserve = clamp01(Number(options.preserve ?? 0.86));
  const source = splitChannels(imageData);
  const blurred: FloatChannels =
    radius <= 0
      ? source
      : {
          red: boxBlur(source.red, imageData.width, imageData.height, radius),
          green: boxBlur(source.green, imageData.width, imageData.height, radius),
          blue: boxBlur(source.blue, imageData.width, imageData.height, radius),
          luminance: boxBlur(source.luminance, imageData.width, imageData.height, radius),
        };
  const output = new Uint8ClampedArray(imageData.data.length);
  const lowEdge = Math.max(0, threshold - 0.24);
  const highEdge = Math.min(1, threshold + 0.06);
  const compressionCeiling = Math.max(0.08, threshold - 0.22 * strength);

  for (let pixel = 0; pixel < source.red.length; pixel += 1) {
    const r = source.red[pixel];
    const g = source.green[pixel];
    const b = source.blue[pixel];
    const luminance = source.luminance[pixel];
    const maximum = Math.max(r, g, b);
    const minimum = Math.min(r, g, b);
    const saturation = maximum <= 0 ? 0 : (maximum - minimum) / maximum;
    const whiteness = 1 - saturation;
    const brightMask = smoothstep(lowEdge, highEdge, luminance);
    const whiteMask = smoothstep(0.08, 0.55, whiteness);
    const mask = clamp01(brightMask * (0.35 + whiteMask * 0.65) * strength);
    const localLift = Math.max(0, luminance - blurred.luminance[pixel]);
    const localTarget = luminance - localLift * mask * 1.35;
    const globalTarget =
      luminance > compressionCeiling
        ? luminance -
          (luminance - compressionCeiling) * Math.min(0.95, mask * (0.9 + strength * 0.45))
        : luminance;
    const targetLuminance = Math.min(luminance, localTarget, globalTarget);
    const luminanceScale = luminance > 0.0001 ? targetLuminance / luminance : 1;
    const repairMix = radius > 0 ? mask * (1 - preserve) * 0.8 : 0;
    const offset = pixel * 4;

    output[offset] = toByte(
      clamp01(r * luminanceScale) * (1 - repairMix) + blurred.red[pixel] * repairMix,
    );
    output[offset + 1] = toByte(
      clamp01(g * luminanceScale) * (1 - repairMix) + blurred.green[pixel] * repairMix,
    );
    output[offset + 2] = toByte(
      clamp01(b * luminanceScale) * (1 - repairMix) + blurred.blue[pixel] * repairMix,
    );
    output[offset + 3] = imageData.data[offset + 3];
  }

  return new ImageData(output, imageData.width, imageData.height);
}

async function decodeImage(file: File) {
  if ('createImageBitmap' in window) {
    return createImageBitmap(file, { imageOrientation: 'from-image' });
  }

  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    return image;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function canvasToPngBlob(canvas: HTMLCanvasElement) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('去高光贴图编码失败。'))),
      'image/png',
    );
  });
}

function outputName(fileName: string) {
  const stem = fileName.replace(/\.[^/.]+$/, '') || 'BaseColor';
  return `${stem}_去高光.png`;
}

export async function dehighlightBaseColorFile(file: File, options: DehighlightBaseColorOptions) {
  if (options.strength <= 0) return file;

  const image = await decodeImage(file);
  const maximumDimension = Math.max(1, options.maxDimension ?? MAX_DIMENSION);
  const scale = Math.min(1, maximumDimension / Math.max(image.width, image.height));
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('浏览器无法创建 Base Color 处理画布。');

  context.drawImage(image, 0, 0, width, height);
  if ('close' in image) image.close();
  const source = context.getImageData(0, 0, width, height);
  const processed = dehighlightBaseColorImageData(source, options);
  context.putImageData(processed, 0, 0);
  const blob = await canvasToPngBlob(canvas);
  return new File([blob], outputName(file.name), { type: 'image/png' });
}
