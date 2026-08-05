export {};

type ProjectedTextureProfile = 'image' | 'mask' | 'depth' | 'normal';

type PackedSource = {
  bitmap?: ImageBitmap;
  previewWidth: number;
  previewHeight: number;
};

type PackRequest = {
  width: number;
  height: number;
  profile: ProjectedTextureProfile;
  sources: PackedSource[];
};

type PackResponse = { buffer: ArrayBuffer } | { error: string };

const workerScope = self as unknown as {
  onmessage: ((event: MessageEvent<PackRequest>) => void) | null;
  postMessage(message: PackResponse, transfer?: Transferable[]): void;
};

workerScope.onmessage = (event) => {
  const { width, height, profile, sources } = event.data;
  const sliceByteLength = width * height * 4;
  const textureData = new Uint8Array(sliceByteLength * sources.length);

  try {
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d', {
      alpha: true,
      willReadFrequently: true,
    });
    if (!context) throw new Error('Could not create the projected-array worker canvas.');
    context.imageSmoothingEnabled = profile !== 'depth' && profile !== 'normal';
    context.imageSmoothingQuality = 'high';

    for (let index = 0; index < sources.length; index += 1) {
      const source = sources[index];
      if (!source.bitmap) continue;
      context.clearRect(0, 0, width, height);
      context.drawImage(
        source.bitmap,
        0,
        0,
        source.bitmap.width,
        source.bitmap.height,
        0,
        0,
        source.previewWidth,
        source.previewHeight,
      );
      textureData.set(
        context.getImageData(0, 0, width, height).data,
        index * sliceByteLength,
      );
      source.bitmap.close();
    }

    workerScope.postMessage({ buffer: textureData.buffer }, [textureData.buffer]);
  } catch (error) {
    sources.forEach((source) => source.bitmap?.close());
    workerScope.postMessage({
      error: error instanceof Error ? error.message : 'Could not pack projected textures.',
    });
  }
};
