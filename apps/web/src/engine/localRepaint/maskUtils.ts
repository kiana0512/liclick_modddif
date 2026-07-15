import type { MaskBitmap, Rect } from '@/types/localRepaint';

const diskOffsetCache = new Map<number, Array<[number, number]>>();

function getDiskOffsets(radius: number) {
  const r = Math.max(0, Math.floor(radius));
  const cached = diskOffsetCache.get(r);
  if (cached) return cached;
  const offsets: Array<[number, number]> = [];
  for (let oy = -r; oy <= r; oy += 1) {
    for (let ox = -r; ox <= r; ox += 1) {
      if (ox * ox + oy * oy <= r * r) offsets.push([ox, oy]);
    }
  }
  diskOffsetCache.set(r, offsets);
  return offsets;
}

export function createEmptyMask(width: number, height: number, value = 0): MaskBitmap {
  return { width, height, data: new Uint8ClampedArray(width * height).fill(value) };
}

export function createFullMask(width: number, height: number): MaskBitmap {
  return createEmptyMask(width, height, 255);
}

export function cloneMask(mask: MaskBitmap): MaskBitmap {
  return { width: mask.width, height: mask.height, data: new Uint8ClampedArray(mask.data) };
}

export function buildEditMask(
  userMask: MaskBitmap,
  holeMask: MaskBitmap,
  options: { includeBlankArea: boolean; dilationRadius: number },
) {
  const editMask = createEmptyMask(userMask.width, userMask.height);
  for (let index = 0; index < editMask.data.length; index += 1) {
    editMask.data[index] = Math.max(userMask.data[index] ?? 0, options.includeBlankArea ? (holeMask.data[index] ?? 0) : 0);
  }
  return options.dilationRadius > 0 ? dilateMask(editMask, options.dilationRadius) : editMask;
}

export function removeSmallMaskComponents(mask: MaskBitmap, minPixels: number) {
  const output = createEmptyMask(mask.width, mask.height);
  const visited = new Uint8Array(mask.data.length);
  const queue = new Int32Array(mask.data.length);
  const component: number[] = [];
  const minimum = Math.max(1, Math.floor(minPixels));

  for (let index = 0; index < mask.data.length; index += 1) {
    if (visited[index] || (mask.data[index] ?? 0) === 0) continue;
    let head = 0;
    let tail = 0;
    component.length = 0;
    queue[tail] = index;
    tail += 1;
    visited[index] = 1;

    while (head < tail) {
      const current = queue[head];
      head += 1;
      component.push(current);
      const x = current % mask.width;
      const y = Math.floor(current / mask.width);
      if (x > 0) {
        const neighbor = current - 1;
        if (!visited[neighbor] && (mask.data[neighbor] ?? 0) > 0) {
          visited[neighbor] = 1;
          queue[tail] = neighbor;
          tail += 1;
        }
      }
      if (x < mask.width - 1) {
        const neighbor = current + 1;
        if (!visited[neighbor] && (mask.data[neighbor] ?? 0) > 0) {
          visited[neighbor] = 1;
          queue[tail] = neighbor;
          tail += 1;
        }
      }
      if (y > 0) {
        const neighbor = current - mask.width;
        if (!visited[neighbor] && (mask.data[neighbor] ?? 0) > 0) {
          visited[neighbor] = 1;
          queue[tail] = neighbor;
          tail += 1;
        }
      }
      if (y < mask.height - 1) {
        const neighbor = current + mask.width;
        if (!visited[neighbor] && (mask.data[neighbor] ?? 0) > 0) {
          visited[neighbor] = 1;
          queue[tail] = neighbor;
          tail += 1;
        }
      }
    }

    if (component.length >= minimum) {
      for (const pixel of component) output.data[pixel] = 255;
    }
  }

  return output;
}

export function buildProtectMask(objectMask: MaskBitmap, editMask: MaskBitmap) {
  const protectMask = createEmptyMask(objectMask.width, objectMask.height);
  for (let index = 0; index < protectMask.data.length; index += 1) {
    protectMask.data[index] = objectMask.data[index] > 0 && editMask.data[index] === 0 ? 255 : 0;
  }
  return protectMask;
}

