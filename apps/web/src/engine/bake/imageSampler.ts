export type ImageSample = [number, number, number, number];

export async function loadImageData(url: string): Promise<ImageData> {
  const image = new Image();
  image.crossOrigin = 'anonymous';
  image.decoding = 'async';
  image.src = url;

  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error('Could not load projected layer image for baking.'));
  });

  const canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth || image.width;
  canvas.height = image.naturalHeight || image.height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('Could not create image sampling canvas.');
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
