type CompositeUvLayer =
  | { bitmap: ImageBitmap; opacity: number }
  | { imageUrl: string; opacity: number };

type CompositeUvRequest = {
  id: number;
  layers: CompositeUvLayer[];
};

type CompositeUvResponse =
  | { id: number; bitmap: ImageBitmap; width: number; height: number }
  | { id: number; error: string };

self.onmessage = async (event: MessageEvent<CompositeUvRequest>) => {
  const { id, layers } = event.data;
  const decodedBitmaps: ImageBitmap[] = [];
  try {
    const preparedLayers = await Promise.all(
      layers.map(async (layer) => {
        if ('bitmap' in layer) return layer;
        const response = await fetch(layer.imageUrl, { credentials: 'same-origin' });
        if (!response.ok) throw new Error(`UV layer request failed (${response.status}).`);
        const bitmap = await createImageBitmap(await response.blob(), {
          imageOrientation: 'none',
          premultiplyAlpha: 'none',
        });
        decodedBitmaps.push(bitmap);
        return { bitmap, opacity: layer.opacity };
      }),
    );
    const width = Math.max(1, ...preparedLayers.map(({ bitmap }) => bitmap.width || 1));
    const height = Math.max(1, ...preparedLayers.map(({ bitmap }) => bitmap.height || 1));
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Could not create the UV composition worker canvas.');

    context.clearRect(0, 0, width, height);
    // WebGL cannot apply UNPACK_FLIP_Y_WEBGL to ImageBitmap uploads. Compose
    // into the upload orientation directly, avoiding a second 4K/8K canvas and
    // a second full-resolution copy.
    context.translate(0, height);
    context.scale(1, -1);
    for (const { bitmap, opacity } of preparedLayers) {
      context.save();
      context.globalAlpha = Math.max(0, Math.min(1, opacity));
      context.globalCompositeOperation = 'source-over';
      context.drawImage(bitmap, 0, 0, width, height);
      context.restore();
      bitmap.close();
    }

    const bitmap = canvas.transferToImageBitmap();
    const response: CompositeUvResponse = { id, bitmap, width, height };
    self.postMessage(response, { transfer: [bitmap] });
  } catch (error) {
    for (const layer of layers) {
      if ('bitmap' in layer) layer.bitmap.close();
    }
    for (const bitmap of decodedBitmaps) bitmap.close();
    const response: CompositeUvResponse = {
      id,
      error: error instanceof Error ? error.message : String(error),
    };
    self.postMessage(response);
  }
};

export {};
