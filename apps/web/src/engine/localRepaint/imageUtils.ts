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

export function inferWhiteHoleMask(imageData: ImageData, objectMask: MaskBitmap) {
  const mask: MaskBitmap = { width: imageData.width, height: imageData.height, data: new Uint8ClampedArray(imageData.width * imageData.height) };
  for (let index = 0; index < mask.data.length; index += 1) {
    if ((objectMask.data[index] ?? 0) === 0) continue;
    const offset = index * 4;
    const red = imageData.data[offset];
    const green = imageData.data[offset + 1];
    const blue = imageData.data[offset + 2];
    const max = Math.max(red, green, blue);
    const min = Math.min(red, green, blue);
    if (max > 226 && max - min < 22) mask.data[index] = 255;
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
