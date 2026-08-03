import * as THREE from 'three';

export function getUvDilationPixels(resolution: number, requestedPixels: number) {
  return Math.min(32, Math.max(requestedPixels, Math.ceil(resolution / 256)));
}

export type UvGutterAlphaMode = boolean | 'rgb-only';

const COMPONENT_QUEUE_CHUNK_SIZE = 65_536;
const MIN_UV_REPAIR_SOURCE_ALPHA = 8;
const MAX_TOPOLOGY_PINHOLE_RGB_DISTANCE_SQUARED = 64 * 64;

function getRgbDistanceSquared(data: Uint8ClampedArray, first: number, second: number) {
  const firstOffset = first * 4;
  const secondOffset = second * 4;
  const red = data[firstOffset] - data[secondOffset];
  const green = data[firstOffset + 1] - data[secondOffset + 1];
  const blue = data[firstOffset + 2] - data[secondOffset + 2];
  return red * red + green * green + blue * blue;
}

/**
 * A compact grow-only queue for high-resolution atlases. A normal number[] can
 * use several times more memory per texel, while allocating width * height up
 * front is wasteful for the small enclosed holes this pass normally sees.
 */
class ChunkedUint32Queue {
  private readonly chunks: Uint32Array[] = [];

  length = 0;

  clear() {
    this.length = 0;
  }

  push(value: number) {
    const chunkIndex = Math.floor(this.length / COMPONENT_QUEUE_CHUNK_SIZE);
    const chunkOffset = this.length % COMPONENT_QUEUE_CHUNK_SIZE;
    let chunk = this.chunks[chunkIndex];
    if (!chunk) {
      chunk = new Uint32Array(COMPONENT_QUEUE_CHUNK_SIZE);
      this.chunks.push(chunk);
    }
    chunk[chunkOffset] = value;
    this.length += 1;
  }

  get(index: number) {
    if (index < 0 || index >= this.length) {
      throw new RangeError('UV component queue index is out of bounds.');
    }
    return this.chunks[Math.floor(index / COMPONENT_QUEUE_CHUNK_SIZE)][
      index % COMPONENT_QUEUE_CHUNK_SIZE
    ];
  }

  set(index: number, value: number) {
    if (index < 0 || index >= this.length) {
      throw new RangeError('UV component queue index is out of bounds.');
    }
    this.chunks[Math.floor(index / COMPONENT_QUEUE_CHUNK_SIZE)][
      index % COMPONENT_QUEUE_CHUNK_SIZE
    ] = value;
  }

  truncate(length: number) {
    if (length < 0 || length > this.length) {
      throw new RangeError('UV component queue length is out of bounds.');
    }
    this.length = length;
  }
}

export function rasterizeUvTopologyMask(
  root: THREE.Object3D,
  width: number,
  height: number,
  coverageMode: 'pixel-center' | 'conservative' = 'pixel-center',
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
  const alphaThreshold = coverageMode === 'conservative' ? 1 : 128;
  for (let index = 0; index < topology.length; index += 1) {
    // Gutter padding needs pixel-centre coverage so a faint anti-aliasing fringe
    // cannot become a no-man's-land outside the island. Hole repair has the
    // opposite requirement: high-poly atlases contain many sub-pixel triangles,
    // and dropping their faint samples breaks the topology into pepper-like
    // gaps. Keep these two masks distinct instead of trading one artifact for
    // the other.
    topology[index] = alpha[index * 4 + 3] >= alphaThreshold ? 1 : 0;
  }
  return topology;
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
  alphaMode: UvGutterAlphaMode = false,
) {
  const topology = rasterizeUvTopologyMask(root, imageData.width, imageData.height);
  return padUvIslandGuttersWithTopology(
    imageData,
    coverage,
    topology,
    iterations,
    alphaMode,
  );
}

/**
 * Pure topology-mask variant used by the bake pipeline and focused tests.
 * `true` retains the historical source-alpha behavior. `rgb-only` is intended
 * for transparent overlays: it stores filter padding in RGB while keeping the
 * texel fully transparent, so the gutter cannot paint a model surface.
 */
export function padUvIslandGuttersWithTopology(
  imageData: ImageData,
  coverage: Uint8Array,
  topology: Uint8Array,
  iterations: number,
  alphaMode: UvGutterAlphaMode = false,
) {
  const { width, height, data } = imageData;
  if (iterations <= 0) return 0;
  if (topology.length !== width * height || coverage.length !== width * height) {
    throw new Error('UV gutter masks must match the image dimensions.');
  }
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
        return !topology[neighborIndex];
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
      // actual surface. Transparent overlays keep useful RGB for bilinear
      // filtering while remaining alpha-zero. Coverage value 2 tags those
      // texels so the later weak-alpha cleanup does not erase their RGB.
      data[targetOffset + 3] =
        alphaMode === 'rgb-only'
          ? 0
          : alphaMode
            ? data[sourceOffset + 3]
            : 255;
      coverage[targetIndex] = alphaMode === 'rgb-only' ? 2 : 1;
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
  // Conservative coverage includes every triangle touched by the pixel. This is
  // deliberately used only for filling missing model texels; atlas-gutter
  // padding continues to use the stricter pixel-centre mask above.
  const topology = rasterizeUvTopologyMask(
    root,
    imageData.width,
    imageData.height,
    'conservative',
  );
  return dilateImageData(imageData, coverage, iterations, topology, true);
}

