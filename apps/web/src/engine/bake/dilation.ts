import * as THREE from 'three';

export function getUvDilationPixels(resolution: number, requestedPixels: number) {
  return Math.min(32, Math.max(requestedPixels, Math.ceil(resolution / 256)));
}

export function rasterizeUvTopologyMask(
  root: THREE.Object3D,
  width: number,
  height: number,
) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('Could not create UV topology mask.');
  context.fillStyle = '#ffffff';

  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    const geometry = object.geometry;
    const uv = geometry.getAttribute('uv');
    if (!uv) return;
    const index = geometry.getIndex();
    const triangleCount = index ? index.count / 3 : uv.count / 3;
    for (let triangle = 0; triangle < triangleCount; triangle += 1) {
      const vertexIndices = [0, 1, 2].map((offset) =>
        index ? index.getX(triangle * 3 + offset) : triangle * 3 + offset,
      );
      const points = vertexIndices.map((vertexIndex) => ({
        x: uv.getX(vertexIndex) * (width - 1),
        y: (1 - uv.getY(vertexIndex)) * (height - 1),
      }));
      if (points.some((point) => !Number.isFinite(point.x) || !Number.isFinite(point.y))) continue;
      context.beginPath();
      context.moveTo(points[0].x, points[0].y);
      context.lineTo(points[1].x, points[1].y);
      context.lineTo(points[2].x, points[2].y);
      context.closePath();
      context.fill();
    }
  });

  const alpha = context.getImageData(0, 0, width, height).data;
  const topology = new Uint8Array(width * height);
  for (let index = 0; index < topology.length; index += 1) {
    // Match the pixel-centre coverage used by WebGL rasterization. Treating
    // every faint canvas anti-aliasing sample as model topology creates a
    // one-pixel no-man's-land: the bake does not cover it, while gutter padding
    // refuses to write it. Linear texture filtering then exposes that transparent
    // ring as a bright crack along every UV island.
    topology[index] = alpha[index * 4 + 3] >= 128 ? 1 : 0;
  }
  return topology;
}

function expandBinaryMask(mask: Uint8Array, width: number, height: number, iterations: number) {
  let current = mask.slice();
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const next = current.slice();
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const index = y * width + x;
        if (current[index]) continue;
        for (let offsetY = -1; offsetY <= 1 && !next[index]; offsetY += 1) {
          const neighborY = y + offsetY;
          if (neighborY < 0 || neighborY >= height) continue;
          for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
            if (offsetX === 0 && offsetY === 0) continue;
            const neighborX = x + offsetX;
            if (neighborX < 0 || neighborX >= width) continue;
            if (current[neighborY * width + neighborX]) {
              next[index] = 1;
              break;
            }
          }
        }
      }
    }
    current = next;
  }
  return current;
}

/**
 * Pads only the atlas gutter immediately outside UV islands. Unlike ordinary
 * dilation, this never writes into an unprojected texel that belongs to a model
 * surface, so transparent/occluded content remains transparent.
 */
export function padUvIslandGutters(
  imageData: ImageData,
  coverage: Uint8Array,
  root: THREE.Object3D,
  iterations: number,
  preserveSourceAlpha = false,
) {
  const { width, height, data } = imageData;
  if (iterations <= 0) return 0;
  const topology = rasterizeUvTopologyMask(root, width, height);
  const paddedTopology = expandBinaryMask(topology, width, height, iterations);
  const neighborOffsets = [
    [-1, -1], [0, -1], [1, -1],
    [-1, 0],            [1, 0],
    [-1, 1],  [0, 1],  [1, 1],
  ] as const;
  let currentFrontier: number[] = [];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      if (!coverage[index]) continue;
      const touchesAtlasGutter = neighborOffsets.some(([offsetX, offsetY]) => {
        const neighborX = x + offsetX;
        const neighborY = y + offsetY;
        if (neighborX < 0 || neighborX >= width || neighborY < 0 || neighborY >= height)
          return false;
        const neighborIndex = neighborY * width + neighborX;
        return !topology[neighborIndex] && Boolean(paddedTopology[neighborIndex]);
      });
      if (touchesAtlasGutter) currentFrontier.push(index);
    }
  }
  let paddedPixels = 0;

  for (let iteration = 0; iteration < iterations && currentFrontier.length > 0; iteration += 1) {
    const pending = new Map<number, number>();
    for (const sourceIndex of currentFrontier) {
      const sourceX = sourceIndex % width;
      const sourceY = Math.floor(sourceIndex / width);
      for (const [offsetX, offsetY] of neighborOffsets) {
        const x = sourceX + offsetX;
        const y = sourceY + offsetY;
        if (x < 0 || x >= width || y < 0 || y >= height) continue;
        const targetIndex = y * width + x;
        if (
          coverage[targetIndex] ||
          topology[targetIndex] ||
          !paddedTopology[targetIndex] ||
          pending.has(targetIndex)
        )
          continue;
        pending.set(targetIndex, sourceIndex);
      }
    }

    const nextFrontier: number[] = [];
    pending.forEach((sourceIndex, targetIndex) => {
      const sourceOffset = sourceIndex * 4;
      const targetOffset = targetIndex * 4;
      data[targetOffset] = data[sourceOffset];
      data[targetOffset + 1] = data[sourceOffset + 1];
      data[targetOffset + 2] = data[sourceOffset + 2];
      // Gutter texels are outside all model UV triangles and cannot paint an
      // actual surface. Transparent overlays must nevertheless retain their
      // feathered source alpha: forcing these pixels opaque creates a contour
      // when bilinear filtering samples across the UV-island border.
      data[targetOffset + 3] = preserveSourceAlpha ? data[sourceOffset + 3] : 255;
      coverage[targetIndex] = 1;
      nextFrontier.push(targetIndex);
      paddedPixels += 1;
    });
    currentFrontier = nextFrontier;
  }
  return paddedPixels;
}

export function dilateImageData(
  imageData: ImageData,
  coverage: Uint8Array,
  iterations: number,
  targetMask?: Uint8Array,
  preserveSourceAlpha = false,
) {
  const { width, height, data } = imageData;
  const currentCoverage = coverage;
  const currentData = data;

  if (iterations <= 0) return 0;

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
  let filledPixels = 0;
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
        if (currentCoverage[nextIndex] || (targetMask && !targetMask[nextIndex])) continue;

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
      // Topology repair for transparent overlays must extend the source
      // coverage continuously. Forcing a soft boundary seed to opaque creates
      // a full-strength ring outside a partial-alpha texel, which appears as a
      // dark seam after the mask is composited.
      currentData[targetOffset + 3] = preserveSourceAlpha
        ? currentData[sourceOffset + 3]
        : 255;
      currentCoverage[index] = 1;
      sourceSeeds[index] = seedValue;
      nextFrontier.push(index);
      filledPixels += 1;
    }
    currentFrontier = nextFrontier;
  }
  return filledPixels;
}

/** Expands projected color only across texels occupied by model UV triangles. */
export function dilateUvCoverageWithinTopology(
  imageData: ImageData,
  coverage: Uint8Array,
  root: THREE.Object3D,
  iterations: number,
) {
  if (iterations <= 0) return 0;
  const topology = rasterizeUvTopologyMask(root, imageData.width, imageData.height);
  return dilateImageData(imageData, coverage, iterations, topology, true);
}
