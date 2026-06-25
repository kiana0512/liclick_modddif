import { loadImageData } from '@/engine/bake/imageSampler';
import { createRegisteredObjectUrl } from '@/utils/blobUrlRegistry';

type LabColor = [number, number, number];
type RgbColor = [number, number, number];
type HsvColor = [number, number, number];
type CutoutOptions = {
  borderFrac: number;
  closePx: number;
  openPx: number;
  featherPx: number;
  bleedPx: number;
  minAreaFrac: number;
};

const defaultOptions: CutoutOptions = {
  borderFrac: 0.03,
  closePx: 3,
  openPx: 1,
  featherPx: 1.5,
  bleedPx: 18,
  minAreaFrac: 0.00002,
};
const maxCutoutDimension = 4096;

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function percentile(values: number[], amount: number) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = clamp(Math.floor((sorted.length - 1) * amount), 0, sorted.length - 1);
  return sorted[index];
}

function rgbToLab(red: number, green: number, blue: number): LabColor {
  function pivotRgb(value: number) {
    const normalized = value / 255;
    return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  }

  function pivotXyz(value: number) {
    return value > 0.008856 ? Math.cbrt(value) : 7.787 * value + 16 / 116;
  }

  const r = pivotRgb(red);
  const g = pivotRgb(green);
  const b = pivotRgb(blue);
  const x = (r * 0.4124564 + g * 0.3575761 + b * 0.1804375) / 0.95047;
  const y = (r * 0.2126729 + g * 0.7151522 + b * 0.072175) / 1;
  const z = (r * 0.0193339 + g * 0.119192 + b * 0.9503041) / 1.08883;
  const fx = pivotXyz(x);
  const fy = pivotXyz(y);
  const fz = pivotXyz(z);
  return [(116 * fy - 16) * 2.55, 500 * (fx - fy) + 128, 200 * (fy - fz) + 128];
}

function labToRgb(lab: LabColor): RgbColor {
  const l = lab[0] / 2.55;
  const a = lab[1] - 128;
  const b = lab[2] - 128;
  const fy = (l + 16) / 116;
  const fx = a / 500 + fy;
  const fz = fy - b / 200;

  function pivot(value: number) {
    const cubed = value ** 3;
    return cubed > 0.008856 ? cubed : (value - 16 / 116) / 7.787;
  }

  const x = 0.95047 * pivot(fx);
  const y = pivot(fy);
  const z = 1.08883 * pivot(fz);
  const linearRed = x * 3.2404542 + y * -1.5371385 + z * -0.4985314;
  const linearGreen = x * -0.969266 + y * 1.8760108 + z * 0.041556;
  const linearBlue = x * 0.0556434 + y * -0.2040259 + z * 1.0572252;

  function encode(value: number) {
    const clamped = clamp(value, 0, 1);
    return Math.round((clamped <= 0.0031308 ? 12.92 * clamped : 1.055 * clamped ** (1 / 2.4) - 0.055) * 255);
  }

  return [encode(linearRed), encode(linearGreen), encode(linearBlue)];
}

function rgbToHsv(red: number, green: number, blue: number): HsvColor {
  const r = red / 255;
  const g = green / 255;
  const b = blue / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  const saturation = max === 0 ? 0 : delta / max;
  return [0, saturation * 255, max * 255];
}

function labDistance(a: LabColor, b: LabColor) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function getPixelOffset(width: number, x: number, y: number) {
  return (y * width + x) * 4;
}

function getBorderCoordinates(width: number, height: number, borderWidth: number) {
  const coordinates: Array<[number, number]> = [];
  for (let y = 0; y < height; y += 1) {
    const inTop = y < borderWidth;
    const inBottom = y >= height - borderWidth;
    for (let x = 0; x < width; x += 1) {
      if (inTop || inBottom || x < borderWidth || x >= width - borderWidth) coordinates.push([x, y]);
    }
  }
  return coordinates;
}

function getSampledCoordinates(coordinates: Array<[number, number]>, maxSamples = 60000) {
  if (coordinates.length <= maxSamples) return coordinates;
  const stride = Math.ceil(coordinates.length / maxSamples);
  return coordinates.filter((_, index) => index % stride === 0);
}

