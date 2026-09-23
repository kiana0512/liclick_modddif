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
  const ownedBitmaps = new Set(layers.flatMap((layer) => ('bitmap' in layer ? [layer.bitmap] : [])));
  const controller = new AbortController();
  let output: ImageBitmap | undefined;
  try {
    // Drain native decodes before replying on failure. Aborting fetches avoids
    // waiting for unrelated network work; already-started decodes still settle.
    const prepared = await Promise.allSettled(
      layers.map(async (layer) => {
        if ('bitmap' in layer) return layer;
        try {
          const response = await fetch(layer.imageUrl, {
            credentials: 'same-origin', signal: controller.signal,
          });
          if (!response.ok) throw new Error(`UV layer request failed (${response.status}).`);
          const bitmap = await createImageBitmap(await response.blob(), {
            imageOrientation: 'none',
            premultiplyAlpha: 'none',
          });
          ownedBitmaps.add(bitmap);
          return { bitmap, opacity: layer.opacity };
        } catch (error) {
          controller.abort(error);
          throw error;
        }
      }),
    );
    if (controller.signal.aborted) throw controller.signal.reason;
    const preparedLayers = prepared.map((result) => {
      if (result.status === 'rejected') throw result.reason;
      return result.value;
    });
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
      ownedBitmaps.delete(bitmap);
    }

    output = canvas.transferToImageBitmap();
    const response: CompositeUvResponse = { id, bitmap: output, width, height };
    self.postMessage(response, { transfer: [output] });
    output = undefined;
  } catch (error) {
    for (const bitmap of ownedBitmaps) bitmap.close();
    output?.close();
    const response: CompositeUvResponse = {
      id,
      error: error instanceof Error ? error.message : String(error),
    };
    self.postMessage(response);
  }
};

export {};
