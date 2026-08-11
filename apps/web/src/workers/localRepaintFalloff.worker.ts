type FalloffRequest = {
  id: number;
  mask: ImageBitmap;
  width: number;
  height: number;
};

type FalloffResponse =
  | { id: number; bitmap: ImageBitmap; processMs: number }
  | { id: number; error: string };

self.onmessage = (event: MessageEvent<FalloffRequest>) => {
  const { id, mask, width, height } = event.data;
  const startedAt = performance.now();
  try {
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('Could not create local repaint falloff canvas.');
    context.clearRect(0, 0, width, height);
    context.drawImage(mask, 0, 0, width, height);
    const source = context.getImageData(0, 0, width, height);
    let weightTotal = 0;
    let weightedX = 0;
    let weightedY = 0;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const offset = (y * width + x) * 4;
        const weight =
          (Math.max(source.data[offset], source.data[offset + 1], source.data[offset + 2]) /
            255) *
          (source.data[offset + 3] / 255);
        if (weight <= 0.03) continue;
        weightTotal += weight;
        weightedX += x * weight;
        weightedY += y * weight;
      }
    }

    if (weightTotal > 0) {
      const centerX = weightedX / weightTotal;
      const centerY = weightedY / weightTotal;
      let coreRadius = 1;
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          const offset = (y * width + x) * 4;
          const coverage =
            (Math.max(source.data[offset], source.data[offset + 1], source.data[offset + 2]) /
              255) *
            (source.data[offset + 3] / 255);
          if (coverage <= 0.03) continue;
          coreRadius = Math.max(coreRadius, Math.hypot(x - centerX, y - centerY));
        }
      }
      const farthestCornerRadius = Math.max(
        Math.hypot(centerX, centerY),
        Math.hypot(width - 1 - centerX, centerY),
        Math.hypot(centerX, height - 1 - centerY),
        Math.hypot(width - 1 - centerX, height - 1 - centerY),
      );
      const fadeEndRadius = Math.max(coreRadius + 1, farthestCornerRadius * 1.2);
      const expansionRadius = fadeEndRadius - coreRadius;
      const output = context.createImageData(width, height);
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          const distance = Math.hypot(x - centerX, y - centerY);
          const linearFade = Math.max(
            0,
            Math.min(1, (fadeEndRadius - distance) / Math.max(expansionRadius, 1)),
          );
          const opacity = linearFade * linearFade * (3 - 2 * linearFade);
          const offset = (y * width + x) * 4;
          output.data[offset] = 255;
          output.data[offset + 1] = 255;
          output.data[offset + 2] = 255;
          output.data[offset + 3] = Math.round(opacity * 255);
        }
      }
      context.putImageData(output, 0, 0);
    } else {
      context.clearRect(0, 0, width, height);
    }

    const bitmap = canvas.transferToImageBitmap();
    const response: FalloffResponse = {
      id,
      bitmap,
      processMs: performance.now() - startedAt,
    };
    self.postMessage(response, { transfer: [bitmap] });
  } catch (error) {
    const response: FalloffResponse = {
      id,
      error: error instanceof Error ? error.message : String(error),
    };
    self.postMessage(response);
  } finally {
    mask.close();
  }
};

export {};
