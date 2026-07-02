import type { MaskBitmap, Rect } from '@/types/localRepaint';

export async function blobToDataUrl(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('Could not read blob.'));
    reader.readAsDataURL(blob);
  });
}

export function dataUrlToBlob(dataUrl: string) {
  const [header, encoded] = dataUrl.split(',');
  const mime = header?.match(/^data:([^;]+)/)?.[1] ?? 'image/png';
  const binary = atob(encoded ?? '');
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type: mime });
}

export async function urlToImageData(url: string, width?: number, height?: number) {
  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const element = new Image();
    element.crossOrigin = 'anonymous';
    element.onload = () => resolve(element);
    element.onerror = () => reject(new Error('Could not load image.'));
    element.src = url;
  });
  const canvas = document.createElement('canvas');
  canvas.width = width ?? (image.naturalWidth || image.width);
  canvas.height = height ?? (image.naturalHeight || image.height);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Could not create image canvas.');
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return context.getImageData(0, 0, canvas.width, canvas.height);
}

export function imageDataToBlob(imageData: ImageData) {
  const canvas = document.createElement('canvas');
  canvas.width = imageData.width;
  canvas.height = imageData.height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Could not create image canvas.');
  context.putImageData(imageData, 0, 0);
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Could not encode image.'))), 'image/png');
  });
}

export function cropImage(image: ImageData, rect: Rect) {
  const canvas = document.createElement('canvas');
  canvas.width = image.width;
  canvas.height = image.height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Could not create crop canvas.');
  context.putImageData(image, 0, 0);
  const output = document.createElement('canvas');
  output.width = rect.w;
  output.height = rect.h;
  const outputContext = output.getContext('2d');
  if (!outputContext) throw new Error('Could not create output crop canvas.');
  outputContext.drawImage(canvas, rect.x, rect.y, rect.w, rect.h, 0, 0, rect.w, rect.h);
  return outputContext.getImageData(0, 0, rect.w, rect.h);
}

export function pasteImage(base: ImageData, patch: ImageData, rect: Rect) {
  const output = new ImageData(new Uint8ClampedArray(base.data), base.width, base.height);
  for (let y = 0; y < rect.h; y += 1) {
    for (let x = 0; x < rect.w; x += 1) {
      const sourceOffset = (y * rect.w + x) * 4;
      const targetOffset = ((rect.y + y) * base.width + rect.x + x) * 4;
      output.data[targetOffset] = patch.data[sourceOffset];
      output.data[targetOffset + 1] = patch.data[sourceOffset + 1];
      output.data[targetOffset + 2] = patch.data[sourceOffset + 2];
      output.data[targetOffset + 3] = patch.data[sourceOffset + 3];
    }
  }
  return output;
}

export function compositeUsingMask(original: ImageData, edited: ImageData, featheredMask: MaskBitmap) {
  const output = new ImageData(new Uint8ClampedArray(original.data), original.width, original.height);
  for (let index = 0; index < featheredMask.data.length; index += 1) {
    const alpha = (featheredMask.data[index] ?? 0) / 255;
    if (alpha <= 0) continue;
    const offset = index * 4;
    output.data[offset] = Math.round(original.data[offset] * (1 - alpha) + edited.data[offset] * alpha);
    output.data[offset + 1] = Math.round(original.data[offset + 1] * (1 - alpha) + edited.data[offset + 1] * alpha);
    output.data[offset + 2] = Math.round(original.data[offset + 2] * (1 - alpha) + edited.data[offset + 2] * alpha);
    output.data[offset + 3] = Math.round(original.data[offset + 3] * (1 - alpha) + edited.data[offset + 3] * alpha);
  }
  return output;
}

export function restoreProtectedPixels(original: ImageData, edited: ImageData, protectMask: MaskBitmap) {
  const output = new ImageData(new Uint8ClampedArray(edited.data), edited.width, edited.height);
  for (let index = 0; index < protectMask.data.length; index += 1) {
    if ((protectMask.data[index] ?? 0) === 0) continue;
    const offset = index * 4;
    output.data[offset] = original.data[offset];
    output.data[offset + 1] = original.data[offset + 1];
    output.data[offset + 2] = original.data[offset + 2];
    output.data[offset + 3] = original.data[offset + 3];
  }
  return output;
}

export function applyAlphaFromMask(imageData: ImageData, mask: MaskBitmap) {
  const output = new ImageData(new Uint8ClampedArray(imageData.data), imageData.width, imageData.height);
  for (let index = 0; index < mask.data.length; index += 1) {
    output.data[index * 4 + 3] = mask.data[index] ?? 0;
  }
  return output;
}

export function resizeImageData(imageData: ImageData, width: number, height: number) {
  if (imageData.width === width && imageData.height === height) return imageData;
  const canvas = document.createElement('canvas');
  canvas.width = imageData.width;
  canvas.height = imageData.height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Could not resize image.');
  context.putImageData(imageData, 0, 0);
  const output = document.createElement('canvas');
  output.width = width;
  output.height = height;
  const outputContext = output.getContext('2d');
  if (!outputContext) throw new Error('Could not resize image.');
  outputContext.drawImage(canvas, 0, 0, width, height);
  return outputContext.getImageData(0, 0, width, height);
}

