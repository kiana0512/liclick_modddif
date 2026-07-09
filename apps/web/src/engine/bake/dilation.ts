export function dilateImageData(imageData: ImageData, coverage: Uint8Array, iterations: number) {
  const { width, height, data } = imageData;
  let currentCoverage = new Uint8Array(coverage);
  let currentData = new Uint8ClampedArray(data);

  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const nextCoverage = new Uint8Array(currentCoverage);
    const nextData = new Uint8ClampedArray(currentData);
    let changed = false;

    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const index = y * width + x;
        if (currentCoverage[index]) continue;

        const neighbors = [
          [x - 1, y],
          [x + 1, y],
          [x, y - 1],
          [x, y + 1],
        ];

        const source = neighbors.find(([nx, ny]) => {
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) return false;
          return currentCoverage[ny * width + nx] > 0;
        });

        if (!source) continue;
        const [sx, sy] = source;
        const sourceOffset = (sy * width + sx) * 4;
        const targetOffset = index * 4;
        nextData[targetOffset] = currentData[sourceOffset];
        nextData[targetOffset + 1] = currentData[sourceOffset + 1];
        nextData[targetOffset + 2] = currentData[sourceOffset + 2];
        nextData[targetOffset + 3] = 255;
        nextCoverage[index] = 1;
        changed = true;
      }
    }

    currentCoverage = nextCoverage;
    currentData = nextData;
    if (!changed) break;
  }

  data.set(currentData);
  coverage.set(currentCoverage);
}
