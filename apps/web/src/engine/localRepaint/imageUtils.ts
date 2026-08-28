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
  const context = canvas.getContext('2d', { willReadFrequently: true });
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
  const outputContext = output.getContext('2d', { willReadFrequently: true });
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

export function applyAlphaFromMask(
  imageData: ImageData,
  mask: MaskBitmap,
  colorBleedRadius = 0,
) {
  const output = new ImageData(new Uint8ClampedArray(imageData.data), imageData.width, imageData.height);
  for (let index = 0; index < mask.data.length; index += 1) {
    output.data[index * 4 + 3] = mask.data[index] ?? 0;
  }

  // Linear filtering and generated mip levels sample RGB even when the sampled
  // texel itself is transparent. Leaving the viewport's black hatch in those
  // transparent texels therefore creates a dark outline around the patch.
  // Extend only RGB outwards while keeping alpha untouched, exactly like
  // texture-atlas padding. This changes sampling at the edge, not the edit area.
  const radius = Math.max(0, Math.floor(colorBleedRadius));
  if (radius === 0) return output;
  const width = imageData.width;
  const height = imageData.height;
  const resolved = new Uint8Array(width * height);
  for (let index = 0; index < resolved.length; index += 1) {
    if ((mask.data[index] ?? 0) > 0) resolved[index] = 1;
  }
  for (let ring = 0; ring < radius; ring += 1) {
    const previous = new Uint8Array(resolved);
    let added = 0;
    for (let index = 0; index < resolved.length; index += 1) {
      if (previous[index]) continue;
      const x = index % width;
      const y = Math.floor(index / width);
      let red = 0;
      let green = 0;
      let blue = 0;
      let samples = 0;
      for (let oy = -1; oy <= 1; oy += 1) {
        for (let ox = -1; ox <= 1; ox += 1) {
          if (ox === 0 && oy === 0) continue;
          const nx = x + ox;
          const ny = y + oy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const neighbor = ny * width + nx;
          if (!previous[neighbor]) continue;
          const neighborOffset = neighbor * 4;
          red += output.data[neighborOffset];
          green += output.data[neighborOffset + 1];
          blue += output.data[neighborOffset + 2];
          samples += 1;
        }
      }
      if (samples === 0) continue;
      const offset = index * 4;
      output.data[offset] = Math.round(red / samples);
      output.data[offset + 1] = Math.round(green / samples);
      output.data[offset + 2] = Math.round(blue / samples);
      // Alpha deliberately remains zero outside the supplied mask.
      resolved[index] = 1;
      added += 1;
    }
    if (added === 0) break;
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
  const outputContext = output.getContext('2d', { willReadFrequently: true });
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

export function contentAwareFillMaskedPixels(
  imageData: ImageData,
  editMask: MaskBitmap,
  objectMask: MaskBitmap,
  options: { searchRadius?: number; iterations?: number; patchRadius?: number } = {},
) {
  // Kept in the public signature for callers saved by older projects. Edge
  // extension is linear-time and no longer needs iterative patch searches.
  void options;
  const width = imageData.width;
  const height = imageData.height;
  const output = new ImageData(new Uint8ClampedArray(imageData.data), width, height);
  const fillPixels: number[] = [];
  const unknown = new Uint8Array(width * height);
  const known = new Uint8Array(width * height);
  let fallbackRed = 0;
  let fallbackGreen = 0;
  let fallbackBlue = 0;
  let fallbackAlpha = 0;
  let knownPixelCount = 0;

  for (let index = 0; index < editMask.data.length; index += 1) {
    const offset = index * 4;
    const onObject = (objectMask.data[index] ?? 0) > 0;
    const inFill = (editMask.data[index] ?? 0) > 0 && onObject;
    if (inFill) {
      fillPixels.push(index);
      unknown[index] = 1;
    }
    if (!inFill && onObject && imageData.data[offset + 3] > 8) {
      known[index] = 1;
      fallbackRed += imageData.data[offset];
      fallbackGreen += imageData.data[offset + 1];
      fallbackBlue += imageData.data[offset + 2];
      fallbackAlpha += imageData.data[offset + 3];
      knownPixelCount += 1;
    }
  }

  if (fillPixels.length === 0 || knownPixelCount === 0) return output;
  fallbackRed /= knownPixelCount;
  fallbackGreen /= knownPixelCount;
  fallbackBlue /= knownPixelCount;
  fallbackAlpha /= knownPixelCount;

  // Record the nearest real edge texel in all four cardinal directions. This
  // preserves the actual boundary colors instead of repeatedly averaging
  // already-filled rings, which used to create a darker stripe in long gaps.
  const left = new Int32Array(width * height).fill(-1);
  const right = new Int32Array(width * height).fill(-1);
  const up = new Int32Array(width * height).fill(-1);
  const down = new Int32Array(width * height).fill(-1);
  for (let y = 0; y < height; y += 1) {
    let source = -1;
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      if (known[index]) source = index;
      else if (unknown[index]) left[index] = source;
    }
    source = -1;
    for (let x = width - 1; x >= 0; x -= 1) {
      const index = y * width + x;
      if (known[index]) source = index;
      else if (unknown[index]) right[index] = source;
    }
  }
  for (let x = 0; x < width; x += 1) {
    let source = -1;
    for (let y = 0; y < height; y += 1) {
      const index = y * width + x;
      if (known[index]) source = index;
      else if (unknown[index]) up[index] = source;
    }
    source = -1;
    for (let y = height - 1; y >= 0; y -= 1) {
      const index = y * width + x;
      if (known[index]) source = index;
      else if (unknown[index]) down[index] = source;
    }
  }

  const data = imageData.data;
  for (const index of fillPixels) {
    const x = index % width;
    const y = Math.floor(index / width);
    let red = 0;
    let green = 0;
    let blue = 0;
    let alpha = 0;
    let totalWeight = 0;
    const addAxisEstimate = (first: number, second: number, vertical: boolean) => {
      if (first < 0 && second < 0) return;
      const firstDistance =
        first < 0
          ? 0
          : vertical
            ? y - Math.floor(first / width)
            : x - (first % width);
      const secondDistance =
        second < 0
          ? 0
          : vertical
            ? Math.floor(second / width) - y
            : (second % width) - x;
      let firstMix = first >= 0 ? 1 : 0;
      let secondMix = second >= 0 ? 1 : 0;
      let span = Math.max(firstDistance, secondDistance, 1);
      if (first >= 0 && second >= 0) {
        span = Math.max(1, firstDistance + secondDistance);
        firstMix = secondDistance / span;
        secondMix = firstDistance / span;
      }
      // Prefer the shorter crossing direction. A vertical strip therefore
      // extends its left/right edge colors instead of mixing remote top/bottom.
      const weight = 1 / span;
      const addSource = (sourceIndex: number, mix: number) => {
        if (sourceIndex < 0 || mix <= 0) return;
        const offset = sourceIndex * 4;
        red += data[offset] * mix * weight;
        green += data[offset + 1] * mix * weight;
        blue += data[offset + 2] * mix * weight;
        alpha += data[offset + 3] * mix * weight;
      };
      addSource(first, firstMix);
      addSource(second, secondMix);
      totalWeight += weight;
    };
    addAxisEstimate(left[index], right[index], false);
    addAxisEstimate(up[index], down[index], true);
    const offset = index * 4;
    if (totalWeight <= 0) {
      // A completely uncovered UV island may not share a row or column with a
      // valid source texel. Give it a stable model-wide fallback instead of
      // leaving transparent black pixels that recreate the viewport hatch.
      output.data[offset] = Math.round(fallbackRed);
      output.data[offset + 1] = Math.round(fallbackGreen);
      output.data[offset + 2] = Math.round(fallbackBlue);
      output.data[offset + 3] = Math.round(fallbackAlpha);
    } else {
      output.data[offset] = Math.round(red / totalWeight);
      output.data[offset + 1] = Math.round(green / totalWeight);
      output.data[offset + 2] = Math.round(blue / totalWeight);
      output.data[offset + 3] = Math.round(alpha / totalWeight);
    }
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
  let objectMinX = width;
  let objectMinY = height;
  let objectMaxX = -1;
  let objectMaxY = -1;
  for (let index = 0; index < objectMask.data.length; index += 1) {
    if ((objectMask.data[index] ?? 0) === 0) continue;
    const x = index % width;
    const y = Math.floor(index / width);
    objectMinX = Math.min(objectMinX, x);
    objectMinY = Math.min(objectMinY, y);
    objectMaxX = Math.max(objectMaxX, x);
    objectMaxY = Math.max(objectMaxY, y);
  }
  const objectMinSide = Math.max(
    1,
    Math.min(objectMaxX - objectMinX + 1, objectMaxY - objectMinY + 1),
  );
  const maxBoundaryGapWidth = Math.max(8, Math.round(objectMinSide * 0.16));

  for (let index = 0; index < mask.data.length; index += 1) {
    if (visited[index] || (objectMask.data[index] ?? 0) === 0) continue;
    const offset = index * 4;
    if (!isWhiteMembraneCorePixel(imageData.data, offset)) continue;

    let head = 0;
    let tail = 0;
    let corePixels = 0;
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;
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
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
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

    let texturedBoundary = 0;
    let touchesObjectSilhouette = false;
    for (const pixel of component) {
      const x = pixel % width;
      const y = Math.floor(pixel / width);
      const neighbors = [
        x > 0 ? pixel - 1 : -1,
        x < width - 1 ? pixel + 1 : -1,
        y > 0 ? pixel - width : -1,
        y < height - 1 ? pixel + width : -1,
      ];
      for (const neighbor of neighbors) {
        if (neighbor < 0 || (objectMask.data[neighbor] ?? 0) === 0) {
          touchesObjectSilhouette = true;
          continue;
        }
        if (isWhiteMembraneCandidatePixel(imageData.data, neighbor * 4)) continue;
        if (imageData.data[neighbor * 4 + 3] > 8) texturedBoundary += 1;
      }
    }

    const componentWidth = maxX - minX + 1;
    const componentHeight = maxY - minY + 1;
    const isNarrowBoundaryGap = Math.min(componentWidth, componentHeight) <= maxBoundaryGapWidth;
    const hasUsableTextureEdge = texturedBoundary >= Math.max(8, Math.sqrt(component.length));
    const hasStableBlankCore = corePixels >= 8 && corePixels / component.length >= 0.12;
    // A real interior hole is surrounded by usable texture. A hole connected
    // to the silhouette is accepted only when it is seam-like; this prevents
    // an intended white/grey side of the model from becoming one giant mask.
    if (
      component.length >= 48 &&
      hasStableBlankCore &&
      hasUsableTextureEdge &&
      (!touchesObjectSilhouette || isNarrowBoundaryGap)
    ) {
      for (const pixel of component) mask.data[pixel] = 255;
    }
  }
  return mask;
}

function linearToneMappedSrgbByte(linearColor: number, exposure: number) {
  const linear = Math.max(0, Math.min(1, linearColor * exposure));
  const srgb =
    linear <= 0.0031308
      ? linear * 12.92
      : 1.055 * Math.pow(linear, 1 / 2.4) - 0.055;
  return srgb * 255;
}

function isProjectionGapPreviewPixel(
  data: Uint8ClampedArray,
  offset: number,
  expectedDarkTone: number,
  expectedLightTone: number,
) {
  if (data[offset + 3] <= 8) return false;
  const { red, green, blue, chroma } = getPixelToneStats(data, offset);
  if (chroma > 5) return false;
  const tone = (red + green + blue) / 3;
  return (
    Math.abs(tone - expectedDarkTone) <= 4 ||
    Math.abs(tone - expectedLightTone) <= 4
  );
}

/**
 * Detect the screen-space hatch emitted by ProjectedLayerMaterial for texels
 * with zero projection coverage. Unlike a color heuristic, this verifies the
 * same 0.095-period diagonal signal as the shader, so black artwork is not
 * automatically treated as an untextured hole.
 */
export function inferProjectionGapMask(
  imageData: ImageData,
  objectMask: MaskBitmap,
  exposure = 1,
) {
  const width = imageData.width;
  const height = imageData.height;
  const pixelCount = width * height;
  const mask: MaskBitmap = { width, height, data: new Uint8ClampedArray(pixelCount) };
  const candidate = new Uint8Array(pixelCount);
  const visited = new Uint8Array(pixelCount);
  const queue = new Int32Array(pixelCount);
  const component: number[] = [];
  const safeExposure = Number.isFinite(exposure) ? Math.max(0.05, exposure) : 1;
  const expectedDarkTone = linearToneMappedSrgbByte(0.012, safeExposure);
  const expectedLightTone = linearToneMappedSrgbByte(0.012 * 0.38 + 0.09 * 0.62, safeExposure);
  let objectPixels = 0;

  for (let index = 0; index < pixelCount; index += 1) {
    if ((objectMask.data[index] ?? 0) === 0) continue;
    objectPixels += 1;
    if (
      isProjectionGapPreviewPixel(
        imageData.data,
        index * 4,
        expectedDarkTone,
        expectedLightTone,
      )
    )
      candidate[index] = 1;
  }

  // The shader's two solid hatch tones cover almost the whole gap, but MSAA
  // leaves a thin band of intermediate pixels at the boundary. Absorb only
  // dark pixels immediately touching the verified hatch: one unrestricted
  // edge pixel, then one extra pixel only for neutral grey. This removes the
  // black seam without growing into ordinary coloured projection content.
  const fringeLumaLimit = expectedLightTone + 18;
  for (let pass = 0; pass < 2; pass += 1) {
    const previous = new Uint8Array(candidate);
    for (let index = 0; index < pixelCount; index += 1) {
      if (candidate[index] || (objectMask.data[index] ?? 0) === 0) continue;
      const { chroma, luma } = getPixelToneStats(imageData.data, index * 4);
      if (imageData.data[index * 4 + 3] <= 8 || luma > fringeLumaLimit) continue;
      if (pass > 0 && chroma > 8) continue;
      const x = index % width;
      const y = Math.floor(index / width);
      let touchesHatch = false;
      for (let oy = -1; oy <= 1 && !touchesHatch; oy += 1) {
        for (let ox = -1; ox <= 1; ox += 1) {
          if (ox === 0 && oy === 0) continue;
          const nx = x + ox;
          const ny = y + oy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          if (previous[ny * width + nx]) {
            touchesHatch = true;
            break;
          }
        }
      }
      if (touchesHatch) candidate[index] = 1;
    }
  }

  // Keep this independent from the total on-screen model area. The former
  // proportional threshold could exceed a thousand pixels on close-up views
  // and silently discard real pinholes and narrow cracks.
  const minComponentPixels = Math.max(
    4,
    Math.min(16, Math.round(objectPixels * 0.00001)),
  );
  for (let index = 0; index < pixelCount; index += 1) {
    if (!candidate[index] || visited[index]) continue;
    let head = 0;
    let tail = 0;
    let darkCorePixels = 0;
    let lightCorePixels = 0;
    const phaseLuma = new Float64Array(20);
    const phaseSamples = new Uint32Array(20);
    component.length = 0;
    queue[tail++] = index;
    visited[index] = 1;

    while (head < tail) {
      const current = queue[head++];
      component.push(current);
      const x = current % width;
      const y = Math.floor(current / width);
      const { luma } = getPixelToneStats(imageData.data, current * 4);
      const toneOffset = current * 4;
      const tone =
        (imageData.data[toneOffset] +
          imageData.data[toneOffset + 1] +
          imageData.data[toneOffset + 2]) /
        3;
      if (Math.abs(tone - expectedDarkTone) <= 4) darkCorePixels += 1;
      if (Math.abs(tone - expectedLightTone) <= 4) lightCorePixels += 1;
      // Must match computeProjectionEmptyPreviewColor exactly: its stripe is
      // based on gl_FragCoord.x - gl_FragCoord.y, not x + y.
      const shaderCoordinate = (x - y) * 0.095;
      const stripePhase = shaderCoordinate - Math.floor(shaderCoordinate);
      const phaseBucket = Math.min(19, Math.floor(stripePhase * 20));
      phaseLuma[phaseBucket] += luma;
      phaseSamples[phaseBucket] += 1;

      if (x > 0 && candidate[current - 1] && !visited[current - 1]) {
        visited[current - 1] = 1;
        queue[tail++] = current - 1;
      }
      if (x < width - 1 && candidate[current + 1] && !visited[current + 1]) {
        visited[current + 1] = 1;
        queue[tail++] = current + 1;
      }
      if (y > 0 && candidate[current - width] && !visited[current - width]) {
        visited[current - width] = 1;
        queue[tail++] = current - width;
      }
      if (y < height - 1 && candidate[current + width] && !visited[current + width]) {
        visited[current + width] = 1;
        queue[tail++] = current + width;
      }
    }

    if (component.length < minComponentPixels) continue;
    // Render targets and screenshots can introduce a constant phase shift.
    // Test the 20 possible half-period splits while keeping the shader's
    // frequency and direction fixed.
    let stripeContrast = 0;
    for (let phaseOffset = 0; phaseOffset < 20; phaseOffset += 1) {
      let firstLuma = 0;
      let firstSamples = 0;
      let secondLuma = 0;
      let secondSamples = 0;
      for (let bucketOffset = 0; bucketOffset < 20; bucketOffset += 1) {
        const bucket = (phaseOffset + bucketOffset) % 20;
        if (bucketOffset < 10) {
          firstLuma += phaseLuma[bucket];
          firstSamples += phaseSamples[bucket];
        } else {
          secondLuma += phaseLuma[bucket];
          secondSamples += phaseSamples[bucket];
        }
      }
      if (firstSamples === 0 || secondSamples === 0) continue;
      stripeContrast = Math.max(
        stripeContrast,
        Math.abs(firstLuma / firstSamples - secondLuma / secondSamples),
      );
    }
    const exactToneRatio = (darkCorePixels + lightCorePixels) / component.length;
    const verifiedSmallGap =
      component.length >= minComponentPixels &&
      darkCorePixels > 0 &&
      lightCorePixels > 0 &&
      exactToneRatio >= 0.55;
    if (!verifiedSmallGap && stripeContrast < 10) continue;
    for (const pixel of component) mask.data[pixel] = 255;
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
