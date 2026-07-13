export function dilateImageData(imageData: ImageData, coverage: Uint8Array, iterations: number) {
  const { width, height, data } = imageData;
  let currentCoverage = new Uint8Array(coverage);
  let currentData = new Uint8ClampedArray(data);

  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const nextCoverage = new Uint8Array(currentCoverage);
    const nextData = new Uint8ClampedArray(currentData);
    let changed = false;

    for (let y = 0; y < height; y += 1) {
      const rowOffset = y * width;
      for (let x = 0; x < width; x += 1) {
        const index = rowOffset + x;
        if (currentCoverage[index]) continue;

        let sourceIndex = -1;
        if (x > 0 && currentCoverage[index - 1] > 0) sourceIndex = index - 1;
        else if (x < width - 1 && currentCoverage[index + 1] > 0) sourceIndex = index + 1;
        else if (y > 0 && currentCoverage[index - width] > 0) sourceIndex = index - width;
        else if (y < height - 1 && currentCoverage[index + width] > 0) sourceIndex = index + width;
        if (sourceIndex < 0) continue;

        const sourceOffset = sourceIndex * 4;
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