function getPixelToneStats(data: Uint8ClampedArray, offset: number) {
  const red = data[offset];
  const green = data[offset + 1];
  const blue = data[offset + 2];
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const chroma = max - min;
  const luma = red * 0.2126 + green * 0.7152 + blue * 0.0722;
  return { red, green, blue, max, min, chroma, luma };
}

function isWhiteMembraneCorePixel(data: Uint8ClampedArray, offset: number) {
  const { max, min, chroma, luma } = getPixelToneStats(data, offset);
  const balancedWhite = luma >= 210 && min >= 164 && chroma <= 58;
  const brightWhite = max >= 232 && min >= 176 && chroma <= 72;
  return balancedWhite || brightWhite;
}

function isWhiteMembraneCandidatePixel(data: Uint8ClampedArray, offset: number) {
  if (isWhiteMembraneCorePixel(data, offset)) return true;
  const { red, green, blue, min, chroma, luma } = getPixelToneStats(data, offset);
  const shadedWhite = luma >= 188 && min >= 142 && chroma <= 66;
  const warmViewportWhite = red >= 170 && green >= 150 && blue >= 128 && luma >= 176 && chroma <= 76 && red - blue <= 62;
  return shadedWhite || warmViewportWhite;
}

function isLikelyWhiteMembranePixel(data: Uint8ClampedArray, offset: number) {
  return isWhiteMembraneCandidatePixel(data, offset);
}

function isLikelyBlankPixel(data: Uint8ClampedArray, offset: number) {
  return isLikelyWhiteMembranePixel(data, offset);
}

export function contentAwareFillMaskedPixels(
  imageData: ImageData,
  editMask: MaskBitmap,
  objectMask: MaskBitmap,
  options: { searchRadius?: number; iterations?: number; patchRadius?: number } = {},
) {
  const width = imageData.width;
  const height = imageData.height;
  const searchRadius = Math.max(8, Math.floor(options.searchRadius ?? 34));
  const sampleRadius = Math.max(5, Math.min(searchRadius, Math.floor((options.patchRadius ?? 4) * 4)));
  const smoothingPasses = Math.max(1, Math.floor(options.iterations ?? 4));
  const output = new ImageData(new Uint8ClampedArray(imageData.data), width, height);
  const fillPixels: number[] = [];
  const unknown = new Uint8Array(width * height);
  const known = new Uint8Array(width * height);
  const originalSource = new Uint8Array(width * height);

  for (let index = 0; index < editMask.data.length; index += 1) {
    const offset = index * 4;
    const onObject = (objectMask.data[index] ?? 0) > 0;
    const inFill = (editMask.data[index] ?? 0) > 0 && onObject;
    if (inFill) {
      fillPixels.push(index);
      unknown[index] = 1;
    }
    if (!inFill && onObject && imageData.data[offset + 3] > 8 && !isLikelyBlankPixel(imageData.data, offset)) {
      known[index] = 1;
      originalSource[index] = 1;
    }
  }

  if (fillPixels.length === 0 || known.every((value) => value === 0)) return output;

  const hasKnownNeighbor = (index: number) => {
    const x = index % width;
    const y = Math.floor(index / width);
    for (let oy = -1; oy <= 1; oy += 1) {
      for (let ox = -1; ox <= 1; ox += 1) {
        if (ox === 0 && oy === 0) continue;
        const nx = x + ox;
        const ny = y + oy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        if (known[ny * width + nx]) return true;
      }
    }
    return false;
  };
  const fillFromNeighborhood = (index: number, radius: number) => {
    const x = index % width;
    const y = Math.floor(index / width);
    let red = 0;
    let green = 0;
    let blue = 0;
    let alpha = 0;
    let total = 0;
    let samples = 0;
    for (let oy = -radius; oy <= radius; oy += 1) {
      const sy = y + oy;
      if (sy < 0 || sy >= height) continue;
      for (let ox = -radius; ox <= radius; ox += 1) {
        const sx = x + ox;
        if (sx < 0 || sx >= width) continue;
        const distanceSquared = ox * ox + oy * oy;
        if (distanceSquared === 0 || distanceSquared > radius * radius) continue;
        const sourceIndex = sy * width + sx;
        if (!known[sourceIndex]) continue;
        const sourceOffset = sourceIndex * 4;
        const sourceBoost = originalSource[sourceIndex] ? 1.45 : 0.72;
        const weight = sourceBoost / Math.pow(distanceSquared + 1.2, 1.15);
        red += output.data[sourceOffset] * weight;
        green += output.data[sourceOffset + 1] * weight;
        blue += output.data[sourceOffset + 2] * weight;
        alpha += output.data[sourceOffset + 3] * weight;
        total += weight;
        samples += 1;
      }
    }
    if (total <= 0 || samples === 0) return false;
    const targetOffset = index * 4;
    output.data[targetOffset] = Math.round(red / total);
    output.data[targetOffset + 1] = Math.round(green / total);
    output.data[targetOffset + 2] = Math.round(blue / total);
    output.data[targetOffset + 3] = Math.round(alpha / total);
    return true;
  };

  let remaining = fillPixels.length;
  while (remaining > 0) {
    const newlyKnown: number[] = [];
    for (const index of fillPixels) {
      if (!unknown[index] || !hasKnownNeighbor(index)) continue;
      if (!fillFromNeighborhood(index, sampleRadius)) {
        fillFromNeighborhood(index, searchRadius);
      }
      newlyKnown.push(index);
    }
    if (newlyKnown.length === 0) break;
    for (const index of newlyKnown) {
      unknown[index] = 0;
      known[index] = 1;
      remaining -= 1;
    }
  }

  for (const index of fillPixels) {
    if (!unknown[index]) continue;
    for (let radius = sampleRadius; radius <= searchRadius && unknown[index]; radius += sampleRadius) {
      if (fillFromNeighborhood(index, radius)) {
        unknown[index] = 0;
        known[index] = 1;
      }
    }
  }

  const smoothed = new Uint8ClampedArray(output.data);
  for (let pass = 0; pass < smoothingPasses; pass += 1) {
    smoothed.set(output.data);
    for (const index of fillPixels) {
      const x = index % width;
      const y = Math.floor(index / width);
      let red = output.data[index * 4] * 1.55;
      let green = output.data[index * 4 + 1] * 1.55;
      let blue = output.data[index * 4 + 2] * 1.55;
      let alpha = output.data[index * 4 + 3] * 1.55;
      let total = 1.55;
      for (let oy = -1; oy <= 1; oy += 1) {
        for (let ox = -1; ox <= 1; ox += 1) {
          if (ox === 0 && oy === 0) continue;
          const nx = x + ox;
          const ny = y + oy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const neighborIndex = ny * width + nx;
          if (!known[neighborIndex] || (objectMask.data[neighborIndex] ?? 0) === 0) continue;
          const neighborOffset = neighborIndex * 4;
          const weight = originalSource[neighborIndex] ? 0.42 : 0.22;
          red += output.data[neighborOffset] * weight;
          green += output.data[neighborOffset + 1] * weight;
          blue += output.data[neighborOffset + 2] * weight;
          alpha += output.data[neighborOffset + 3] * weight;
          total += weight;
        }
      }
      const targetOffset = index * 4;
      smoothed[targetOffset] = Math.round(red / total);
      smoothed[targetOffset + 1] = Math.round(green / total);
      smoothed[targetOffset + 2] = Math.round(blue / total);
      smoothed[targetOffset + 3] = Math.round(alpha / total);
    }
    output.data.set(smoothed);
  }

  return output;
}

