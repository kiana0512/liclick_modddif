import { loadImageData } from '@/engine/bake/imageSampler';

type Rgb = [number, number, number];
type BackgroundModel = {
  colors: Rgb[];
  hard: number;
  soft: number;
};

function smoothstep(edge0: number, edge1: number, value: number) {
  const x = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0)));
  return x * x * (3 - 2 * x);
}

function getMaskValue(maskImage: ImageData, index: number) {
  return Math.max(maskImage.data[index], maskImage.data[index + 1], maskImage.data[index + 2]);
}

function getGeometryAlpha(maskImage: ImageData, index: number) {
  return smoothstep(10, 72, getMaskValue(maskImage, index));
}

function median(values: number[]) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function collectBackgroundSamples(sourceImage: ImageData, maskImage: ImageData) {
  const samples: Rgb[] = [];
  const stride = Math.max(1, Math.floor(Math.min(sourceImage.width, sourceImage.height) / 180));

  for (let y = 0; y < sourceImage.height; y += stride) {
    for (let x = 0; x < sourceImage.width; x += stride) {
      const index = (y * sourceImage.width + x) * 4;
      const isMaskBackground = getMaskValue(maskImage, index) < 12;
      const isImageBorder =
        x < stride * 3 ||
        y < stride * 3 ||
        x >= sourceImage.width - stride * 3 ||
        y >= sourceImage.height - stride * 3;
      if (!isMaskBackground && !isImageBorder) continue;
      samples.push([sourceImage.data[index], sourceImage.data[index + 1], sourceImage.data[index + 2]]);
    }
  }

  return samples;
}

function colorDistance(a: Rgb, b: Rgb) {
  const dr = (a[0] - b[0]) * 0.9;
  const dg = (a[1] - b[1]) * 1.05;
  const db = (a[2] - b[2]) * 0.9;
  return Math.sqrt(dr * dr + dg * dg + db * db) / 419.0;
}

function getDominantBackgroundColors(samples: Rgb[]) {
  const buckets = new Map<string, { count: number; red: number; green: number; blue: number }>();
  for (const sample of samples) {
    const key = `${sample[0] >> 4}:${sample[1] >> 4}:${sample[2] >> 4}`;
    const bucket = buckets.get(key) ?? { count: 0, red: 0, green: 0, blue: 0 };
    bucket.count += 1;
    bucket.red += sample[0];
    bucket.green += sample[1];
    bucket.blue += sample[2];
    buckets.set(key, bucket);
  }

  const colors = [...buckets.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, 6)
    .map((bucket) => [
      Math.round(bucket.red / bucket.count),
      Math.round(bucket.green / bucket.count),
      Math.round(bucket.blue / bucket.count),
    ] as Rgb);

  if (colors.length > 0) return colors;
  return [[0, 0, 0] as Rgb];
}

function distanceToBackgroundColor(color: Rgb, model: Pick<BackgroundModel, 'colors'>) {
  let best = Number.POSITIVE_INFINITY;
  for (const backgroundColor of model.colors) {
    best = Math.min(best, colorDistance(color, backgroundColor));
  }
  return best;
}

function colorAt(sourceImage: ImageData, index: number): Rgb {
  return [sourceImage.data[index], sourceImage.data[index + 1], sourceImage.data[index + 2]];
}

function getChroma(color: Rgb) {
  return Math.max(color[0], color[1], color[2]) - Math.min(color[0], color[1], color[2]);
}

function getLuma(color: Rgb) {
  return color[0] * 0.299 + color[1] * 0.587 + color[2] * 0.114;
}

function colorDistanceFromBackground(sourceImage: ImageData, index: number, model: Pick<BackgroundModel, 'colors'>) {
  return distanceToBackgroundColor(colorAt(sourceImage, index), model);
}

function createBackgroundModel(sourceImage: ImageData, maskImage: ImageData): BackgroundModel {
  const samples = collectBackgroundSamples(sourceImage, maskImage);
  const colors = getDominantBackgroundColors(samples);
  const distances = samples.map((sample) => distanceToBackgroundColor(sample, { colors }));
  const base = median(distances);
  const deviations = distances.map((value) => Math.abs(value - base));
  const mad = median(deviations);

  return {
    colors,
    hard: Math.min(0.16, Math.max(0.035, base + mad * 5 + 0.028)),
    soft: Math.min(0.31, Math.max(0.11, base + mad * 10 + 0.09)),
  };
}

function getNeighborBackgroundPressure(
  connectedBackground: Uint8Array,
  width: number,
  height: number,
  x: number,
  y: number,
) {
  let hits = 0;
  let total = 0;
  for (let oy = -1; oy <= 1; oy += 1) {
    for (let ox = -1; ox <= 1; ox += 1) {
      if (ox === 0 && oy === 0) continue;
      const nx = x + ox;
      const ny = y + oy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      total += 1;
      if (connectedBackground[ny * width + nx]) hits += 1;
    }
  }
  return total === 0 ? 0 : hits / total;
}