function getLabAt(image: ImageData, x: number, y: number): LabColor {
  const offset = getPixelOffset(image.width, x, y);
  return rgbToLab(image.data[offset], image.data[offset + 1], image.data[offset + 2]);
}

function getRgbAt(image: ImageData, x: number, y: number): RgbColor {
  const offset = getPixelOffset(image.width, x, y);
  return [image.data[offset], image.data[offset + 1], image.data[offset + 2]];
}

function medianLab(samples: LabColor[]): LabColor {
  return [0, 1, 2].map((channel) => percentile(samples.map((sample) => sample[channel]), 0.5)) as LabColor;
}

function estimateBackground(image: ImageData, options: CutoutOptions) {
  const borderWidth = Math.max(4, Math.round(Math.min(image.width, image.height) * options.borderFrac));
  const borderCoordinates = getSampledCoordinates(getBorderCoordinates(image.width, image.height, borderWidth));
  const labs = borderCoordinates.map(([x, y]) => getLabAt(image, x, y));
  const sortedLabs = [...labs].sort((a, b) => a[0] - b[0]);
  let centers = [
    sortedLabs[Math.floor(sortedLabs.length * 0.12)] ?? sortedLabs[0],
    sortedLabs[Math.floor(sortedLabs.length * 0.5)] ?? sortedLabs[0],
    sortedLabs[Math.floor(sortedLabs.length * 0.88)] ?? sortedLabs[0],
  ].map((lab) => [...lab] as LabColor);

  for (let iteration = 0; iteration < 20; iteration += 1) {
    const sums = centers.map(() => [0, 0, 0, 0]);
    for (const lab of labs) {
      let bestIndex = 0;
      let bestDistance = Number.POSITIVE_INFINITY;
      centers.forEach((center, index) => {
        const distance = labDistance(lab, center);
        if (distance < bestDistance) {
          bestDistance = distance;
          bestIndex = index;
        }
      });
      sums[bestIndex][0] += lab[0];
      sums[bestIndex][1] += lab[1];
      sums[bestIndex][2] += lab[2];
      sums[bestIndex][3] += 1;
    }
    centers = centers.map((center, index) => {
      const count = sums[index][3];
      return count > 0 ? [sums[index][0] / count, sums[index][1] / count, sums[index][2] / count] : center;
    }) as LabColor[];
  }

  const cornerCoordinates = borderCoordinates.filter(
    ([x, y]) =>
      (x < borderWidth || x >= image.width - borderWidth) &&
      (y < borderWidth || y >= image.height - borderWidth),
  );
  const cornerMedian = medianLab(cornerCoordinates.map(([x, y]) => getLabAt(image, x, y)));
  const counts = centers.map(() => 0);
  for (const lab of labs) {
    let bestIndex = 0;
    let bestDistance = Number.POSITIVE_INFINITY;
    centers.forEach((center, index) => {
      const distance = labDistance(lab, center);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = index;
      }
    });
    counts[bestIndex] += 1;
  }
  const maxCount = Math.max(...counts, 1);
  const cornerDistances = centers.map((center) => labDistance(center, cornerMedian));
  const maxCornerDistance = Math.max(...cornerDistances, 1);
  const bgIndex = centers.reduce((bestIndex, center, index) => {
    const score = counts[index] / maxCount - 0.15 * (cornerDistances[index] / maxCornerDistance);
    const bestScore = counts[bestIndex] / maxCount - 0.15 * (cornerDistances[bestIndex] / maxCornerDistance);
    return score > bestScore ? index : bestIndex;
  }, 0);
  const bgLab = centers[bgIndex];
  const bgRgb = labToRgb(bgLab);
  const bgLuma = bgRgb[0] * 0.299 + bgRgb[1] * 0.587 + bgRgb[2] * 0.114;
  const borderDistances = labs.map((lab) => labDistance(lab, bgLab));

  return {
    bgLab,
    bgRgb,
    bgLuma,
    borderBase: percentile(borderDistances, 0.975),
  };
}

