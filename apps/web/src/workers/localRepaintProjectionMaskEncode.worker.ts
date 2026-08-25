type ProjectionMaskEncodeRequest = {
  id: number;
  bitmap: ImageBitmap;
};

self.onmessage = async (event: MessageEvent<ProjectionMaskEncodeRequest>) => {
  const { id, bitmap } = event.data;
  const startedAt = performance.now();
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('Could not create projection mask encode canvas.');
    context.fillStyle = '#000000';
    context.fillRect(0, 0, bitmap.width, bitmap.height);
    context.drawImage(bitmap, 0, 0);
    const image = context.getImageData(0, 0, bitmap.width, bitmap.height);
    for (let index = 0; index < image.data.length; index += 4) {
      const value = Math.max(image.data[index], image.data[index + 1], image.data[index + 2]);
      image.data[index] = value;
      image.data[index + 1] = value;
      image.data[index + 2] = value;
      image.data[index + 3] = 255;
    }
    context.putImageData(image, 0, 0);
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    self.postMessage({ id, blob, processMs: performance.now() - startedAt });
  } catch (error) {
    self.postMessage({
      id,
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    bitmap.close();
  }
};

export {};