function findConnectedBackground(sourceImage: ImageData, maskImage: ImageData, background: BackgroundModel) {
  const { width, height } = sourceImage;
  const total = width * height;
  const visited = new Uint8Array(total);
  const queue = new Int32Array(total);
  let head = 0;
  let tail = 0;

  function canVisit(pixelIndex: number) {
    if (visited[pixelIndex]) return false;
    const dataIndex = pixelIndex * 4;
    const geometryAlpha = getGeometryAlpha(maskImage, dataIndex);
    if (geometryAlpha < 0.08) return true;
    if (geometryAlpha < 0.42) {
      return colorDistanceFromBackground(sourceImage, dataIndex, background) <= background.hard;
    }
    return false;
  }

  function enqueue(pixelIndex: number) {
    if (!canVisit(pixelIndex)) return;
    visited[pixelIndex] = 1;
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

  return visited;
}

function removeTinyAlphaIslands(output: ImageData, minNeighbors: number) {
  const { width, height } = output;
  const alpha = output.data;
  const clearPixels: number[] = [];

  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const pixelIndex = y * width + x;
      const index = pixelIndex * 4;
      if (alpha[index + 3] === 0) continue;
      let neighbors = 0;
      for (let oy = -1; oy <= 1; oy += 1) {
        for (let ox = -1; ox <= 1; ox += 1) {
          if (ox === 0 && oy === 0) continue;
          const neighborIndex = ((y + oy) * width + x + ox) * 4;
          if (alpha[neighborIndex + 3] > 0) neighbors += 1;
        }
      }
      if (neighbors < minNeighbors) clearPixels.push(index);
    }
  }

  for (const index of clearPixels) {
    alpha[index] = 0;
    alpha[index + 1] = 0;
    alpha[index + 2] = 0;
    alpha[index + 3] = 0;
  }
}

function drawImageDataToScaledCanvas(imageData: ImageData, width: number, height: number) {
  const sourceCanvas = document.createElement('canvas');
  sourceCanvas.width = imageData.width;
  sourceCanvas.height = imageData.height;
  const sourceContext = sourceCanvas.getContext('2d');
  if (!sourceContext) throw new Error('Could not create source image canvas.');
  sourceContext.putImageData(imageData, 0, 0);

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('Could not create scaled image canvas.');
  context.drawImage(sourceCanvas, 0, 0, width, height);
  return context.getImageData(0, 0, width, height);
}

export async function createMaskedProjectedImage(imageUrl: string, maskUrl: string) {
  const [sourceImage, sourceMask] = await Promise.all([loadImageData(imageUrl), loadImageData(maskUrl)]);
  const maskImage =
    sourceMask.width === sourceImage.width && sourceMask.height === sourceImage.height
      ? sourceMask
      : drawImageDataToScaledCanvas(sourceMask, sourceImage.width, sourceImage.height);

  const canvas = document.createElement('canvas');
  canvas.width = sourceImage.width;
  canvas.height = sourceImage.height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Could not create masked projected image canvas.');

  const background = createBackgroundModel(sourceImage, maskImage);
  const connectedBackground = findConnectedBackground(sourceImage, maskImage, background);
  const output = new ImageData(sourceImage.width, sourceImage.height);
  for (let index = 0; index < sourceImage.data.length; index += 4) {
    const pixelIndex = index / 4;
    const x = pixelIndex % sourceImage.width;
    const y = Math.floor(pixelIndex / sourceImage.width);
    const geometryAlpha = getGeometryAlpha(maskImage, index);
    const sourceColor = colorAt(sourceImage, index);
    const matteDistance = colorDistanceFromBackground(sourceImage, index, background);
    const connectedBackgroundAlpha = connectedBackground[pixelIndex]
      ? 1 - smoothstep(background.hard, background.soft, matteDistance)
      : 0;
    const edgeBackgroundPressure = getNeighborBackgroundPressure(
      connectedBackground,
      sourceImage.width,
      sourceImage.height,
      x,
      y,
    );
    const sourceAlpha = sourceImage.data[index + 3] / 255;
    const isConnectedBackground = connectedBackground[pixelIndex] === 1;
    const foregroundAlpha = isConnectedBackground ? smoothstep(background.hard, background.soft, matteDistance) : 1;
    const edgeAlpha = isConnectedBackground
      ? 1 - edgeBackgroundPressure * (1 - smoothstep(background.hard, background.soft, matteDistance))
      : 1;
    const chroma = getChroma(sourceColor);
    const luma = getLuma(sourceColor);
    const likelyNeutralResidue =
      chroma < 32 &&
      luma > 28 &&
      luma < 248 &&
      isConnectedBackground &&
      (edgeBackgroundPressure > 0.1 || matteDistance < background.soft * 1.35);
    const neutralResidueAlpha = likelyNeutralResidue ? smoothstep(22, 48, chroma) : 1;
    const alpha = isConnectedBackground
      ? geometryAlpha *
        foregroundAlpha *
        edgeAlpha *
        neutralResidueAlpha *
        (1 - connectedBackgroundAlpha * 0.7) *
        sourceAlpha
      : sourceAlpha;
    output.data[index] = sourceImage.data[index];
    output.data[index + 1] = sourceImage.data[index + 1];
    output.data[index + 2] = sourceImage.data[index + 2];
    output.data[index + 3] = alpha < 0.5 ? 0 : 255;
    if (output.data[index + 3] === 0) {
      output.data[index] = 0;
      output.data[index + 1] = 0;
      output.data[index + 2] = 0;
    }
  }

  removeTinyAlphaIslands(output, 2);
  context.putImageData(output, 0, 0);
  return canvas.toDataURL('image/png');
}