function createBackgroundCandidateMask(image: ImageData, options: CutoutOptions) {
  const { bgLab, bgRgb, bgLuma, borderBase } = estimateBackground(image, options);
  const total = image.width * image.height;
  const maybeBackground = new Uint8Array(total);
  const threshold =
    bgLuma > 180
      ? clamp(borderBase * 1.8 + 6, 9, 28)
      : bgLuma < 70
        ? clamp(borderBase * 2 + 8, 10, 36)
        : clamp(borderBase * 1.9 + 7, 10, 32);

  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const pixelIndex = y * image.width + x;
      const offset = pixelIndex * 4;
      const rgb = getRgbAt(image, x, y);
      const lab = rgbToLab(rgb[0], rgb[1], rgb[2]);
      const hsv = rgbToHsv(rgb[0], rgb[1], rgb[2]);
      const distance = labDistance(lab, bgLab);
      const isWhiteBackground = bgLuma > 180 && hsv[2] > 242 && hsv[1] < 20;
      const isDarkBackground = bgLuma < 70 && hsv[2] < 22 && hsv[1] < 55;
      const isCloseToBackground = distance < threshold;
      const sourceTransparent = image.data[offset + 3] < 128;
      maybeBackground[pixelIndex] =
        sourceTransparent || isCloseToBackground || isWhiteBackground || isDarkBackground ? 1 : 0;
    }
  }

  return { maybeBackground, bgRgb };
}

function floodBackground(maybeBackground: Uint8Array, width: number, height: number) {
  const connected = new Uint8Array(width * height);
  const queue = new Int32Array(width * height);
  let head = 0;
  let tail = 0;

  function enqueue(pixelIndex: number) {
    if (!maybeBackground[pixelIndex] || connected[pixelIndex]) return;
    connected[pixelIndex] = 1;
    queue[tail] = pixelIndex;
    tail += 1;
  }

  for (let x = 0; x < width; x += 1) {
    enqueue(x);
    enqueue((height - 1) * width + x);
  }
  for (let y = 1; y < height - 1; y += 1) {
    enqueue(y * width);
    enqueue(y * width + width - 1);
  }

  while (head < tail) {
    const pixelIndex = queue[head];
    head += 1;
    const x = pixelIndex % width;
    const y = Math.floor(pixelIndex / width);
    if (x > 0) enqueue(pixelIndex - 1);
    if (x < width - 1) enqueue(pixelIndex + 1);
    if (y > 0) enqueue(pixelIndex - width);
    if (y < height - 1) enqueue(pixelIndex + width);
  }

  return connected;
}

function removeSmallForegroundComponents(foreground: Uint8Array, width: number, height: number, minArea: number) {
  const output = new Uint8Array(foreground.length);
  const visited = new Uint8Array(foreground.length);
  const queue = new Int32Array(foreground.length);
  const component: number[] = [];

  for (let start = 0; start < foreground.length; start += 1) {
    if (!foreground[start] || visited[start]) continue;
    let head = 0;
    let tail = 0;
    component.length = 0;
    visited[start] = 1;
    queue[tail] = start;
    tail += 1;
    while (head < tail) {
      const pixelIndex = queue[head];
      head += 1;
      component.push(pixelIndex);
      const x = pixelIndex % width;
      const y = Math.floor(pixelIndex / width);
      for (let oy = -1; oy <= 1; oy += 1) {
        for (let ox = -1; ox <= 1; ox += 1) {
          if (ox === 0 && oy === 0) continue;
          const nx = x + ox;
          const ny = y + oy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const next = ny * width + nx;
          if (!foreground[next] || visited[next]) continue;
          visited[next] = 1;
          queue[tail] = next;
          tail += 1;
        }
      }
    }
    if (component.length >= minArea) {
      for (const pixelIndex of component) output[pixelIndex] = 1;
    }
  }

  return output;
}

function createDiskOffsets(radius: number) {
  const offsets: Array<[number, number]> = [];
  const safeRadius = Math.max(1, Math.round(radius));
  for (let y = -safeRadius; y <= safeRadius; y += 1) {
    for (let x = -safeRadius; x <= safeRadius; x += 1) {
      if (x * x + y * y <= safeRadius * safeRadius) offsets.push([x, y]);
    }
  }
  return offsets;
}

