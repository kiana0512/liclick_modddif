export function getUvDilationPixels(resolution: number, requestedPixels: number) {
  return Math.min(32, Math.max(requestedPixels, Math.ceil(resolution / 256)));
}

export function dilateImageData(imageData: ImageData, coverage: Uint8Array, iterations: number) {
  const { width, height, data } = imageData;
  const currentCoverage = coverage;
  const currentData = data;

  if (iterations <= 0) return;

  const pixelCount = width * height;
  const sourceSeeds = new Int32Array(pixelCount);
  const pendingSeeds = new Int32Array(pixelCount);
  const frontier: number[] = [];
  const neighborOffsets = [
    [-1, -1], [0, -1], [1, -1],
    [-1, 0],            [1, 0],
    [-1, 1],  [0, 1],  [1, 1],
  ] as const;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      if (!currentCoverage[index]) continue;
      sourceSeeds[index] = index + 1;
      if (
        (x > 0 && !currentCoverage[index - 1]) ||
        (x < width - 1 && !currentCoverage[index + 1]) ||
        (y > 0 && !currentCoverage[index - width]) ||
        (y < height - 1 && !currentCoverage[index + width])
      ) {
        frontier.push(index);
      }
    }
  }

  let currentFrontier = frontier;
  for (let iteration = 0; iteration < iterations && currentFrontier.length > 0; iteration += 1) {
    const touched: number[] = [];

    for (const index of currentFrontier) {
      const x = index % width;
      const y = Math.floor(index / width);
      const seedValue = sourceSeeds[index];
      if (!seedValue) continue;
      const seedIndex = seedValue - 1;
      const seedX = seedIndex % width;
      const seedY = Math.floor(seedIndex / width);

      for (const [offsetX, offsetY] of neighborOffsets) {
        const nextX = x + offsetX;
        const nextY = y + offsetY;
        if (nextX < 0 || nextX >= width || nextY < 0 || nextY >= height) continue;
        const nextIndex = nextY * width + nextX;
        if (currentCoverage[nextIndex]) continue;

        const candidateDistance =
          (nextX - seedX) * (nextX - seedX) + (nextY - seedY) * (nextY - seedY);
        const previousSeedValue = pendingSeeds[nextIndex];
        if (previousSeedValue) {
          const previousSeedIndex = previousSeedValue - 1;
          const previousSeedX = previousSeedIndex % width;
          const previousSeedY = Math.floor(previousSeedIndex / width);
          const previousDistance =
            (nextX - previousSeedX) * (nextX - previousSeedX) +
            (nextY - previousSeedY) * (nextY - previousSeedY);
          if (candidateDistance >= previousDistance) continue;
        } else {
          touched.push(nextIndex);
        }
        pendingSeeds[nextIndex] = seedValue;
      }
    }

    const nextFrontier: number[] = [];
    for (const index of touched) {
      const seedValue = pendingSeeds[index];
      pendingSeeds[index] = 0;
      if (!seedValue || currentCoverage[index]) continue;
      const seedIndex = seedValue - 1;
      const sourceOffset = seedIndex * 4;
      const targetOffset = index * 4;
      currentData[targetOffset] = currentData[sourceOffset];
      currentData[targetOffset + 1] = currentData[sourceOffset + 1];
      currentData[targetOffset + 2] = currentData[sourceOffset + 2];
      currentData[targetOffset + 3] = 255;
      currentCoverage[index] = 1;
      sourceSeeds[index] = seedValue;
      nextFrontier.push(index);
    }
    currentFrontier = nextFrontier;
  }
}
