type DehighlightOptions = {
  strength: number;
  threshold: number;
  radius: number;
  preserve: number;
};

const MAX_PROCESSING_DIMENSION = 4096;

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

function dehighlightOptions(strengthPercent: number): DehighlightOptions {
  const strength = clamp01(strengthPercent / 100);
  return {
    strength,
    threshold: 0.82 - strength * 0.28,
    radius: 2 + strength * 6,
    preserve: 0.98 - strength * 0.18,
  };
}

function smoothstep(edge0: number, edge1: number, value: number) {
  if (edge0 === edge1) return value < edge0 ? 0 : 1;
  const amount = clamp01((value - edge0) / (edge1 - edge0));
  return amount * amount * (3 - 2 * amount);
}

function canvasToBlob(canvas: HTMLCanvasElement) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('无法生成去高光后的颜色贴图。'));
    }, 'image/png');
  });
}

function outputFileName(fileName: string) {
  const stem = fileName.replace(/\.[^/.]+$/, '') || 'BaseColor';
  return `${stem}_dehighlight.png`;
}

/**
 * Removes bright, low-saturation specular highlights from a Base Color image.
 * The source File is never modified. Large inputs are capped at 4K so the
 * preprocessing step stays responsive in the desktop Chromium runtime.
 */
export async function dehighlightBaseColorFile(
  file: File,
  strengthPercent: number,
  maxProcessingDimension = MAX_PROCESSING_DIMENSION,
) {
  let image: ImageBitmap;
  try {
    image = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw new Error('去高光无法读取该颜色贴图，请使用 PNG、JPG 或 WEBP 图片。');
  }

  try {
    const scale = Math.min(
      1,
      maxProcessingDimension / Math.max(image.width, image.height),
    );
    const width = Math.max(1, Math.round(image.width * scale));
    const height = Math.max(1, Math.round(image.height * scale));
    const sourceCanvas = document.createElement('canvas');
    const blurredCanvas = document.createElement('canvas');
    sourceCanvas.width = width;
    sourceCanvas.height = height;
    blurredCanvas.width = width;
    blurredCanvas.height = height;

    const sourceContext = sourceCanvas.getContext('2d', { willReadFrequently: true });
    const blurredContext = blurredCanvas.getContext('2d', { willReadFrequently: true });
    if (!sourceContext || !blurredContext) {
      throw new Error('当前环境不支持颜色贴图去高光。');
    }

    sourceContext.drawImage(image, 0, 0, width, height);
    const options = dehighlightOptions(strengthPercent);
    blurredContext.filter = `blur(${options.radius}px)`;
    blurredContext.drawImage(image, 0, 0, width, height);
    blurredContext.filter = 'none';

    const sourceImage = sourceContext.getImageData(0, 0, width, height);
    const blurredImage = blurredContext.getImageData(0, 0, width, height);
    const source = sourceImage.data;
    const blurred = blurredImage.data;
    const lowEdge = Math.max(0, options.threshold - 0.24);
    const highEdge = Math.min(1, options.threshold + 0.06);
    const compressionCeiling = Math.max(
      0.08,
      options.threshold - 0.22 * options.strength,
    );

    for (let index = 0; index < source.length; index += 4) {
      const red = source[index] / 255;
      const green = source[index + 1] / 255;
      const blue = source[index + 2] / 255;
      const luminance = red * 0.2126 + green * 0.7152 + blue * 0.0722;
      const maximum = Math.max(red, green, blue);
      const minimum = Math.min(red, green, blue);
      const saturation = maximum <= 0 ? 0 : (maximum - minimum) / maximum;
      const whiteness = 1 - saturation;
      const brightMask = smoothstep(lowEdge, highEdge, luminance);
      const whiteMask = smoothstep(0.08, 0.55, whiteness);
      const mask = clamp01(
        brightMask * (0.35 + whiteMask * 0.65) * options.strength,
      );
      const blurredRed = blurred[index] / 255;
      const blurredGreen = blurred[index + 1] / 255;
      const blurredBlue = blurred[index + 2] / 255;
      const localLuminance =
        blurredRed * 0.2126 + blurredGreen * 0.7152 + blurredBlue * 0.0722;
      const localLift = Math.max(0, luminance - localLuminance);
      const localTarget = luminance - localLift * mask * 1.35;
      const globalTarget =
        luminance > compressionCeiling
          ? luminance -
            (luminance - compressionCeiling) *
              Math.min(0.95, mask * (0.9 + options.strength * 0.45))
          : luminance;
      const targetLuminance = Math.min(luminance, localTarget, globalTarget);
      const luminanceScale = luminance > 0.0001 ? targetLuminance / luminance : 1;
      const repairMix = options.radius > 0 ? mask * (1 - options.preserve) * 0.8 : 0;

      source[index] = Math.round(
        clamp01(red * luminanceScale * (1 - repairMix) + blurredRed * repairMix) * 255,
      );
      source[index + 1] = Math.round(
        clamp01(
          green * luminanceScale * (1 - repairMix) + blurredGreen * repairMix,
        ) * 255,
      );
      source[index + 2] = Math.round(
        clamp01(blue * luminanceScale * (1 - repairMix) + blurredBlue * repairMix) * 255,
      );
    }

    sourceContext.putImageData(sourceImage, 0, 0);
    const output = await canvasToBlob(sourceCanvas);
    return new File([output], outputFileName(file.name), {
      type: 'image/png',
      lastModified: Date.now(),
    });
  } finally {
    image.close();
  }
}