function dilate(mask: Uint8Array, width: number, height: number, radius: number) {
  const output = new Uint8Array(mask.length);
  const offsets = createDiskOffsets(radius);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const pixelIndex = y * width + x;
      if (!mask[pixelIndex]) continue;
      for (const [ox, oy] of offsets) {
        const nx = x + ox;
        const ny = y + oy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        output[ny * width + nx] = 1;
      }
    }
  }
  return output;
}

function erode(mask: Uint8Array, width: number, height: number, radius: number) {
  const output = new Uint8Array(mask.length);
  const offsets = createDiskOffsets(radius);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let keep = 1;
      for (const [ox, oy] of offsets) {
        const nx = x + ox;
        const ny = y + oy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height || !mask[ny * width + nx]) {
          keep = 0;
          break;
        }
      }
      output[y * width + x] = keep;
    }
  }
  return output;
}

function closeMask(mask: Uint8Array, width: number, height: number, radius: number) {
  return erode(dilate(mask, width, height, radius), width, height, radius);
}

function openMask(mask: Uint8Array, width: number, height: number, radius: number) {
  return dilate(erode(mask, width, height, radius), width, height, radius);
}

function gaussianKernel(sigma: number) {
  const radius = Math.max(1, Math.ceil(sigma * 3));
  const values: number[] = [];
  let sum = 0;
  for (let x = -radius; x <= radius; x += 1) {
    const value = Math.exp(-(x * x) / (2 * sigma * sigma));
    values.push(value);
    sum += value;
  }
  return values.map((value) => value / sum);
}

function gaussianBlurAlpha(alpha: Uint8Array, width: number, height: number, sigma: number) {
  const kernel = gaussianKernel(sigma);
  const radius = Math.floor(kernel.length / 2);
  const horizontal = new Float32Array(alpha.length);
  const output = new Uint8Array(alpha.length);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let sum = 0;
      for (let k = -radius; k <= radius; k += 1) {
        const nx = clamp(x + k, 0, width - 1);
        sum += alpha[y * width + nx] * kernel[k + radius];
      }
      horizontal[y * width + x] = sum;
    }
  }

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let sum = 0;
      for (let k = -radius; k <= radius; k += 1) {
        const ny = clamp(y + k, 0, height - 1);
        sum += horizontal[ny * width + x] * kernel[k + radius];
      }
      output[y * width + x] = Math.round(clamp(sum, 0, 255));
    }
  }

  return output;
}

function makeAlpha(foreground: Uint8Array, image: ImageData, options: CutoutOptions) {
  const hardAlpha = new Uint8Array(foreground.length);
  for (let i = 0; i < foreground.length; i += 1) hardAlpha[i] = foreground[i] ? 255 : 0;
  if (options.featherPx <= 0) return hardAlpha;

  const alpha = gaussianBlurAlpha(hardAlpha, image.width, image.height, options.featherPx);
  const bandRadius = Math.max(1, Math.round(options.featherPx));
  const eroded = erode(foreground, image.width, image.height, bandRadius);
  const dilated = dilate(foreground, image.width, image.height, bandRadius);
  for (let i = 0; i < alpha.length; i += 1) {
    if (eroded[i]) alpha[i] = 255;
    if (!dilated[i]) alpha[i] = 0;
    alpha[i] = Math.min(alpha[i], image.data[i * 4 + 3]);
  }
  return alpha;
}