/**
 * Fills complete connected holes that are enclosed by existing coverage inside
 * one UV island. A blank component that touches the island boundary is left
 * untouched, so this cannot paint an unprojected surface or jump between UV
 * islands. Accepted components use a multi-source breadth-first fill from all
 * neighbouring covered texels, giving a nearest-donor result in O(N).
 */
export function fillEnclosedUvCoverageGaps(
  imageData: ImageData,
  coverage: Uint8Array,
  topology: Uint8Array,
  enabled: number,
  regionIds?: Uint32Array,
) {
  const { width, height, data } = imageData;
  if (enabled <= 0) return 0;
  if (topology.length !== width * height || coverage.length !== width * height) {
    throw new Error('UV interior-repair masks must match the image dimensions.');
  }
  if (regionIds && regionIds.length !== width * height) {
    throw new Error('UV interior-repair region ids must match the image dimensions.');
  }

  // Transparent output cleanup uses the same alpha cutoff. Reclassify weak
  // samples before topology analysis so they cannot masquerade as covered
  // texels and then disappear only after the repair has already skipped them.
  for (let index = 0; index < coverage.length; index += 1) {
    if (
      !topology[index] ||
      coverage[index] !== 1 ||
      data[index * 4 + 3] > MIN_UV_REPAIR_SOURCE_ALPHA
    )
      continue;
    coverage[index] = 0;
    const offset = index * 4;
    data[offset] = 0;
    data[offset + 1] = 0;
    data[offset + 2] = 0;
    data[offset + 3] = 0;
  }

  const componentOffsets = [
    [-1, 0],
    [1, 0],
    [0, -1],
    [0, 1],
  ] as const;
  const neighborOffsets = [
    [-1, -1], [0, -1], [1, -1],
    [-1, 0],            [1, 0],
    [-1, 1],  [0, 1],  [1, 1],
  ] as const;
  const component = new ChunkedUint32Queue();
  const seedPixels = new ChunkedUint32Queue();
  const seedDonors = new ChunkedUint32Queue();
  let filledPixels = 0;

  // coverage=3 marks a rejected/in-progress blank component, while coverage=4
  // marks a newly repaired texel. Keeping these temporary states in the caller's
  // mask avoids another full-resolution allocation at 4K/8K.
  const rejectedMarker = 3;
  const filledMarker = 4;

  for (let startIndex = 0; startIndex < coverage.length; startIndex += 1) {
    if (!topology[startIndex] || coverage[startIndex] !== 0) continue;

    component.clear();
    component.push(startIndex);
    coverage[startIndex] = rejectedMarker;
    let touchesTopologyBoundary = false;

    for (let cursor = 0; cursor < component.length; cursor += 1) {
      const index = component.get(cursor);
      const x = index % width;
      const y = Math.floor(index / width);

      for (const [offsetX, offsetY] of neighborOffsets) {
        const neighborX = x + offsetX;
        const neighborY = y + offsetY;
        if (
          neighborX < 0 ||
          neighborX >= width ||
          neighborY < 0 ||
          neighborY >= height
        ) {
          touchesTopologyBoundary = true;
          continue;
        }
        if (!topology[neighborY * width + neighborX]) {
          touchesTopologyBoundary = true;
        }
      }

      for (const [offsetX, offsetY] of componentOffsets) {
        const neighborX = x + offsetX;
        const neighborY = y + offsetY;
        if (
          neighborX < 0 ||
          neighborX >= width ||
          neighborY < 0 ||
          neighborY >= height
        )
          continue;
        const neighborIndex = neighborY * width + neighborX;
        if (topology[neighborIndex] && coverage[neighborIndex] === 0) {
          coverage[neighborIndex] = rejectedMarker;
          component.push(neighborIndex);
        }
      }
    }

    if (touchesTopologyBoundary) continue;

    seedPixels.clear();
    seedDonors.clear();
    for (let cursor = 0; cursor < component.length; cursor += 1) {
      const index = component.get(cursor);
      const x = index % width;
      const y = Math.floor(index / width);
      let bestDonor = -1;
      let bestAlpha = 0;

      for (const [offsetX, offsetY] of neighborOffsets) {
        const neighborX = x + offsetX;
        const neighborY = y + offsetY;
        if (
          neighborX < 0 ||
          neighborX >= width ||
          neighborY < 0 ||
          neighborY >= height
        )
          continue;
        const neighborIndex = neighborY * width + neighborX;
        // Only original covered texels can seed a repair. In particular, a
        // newly filled component must never cascade into a diagonal neighbour.
        if (!topology[neighborIndex] || coverage[neighborIndex] !== 1)
          continue;
        const alpha = data[neighborIndex * 4 + 3];
        if (alpha > MIN_UV_REPAIR_SOURCE_ALPHA && alpha > bestAlpha) {
          bestAlpha = alpha;
          bestDonor = neighborIndex;
        }
      }

      if (bestDonor >= 0) {
        seedPixels.push(index);
        seedDonors.push(bestDonor);
      }
    }

    if (seedPixels.length === 0) continue;

    component.clear();
    for (let seedIndex = 0; seedIndex < seedPixels.length; seedIndex += 1) {
      const targetIndex = seedPixels.get(seedIndex);
      const donorIndex = seedDonors.get(seedIndex);
      const sourceOffset = donorIndex * 4;
      const targetOffset = targetIndex * 4;
      data[targetOffset] = data[sourceOffset];
      data[targetOffset + 1] = data[sourceOffset + 1];
      data[targetOffset + 2] = data[sourceOffset + 2];
      data[targetOffset + 3] = data[sourceOffset + 3];
      coverage[targetIndex] = filledMarker;
      component.push(targetIndex);
      filledPixels += 1;
    }

    for (let cursor = 0; cursor < component.length; cursor += 1) {
      const sourceIndex = component.get(cursor);
      const sourceX = sourceIndex % width;
      const sourceY = Math.floor(sourceIndex / width);
      for (const [offsetX, offsetY] of componentOffsets) {
        const neighborX = sourceX + offsetX;
        const neighborY = sourceY + offsetY;
        if (
          neighborX < 0 ||
          neighborX >= width ||
          neighborY < 0 ||
          neighborY >= height
        )
          continue;
        const targetIndex = neighborY * width + neighborX;
        if (coverage[targetIndex] !== rejectedMarker) continue;
        const sourceOffset = sourceIndex * 4;
        const targetOffset = targetIndex * 4;
        data[targetOffset] = data[sourceOffset];
        data[targetOffset + 1] = data[sourceOffset + 1];
        data[targetOffset + 2] = data[sourceOffset + 2];
        data[targetOffset + 3] = data[sourceOffset + 3];
        coverage[targetIndex] = filledMarker;
        component.push(targetIndex);
        filledPixels += 1;
      }
    }
  }

  for (let index = 0; index < coverage.length; index += 1) {
    if (coverage[index] === rejectedMarker) coverage[index] = 0;
    else if (coverage[index] === filledMarker) coverage[index] = 1;
  }

  // A high-poly UV raster can leave one-pixel diagonal cracks that remain
  // connected to an island boundary through the triangle-edge network. They
  // are not closed components, so repair only pixels that have strong covered
  // donors on two opposite sides. This closes narrow internal cracks without
  // growing into a one-sided blank surface or the atlas space between islands.
  const crackDirectionPairs = [
    [[-1, 0], [1, 0]],
    [[0, -1], [0, 1]],
    [[-1, -1], [1, 1]],
    [[1, -1], [-1, 1]],
  ] as const;
  const crackRadius = Math.min(3, Math.max(1, Math.ceil(enabled)));
  for (let pass = 0; pass < crackRadius; pass += 1) {
    seedPixels.clear();
    seedDonors.clear();

    for (let index = 0; index < coverage.length; index += 1) {
      if (coverage[index] !== 0) continue;
      const x = index % width;
      const y = Math.floor(index / width);
      // Canvas antialiasing can very occasionally miss one topology texel at a
      // high-poly triangle junction. Admit only an isolated topology pinhole
      // whose four cardinal neighbours are real, strongly covered UV texels;
      // a line or region between separate UV islands cannot satisfy this.
      const cardinalNeighbors =
        x > 0 && x < width - 1 && y > 0 && y < height - 1
          ? [index - 1, index + 1, index - width, index + width]
          : [];
      const isolatedTopologyPinHole =
        !topology[index] &&
        cardinalNeighbors.length === 4 &&
        cardinalNeighbors.every(
          (neighbor) =>
            topology[neighbor] === 1 &&
            coverage[neighbor] === 1 &&
            data[neighbor * 4 + 3] > MIN_UV_REPAIR_SOURCE_ALPHA,
        ) &&
        (getRgbDistanceSquared(data, cardinalNeighbors[0], cardinalNeighbors[1]) <=
          MAX_TOPOLOGY_PINHOLE_RGB_DISTANCE_SQUARED ||
          getRgbDistanceSquared(data, cardinalNeighbors[2], cardinalNeighbors[3]) <=
            MAX_TOPOLOGY_PINHOLE_RGB_DISTANCE_SQUARED);
      // The content-aware topology supplies an island owner for conservative
      // UV texels. With that ownership available, a missing topology texel may
      // be repaired from one opposite donor pair only when both donors belong
      // to the exact same non-zero UV region. This closes continuous 1px
      // raster cracks while making a same-colored gap between separate islands
      // ineligible. Without region ids, retain the stricter four-neighbour
      // pinhole rule above.
      if (!topology[index] && !isolatedTopologyPinHole && !regionIds) continue;
      let chosenDonor = -1;
      let chosenAlpha = -1;

      for (const [firstDirection, secondDirection] of crackDirectionPairs) {
        let firstDonor = -1;
        let secondDonor = -1;

        for (let distance = 1; distance <= crackRadius; distance += 1) {
          const sampleX = x + firstDirection[0] * distance;
          const sampleY = y + firstDirection[1] * distance;
          if (sampleX < 0 || sampleX >= width || sampleY < 0 || sampleY >= height) break;
          const sampleIndex = sampleY * width + sampleX;
          if (!topology[sampleIndex]) break;
          if (
            coverage[sampleIndex] === 1 &&
            data[sampleIndex * 4 + 3] > MIN_UV_REPAIR_SOURCE_ALPHA
          ) {
            firstDonor = sampleIndex;
            break;
          }
        }
        for (let distance = 1; distance <= crackRadius; distance += 1) {
          const sampleX = x + secondDirection[0] * distance;
          const sampleY = y + secondDirection[1] * distance;
          if (sampleX < 0 || sampleX >= width || sampleY < 0 || sampleY >= height) break;
          const sampleIndex = sampleY * width + sampleX;
          if (!topology[sampleIndex]) break;
          if (
            coverage[sampleIndex] === 1 &&
            data[sampleIndex * 4 + 3] > MIN_UV_REPAIR_SOURCE_ALPHA
          ) {
            secondDonor = sampleIndex;
            break;
          }
        }

        if (firstDonor < 0 || secondDonor < 0) continue;
        if (regionIds) {
          const firstRegion = regionIds[firstDonor];
          const secondRegion = regionIds[secondDonor];
          const targetRegion = regionIds[index];
          if (
            firstRegion === 0 ||
            secondRegion !== firstRegion ||
            (topology[index] && targetRegion !== 0 && targetRegion !== firstRegion)
          ) {
            continue;
          }
        }
        if (
          !topology[index] &&
          getRgbDistanceSquared(data, firstDonor, secondDonor) >
            MAX_TOPOLOGY_PINHOLE_RGB_DISTANCE_SQUARED
        ) {
          continue;
        }
        const firstAlpha = data[firstDonor * 4 + 3];
        const secondAlpha = data[secondDonor * 4 + 3];
        const donor =
          secondAlpha > firstAlpha ||
          (secondAlpha === firstAlpha && secondDonor < firstDonor)
            ? secondDonor
            : firstDonor;
        const donorAlpha = data[donor * 4 + 3];
        if (
          donorAlpha > chosenAlpha ||
          (donorAlpha === chosenAlpha && (chosenDonor < 0 || donor < chosenDonor))
        ) {
          chosenDonor = donor;
          chosenAlpha = donorAlpha;
        }
      }

      if (chosenDonor >= 0) {
        seedPixels.push(index);
        seedDonors.push(chosenDonor);
      }
    }

    if (seedPixels.length === 0) break;
    for (let candidate = 0; candidate < seedPixels.length; candidate += 1) {
      const targetIndex = seedPixels.get(candidate);
      const donorIndex = seedDonors.get(candidate);
      const targetOffset = targetIndex * 4;
      const donorOffset = donorIndex * 4;
      data[targetOffset] = data[donorOffset];
      data[targetOffset + 1] = data[donorOffset + 1];
      data[targetOffset + 2] = data[donorOffset + 2];
      data[targetOffset + 3] = data[donorOffset + 3];
      coverage[targetIndex] = 1;
      filledPixels += 1;
    }
  }
  return filledPixels;
}

/** Safely fills enclosed UV gaps using the model's conservative topology. */
export function fillEnclosedUvCoverageGapsWithinTopology(
  imageData: ImageData,
  coverage: Uint8Array,
  root: THREE.Object3D,
  iterations: number,
) {
  if (iterations <= 0) return 0;
  const topology = rasterizeUvTopologyMask(
    root,
    imageData.width,
    imageData.height,
    'conservative',
  );
  return fillEnclosedUvCoverageGaps(imageData, coverage, topology, iterations);
}