export function inferWhiteHoleMask(imageData: ImageData, objectMask: MaskBitmap) {
  const width = imageData.width;
  const height = imageData.height;
  const mask: MaskBitmap = { width, height, data: new Uint8ClampedArray(width * height) };
  const visited = new Uint8Array(width * height);
  const queue = new Int32Array(width * height);
  const component: number[] = [];

  for (let index = 0; index < mask.data.length; index += 1) {
    if (visited[index] || (objectMask.data[index] ?? 0) === 0) continue;
    const offset = index * 4;
    if (!isWhiteMembraneCorePixel(imageData.data, offset)) continue;

    let head = 0;
    let tail = 0;
    let corePixels = 0;
    component.length = 0;
    queue[tail] = index;
    tail += 1;
    visited[index] = 1;

    while (head < tail) {
      const current = queue[head];
      head += 1;
      component.push(current);
      const currentOffset = current * 4;
      if (isWhiteMembraneCorePixel(imageData.data, currentOffset)) corePixels += 1;
      const x = current % width;
      const y = Math.floor(current / width);
      const neighbors = [
        x > 0 ? current - 1 : -1,
        x < width - 1 ? current + 1 : -1,
        y > 0 ? current - width : -1,
        y < height - 1 ? current + width : -1,
      ];
      for (const neighbor of neighbors) {
        if (neighbor < 0 || visited[neighbor] || (objectMask.data[neighbor] ?? 0) === 0) continue;
        if (!isWhiteMembraneCandidatePixel(imageData.data, neighbor * 4)) continue;
        visited[neighbor] = 1;
        queue[tail] = neighbor;
        tail += 1;
      }
    }

    if (component.length >= 24 && corePixels >= 6 && corePixels / component.length >= 0.08) {
      for (const pixel of component) mask.data[pixel] = 255;
    }
  }
  return mask;
}

export function inferAlphaObjectMask(imageData: ImageData, alphaThreshold = 8) {
  const mask: MaskBitmap = {
    width: imageData.width,
    height: imageData.height,
    data: new Uint8ClampedArray(imageData.width * imageData.height),
  };
  for (let index = 0; index < mask.data.length; index += 1) {
    mask.data[index] = imageData.data[index * 4 + 3] > alphaThreshold ? 255 : 0;
  }
  return mask;
}