function growForegroundBleed(image: ImageData, radius: number) {
  const safeRadius = Math.max(0, Math.round(radius));
  if (safeRadius <= 0) return image;

  const { width, height, data } = image;
  const output = new ImageData(new Uint8ClampedArray(data), width, height);
  const total = width * height;
  const visited = new Uint8Array(total);
  let frontier: number[] = [];
  const neighborOffsets = [
    [-1, -1],
    [0, -1],
    [1, -1],
    [-1, 0],
    [1, 0],
    [-1, 1],
    [0, 1],
    [1, 1],
  ];

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const pixelIndex = y * width + x;
      const alpha = data[pixelIndex * 4 + 3];
      if (alpha < 220) continue;
      visited[pixelIndex] = 1;
      const isBoundary = neighborOffsets.some(([ox, oy]) => {
        const nx = x + ox;
        const ny = y + oy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) return true;
        return data[(ny * width + nx) * 4 + 3] < 220;
      });
      if (isBoundary) frontier.push(pixelIndex);
    }
  }

  for (let step = 1; step <= safeRadius && frontier.length > 0; step += 1) {
    const nextFrontier: number[] = [];
    for (const pixelIndex of frontier) {
      const x = pixelIndex % width;
      const y = Math.floor(pixelIndex / width);
      const sourceOffset = pixelIndex * 4;
      for (const [ox, oy] of neighborOffsets) {
        const nx = x + ox;
        const ny = y + oy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const nextPixelIndex = ny * width + nx;
        if (visited[nextPixelIndex]) continue;
        visited[nextPixelIndex] = 1;
        const targetOffset = nextPixelIndex * 4;
        output.data[targetOffset] = output.data[sourceOffset];
        output.data[targetOffset + 1] = output.data[sourceOffset + 1];
        output.data[targetOffset + 2] = output.data[sourceOffset + 2];
        output.data[targetOffset + 3] = 255;
        nextFrontier.push(nextPixelIndex);
      }
    }
    frontier = nextFrontier;
  }

  return output;
}

function removeSolidBackground(image: ImageData, options: CutoutOptions = defaultOptions) {
  const { maybeBackground, bgRgb } = createBackgroundCandidateMask(image, options);
  const connectedBackground = floodBackground(maybeBackground, image.width, image.height);
  let foreground = new Uint8Array(connectedBackground.length);
  for (let i = 0; i < foreground.length; i += 1) foreground[i] = connectedBackground[i] ? 0 : 1;

  const minArea = Math.max(16, Math.floor(image.width * image.height * options.minAreaFrac));
  foreground = removeSmallForegroundComponents(foreground, image.width, image.height, minArea);
  if (options.closePx > 0) foreground = closeMask(foreground, image.width, image.height, options.closePx);
  if (options.openPx > 0) foreground = openMask(foreground, image.width, image.height, options.openPx);

  const alpha = makeAlpha(foreground, image, options);
  const output = new ImageData(image.width, image.height);
  for (let i = 0; i < alpha.length; i += 1) {
    const offset = i * 4;
    const nextAlpha = alpha[i];
    let red = image.data[offset];
    let green = image.data[offset + 1];
    let blue = image.data[offset + 2];
    const alphaRatio = nextAlpha / 255;
    if (alphaRatio > 0.001 && alphaRatio < 0.999) {
      const safeAlpha = Math.max(alphaRatio, 0.05);
      red = clamp((red - bgRgb[0] * (1 - safeAlpha)) / safeAlpha, 0, 255);
      green = clamp((green - bgRgb[1] * (1 - safeAlpha)) / safeAlpha, 0, 255);
      blue = clamp((blue - bgRgb[2] * (1 - safeAlpha)) / safeAlpha, 0, 255);
    }
    output.data[offset] = nextAlpha === 0 ? 0 : Math.round(red);
    output.data[offset + 1] = nextAlpha === 0 ? 0 : Math.round(green);
    output.data[offset + 2] = nextAlpha === 0 ? 0 : Math.round(blue);
    output.data[offset + 3] = nextAlpha;
  }
  return growForegroundBleed(output, options.bleedPx);
}

async function imageDataToPngUrl(imageData: ImageData) {
  const canvas = document.createElement('canvas');
  canvas.width = imageData.width;
  canvas.height = imageData.height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Could not create masked projected image canvas.');
  context.putImageData(imageData, 0, 0);
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((result) => {
      if (result) resolve(result);
      else reject(new Error('Could not encode masked projected image.'));
    }, 'image/png');
  });
  return createRegisteredObjectUrl(blob);
}

export async function createMaskedProjectedImage(imageUrl: string) {
  const sourceImage = await loadImageData(imageUrl, maxCutoutDimension);
  return imageDataToPngUrl(removeSolidBackground(sourceImage));
}