export function dilateMask(mask: MaskBitmap, radius: number) {
  const output = createEmptyMask(mask.width, mask.height);
  const offsets = getDiskOffsets(radius);
  for (let y = 0; y < mask.height; y += 1) {
    const rowOffset = y * mask.width;
    for (let x = 0; x < mask.width; x += 1) {
      if (mask.data[rowOffset + x] <= 0) continue;
      for (let offsetIndex = 0; offsetIndex < offsets.length; offsetIndex += 1) {
        const [ox, oy] = offsets[offsetIndex];
        const sx = x + ox;
        const sy = y + oy;
        if (sx < 0 || sy < 0 || sx >= mask.width || sy >= mask.height) continue;
        output.data[sy * mask.width + sx] = 255;
      }
    }
  }
  return output;
}

export function featherMask(mask: MaskBitmap, radius: number) {
  const r = Math.max(0, Math.floor(radius));
  if (r <= 0) return cloneMask(mask);
  const temp = new Float32Array(mask.data.length);
  const output = createEmptyMask(mask.width, mask.height);
  const kernelSize = r * 2 + 1;
  for (let y = 0; y < mask.height; y += 1) {
    for (let x = 0; x < mask.width; x += 1) {
      let total = 0;
      let count = 0;
      for (let ox = -r; ox <= r; ox += 1) {
        const sx = Math.max(0, Math.min(mask.width - 1, x + ox));
        total += mask.data[y * mask.width + sx];
        count += 1;
      }
      temp[y * mask.width + x] = total / count;
    }
  }
  for (let y = 0; y < mask.height; y += 1) {
    for (let x = 0; x < mask.width; x += 1) {
      let total = 0;
      for (let oy = -r; oy <= r; oy += 1) {
        const sy = Math.max(0, Math.min(mask.height - 1, y + oy));
        total += temp[sy * mask.width + x];
      }
      output.data[y * mask.width + x] = Math.round(total / kernelSize);
    }
  }
  return output;
}

export function computeMaskBoundingBox(mask: MaskBitmap): Rect | undefined {
  let minX = mask.width;
  let minY = mask.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < mask.height; y += 1) {
    for (let x = 0; x < mask.width; x += 1) {
      if (mask.data[y * mask.width + x] === 0) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  if (maxX < minX || maxY < minY) return undefined;
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

export function expandRect(rect: Rect, padding: number, imageBounds: { width: number; height: number }): Rect {
  const x = Math.max(0, rect.x - padding);
  const y = Math.max(0, rect.y - padding);
  const maxX = Math.min(imageBounds.width, rect.x + rect.w + padding);
  const maxY = Math.min(imageBounds.height, rect.y + rect.h + padding);
  return { x, y, w: maxX - x, h: maxY - y };
}

export function cropMask(mask: MaskBitmap, rect: Rect): MaskBitmap {
  const output = createEmptyMask(rect.w, rect.h);
  for (let y = 0; y < rect.h; y += 1) {
    for (let x = 0; x < rect.w; x += 1) {
      output.data[y * rect.w + x] = mask.data[(rect.y + y) * mask.width + rect.x + x];
    }
  }
  return output;
}

export function maskToBlob(mask: MaskBitmap) {
  const canvas = document.createElement('canvas');
  canvas.width = mask.width;
  canvas.height = mask.height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Could not create mask canvas.');
  const imageData = context.createImageData(mask.width, mask.height);
  for (let index = 0; index < mask.data.length; index += 1) {
    const offset = index * 4;
    const value = mask.data[index];
    imageData.data[offset] = value;
    imageData.data[offset + 1] = value;
    imageData.data[offset + 2] = value;
    imageData.data[offset + 3] = 255;
  }
  context.putImageData(imageData, 0, 0);
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Could not encode mask.'))), 'image/png');
  });
}
