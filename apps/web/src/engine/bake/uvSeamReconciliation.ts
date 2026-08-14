import * as THREE from 'three';

export type UvSeamEndpoint = {
  position: THREE.Vector3;
  normal: THREE.Vector3;
  uv: THREE.Vector2;
};

export type UvSeamEdgeRecord = {
  a: UvSeamEndpoint;
  b: UvSeamEndpoint;
  insideUv: THREE.Vector2;
};

type PixelPoint = { x: number; y: number };

function quantize(value: number, scale: number) {
  return Math.round(value * scale);
}

function positionKey(position: THREE.Vector3) {
  return `${quantize(position.x, 100000)},${quantize(position.y, 100000)},${quantize(position.z, 100000)}`;
}

function edgeKey(a: THREE.Vector3, b: THREE.Vector3) {
  const aKey = positionKey(a);
  const bKey = positionKey(b);
  return aKey < bKey ? `${aKey}|${bKey}` : `${bKey}|${aKey}`;
}

function uvEdgeKey(edge: UvSeamEdgeRecord) {
  const a = `${quantize(edge.a.uv.x, 1000000)},${quantize(edge.a.uv.y, 1000000)}`;
  const b = `${quantize(edge.b.uv.x, 1000000)},${quantize(edge.b.uv.y, 1000000)}`;
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function toPixel(uv: THREE.Vector2, width: number, height: number): PixelPoint {
  return { x: uv.x * (width - 1), y: (1 - uv.y) * (height - 1) };
}

function inwardPixelNormal(edgeStart: PixelPoint, edgeEnd: PixelPoint, inside: PixelPoint) {
  const edgeX = edgeEnd.x - edgeStart.x;
  const edgeY = edgeEnd.y - edgeStart.y;
  const length = Math.hypot(edgeX, edgeY);
  if (length <= 0.0001) return { x: 0, y: 0 };
  let x = -edgeY / length;
  let y = edgeX / length;
  if ((inside.x - edgeStart.x) * x + (inside.y - edgeStart.y) * y < 0) {
    x = -x;
    y = -y;
  }
  return { x, y };
}

function orientedLike(reference: UvSeamEdgeRecord, candidate: UvSeamEdgeRecord) {
  const direct =
    reference.a.position.distanceToSquared(candidate.a.position) +
    reference.b.position.distanceToSquared(candidate.b.position);
  const crossed =
    reference.a.position.distanceToSquared(candidate.b.position) +
    reference.b.position.distanceToSquared(candidate.a.position);
  if (direct <= crossed) return candidate;
  return { ...candidate, a: candidate.b, b: candidate.a };
}

function normalsAreContinuous(a: UvSeamEdgeRecord, b: UvSeamEdgeRecord) {
  return a.a.normal.dot(b.a.normal) > 0.55 && a.b.normal.dot(b.b.normal) > 0.55;
}

export function collectUvSeamPairs(root: THREE.Object3D, includeDiscontinuous = false) {
  const groupedEdges = new Map<string, UvSeamEdgeRecord[]>();
  root.updateMatrixWorld(true);

  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    const geometry = object.geometry;
    const position = geometry.getAttribute('position');
    const uv = geometry.getAttribute('uv');
    if (!position || !uv) return;
    if (!geometry.getAttribute('normal')) geometry.computeVertexNormals();
    const normal = geometry.getAttribute('normal');
    if (!normal) return;
    const index = geometry.getIndex();
    const triangleCount = index ? index.count / 3 : position.count / 3;
    const normalMatrix = new THREE.Matrix3().getNormalMatrix(object.matrixWorld);

    for (let triangle = 0; triangle < triangleCount; triangle += 1) {
      const indices = [0, 1, 2].map((offset) =>
        index ? index.getX(triangle * 3 + offset) : triangle * 3 + offset,
      );
      const endpoints = indices.map(
        (vertexIndex): UvSeamEndpoint => ({
          position: new THREE.Vector3(
            position.getX(vertexIndex),
            position.getY(vertexIndex),
            position.getZ(vertexIndex),
          ).applyMatrix4(object.matrixWorld),
          normal: new THREE.Vector3(
            normal.getX(vertexIndex),
            normal.getY(vertexIndex),
            normal.getZ(vertexIndex),
          )
            .applyMatrix3(normalMatrix)
            .normalize(),
          uv: new THREE.Vector2(uv.getX(vertexIndex), uv.getY(vertexIndex)),
        }),
      );

      const edgeIndices = [
        [0, 1, 2],
        [1, 2, 0],
        [2, 0, 1],
      ] as const;
      for (const [start, end, inside] of edgeIndices) {
        const record: UvSeamEdgeRecord = {
          a: endpoints[start],
          b: endpoints[end],
          insideUv: endpoints[inside].uv,
        };
        const key = edgeKey(record.a.position, record.b.position);
        const records = groupedEdges.get(key);
        if (records) records.push(record);
        else groupedEdges.set(key, [record]);
      }
    }
  });

  const pairs: Array<[UvSeamEdgeRecord, UvSeamEdgeRecord]> = [];
  groupedEdges.forEach((records) => {
    if (records.length < 2) return;
    const uniqueByUv = new Map<string, UvSeamEdgeRecord>();
    records.forEach((record) => uniqueByUv.set(uvEdgeKey(record), record));
    const unique = [...uniqueByUv.values()];
    if (unique.length < 2) return;
    const reference = unique[0];
    for (let index = 1; index < unique.length; index += 1) {
      const candidate = orientedLike(reference, unique[index]);
      if (includeDiscontinuous || normalsAreContinuous(reference, candidate)) {
        pairs.push([reference, candidate]);
      }
    }
  });
  return pairs;
}

const cooperativeSeamPairCache = new WeakMap<
  THREE.Object3D,
  Map<string, Promise<Array<[UvSeamEdgeRecord, UvSeamEdgeRecord]>>>
>();

function yieldSeamCollection() {
  return new Promise<void>((resolve) => window.setTimeout(resolve, 0));
}

/**
 * Byte-for-byte equivalent pair selection to `collectUvSeamPairs`, but model
 * traversal is split into bounded tasks so a dense mesh cannot monopolize an
 * interaction frame. Results are cached per model and continuity mode.
 */
export function collectUvSeamPairsCooperatively(
  root: THREE.Object3D,
  includeDiscontinuous = false,
) {
  let cache = cooperativeSeamPairCache.get(root);
  if (!cache) {
    cache = new Map();
    cooperativeSeamPairCache.set(root, cache);
  }
  const cacheKey = includeDiscontinuous ? 'all' : 'continuous';
  const cached = cache.get(cacheKey);
  if (cached) return cached;
  const promise = (async () => {
    const groupedEdges = new Map<string, UvSeamEdgeRecord[]>();
    root.updateMatrixWorld(true);
    const meshes: THREE.Mesh[] = [];
    root.traverse((object) => {
      if (object instanceof THREE.Mesh) meshes.push(object);
    });
    let trianglesSinceYield = 0;
    for (const object of meshes) {
      const geometry = object.geometry;
      const position = geometry.getAttribute('position');
      const uv = geometry.getAttribute('uv');
      if (!position || !uv) continue;
      if (!geometry.getAttribute('normal')) geometry.computeVertexNormals();
      const normal = geometry.getAttribute('normal');
      if (!normal) continue;
      const index = geometry.getIndex();
      const triangleCount = index ? index.count / 3 : position.count / 3;
      const normalMatrix = new THREE.Matrix3().getNormalMatrix(object.matrixWorld);

      for (let triangle = 0; triangle < triangleCount; triangle += 1) {
        const indices = [0, 1, 2].map((offset) =>
          index ? index.getX(triangle * 3 + offset) : triangle * 3 + offset,
        );
        const endpoints = indices.map(
          (vertexIndex): UvSeamEndpoint => ({
            position: new THREE.Vector3(
              position.getX(vertexIndex),
              position.getY(vertexIndex),
              position.getZ(vertexIndex),
            ).applyMatrix4(object.matrixWorld),
            normal: new THREE.Vector3(
              normal.getX(vertexIndex),
              normal.getY(vertexIndex),
              normal.getZ(vertexIndex),
            )
              .applyMatrix3(normalMatrix)
              .normalize(),
            uv: new THREE.Vector2(uv.getX(vertexIndex), uv.getY(vertexIndex)),
          }),
        );
        const edgeIndices = [
          [0, 1, 2],
          [1, 2, 0],
          [2, 0, 1],
        ] as const;
        for (const [start, end, inside] of edgeIndices) {
          const record: UvSeamEdgeRecord = {
            a: endpoints[start],
            b: endpoints[end],
            insideUv: endpoints[inside].uv,
          };
          const key = edgeKey(record.a.position, record.b.position);
          const records = groupedEdges.get(key);
          if (records) records.push(record);
          else groupedEdges.set(key, [record]);
        }
        trianglesSinceYield += 1;
        if (trianglesSinceYield >= 1_024) {
          trianglesSinceYield = 0;
          await yieldSeamCollection();
        }
      }
    }

    const pairs: Array<[UvSeamEdgeRecord, UvSeamEdgeRecord]> = [];
    let groupsSinceYield = 0;
    for (const records of groupedEdges.values()) {
      if (records.length >= 2) {
        const uniqueByUv = new Map<string, UvSeamEdgeRecord>();
        records.forEach((record) => uniqueByUv.set(uvEdgeKey(record), record));
        const unique = [...uniqueByUv.values()];
        if (unique.length >= 2) {
          const reference = unique[0];
          for (let index = 1; index < unique.length; index += 1) {
            const candidate = orientedLike(reference, unique[index]);
            if (includeDiscontinuous || normalsAreContinuous(reference, candidate)) {
              pairs.push([reference, candidate]);
            }
          }
        }
      }
      groupsSinceYield += 1;
      if (groupsSinceYield >= 4_096) {
        groupsSinceYield = 0;
        await yieldSeamCollection();
      }
    }
    return pairs;
  })().catch((error) => {
    cache?.delete(cacheKey);
    throw error;
  });
  cache.set(cacheKey, promise);
  return promise;
}

export async function serializeUvSeamPairsCooperatively(
  root: THREE.Object3D,
  includeDiscontinuous = false,
) {
  const pairs = await collectUvSeamPairsCooperatively(root, includeDiscontinuous);
  const serialized = new Float32Array(pairs.length * 12);
  let offset = 0;
  for (let index = 0; index < pairs.length; index += 1) {
    for (const edge of pairs[index]) {
      serialized[offset++] = edge.a.uv.x;
      serialized[offset++] = edge.a.uv.y;
      serialized[offset++] = edge.b.uv.x;
      serialized[offset++] = edge.b.uv.y;
      serialized[offset++] = edge.insideUv.x;
      serialized[offset++] = edge.insideUv.y;
    }
    if (index > 0 && index % 4_096 === 0) await yieldSeamCollection();
  }
  return { pairs: serialized, pairCount: pairs.length };
}

function pixelIndex(point: PixelPoint, width: number, height: number) {
  const x = Math.max(0, Math.min(width - 1, Math.round(point.x)));
  const y = Math.max(0, Math.min(height - 1, Math.round(point.y)));
  return y * width + x;
}

export function reconcileUvSeams(
  imageData: ImageData,
  root: THREE.Object3D,
  coverage: Uint8Array,
  options: { repairMissingCoverage?: boolean; bandPixels?: number } = {},
) {
  const { width, height, data } = imageData;
  const source = new Uint8ClampedArray(data);
  const seamPairs = collectUvSeamPairs(root, Boolean(options.repairMissingCoverage));
  const bandPixels = Math.max(
    2,
    Math.min(32, options.bandPixels ?? Math.round(Math.max(width, height) / 1024)),
  );
  let adjustedPixels = 0;

  for (const [first, second] of seamPairs) {
    const firstStart = toPixel(first.a.uv, width, height);
    const firstEnd = toPixel(first.b.uv, width, height);
    const secondStart = toPixel(second.a.uv, width, height);
    const secondEnd = toPixel(second.b.uv, width, height);
    const firstInward = inwardPixelNormal(
      firstStart,
      firstEnd,
      toPixel(first.insideUv, width, height),
    );
    const secondInward = inwardPixelNormal(
      secondStart,
      secondEnd,
      toPixel(second.insideUv, width, height),
    );
    const samples = Math.max(
      1,
      Math.ceil(
        Math.max(
          Math.hypot(firstEnd.x - firstStart.x, firstEnd.y - firstStart.y),
          Math.hypot(secondEnd.x - secondStart.x, secondEnd.y - secondStart.y),
        ),
      ),
    );

    for (let sampleIndex = 0; sampleIndex < samples; sampleIndex += 1) {
      const t = (sampleIndex + 0.5) / samples;
      const firstEdge = {
        x: firstStart.x + (firstEnd.x - firstStart.x) * t,
        y: firstStart.y + (firstEnd.y - firstStart.y) * t,
      };
      const secondEdge = {
        x: secondStart.x + (secondEnd.x - secondStart.x) * t,
        y: secondStart.y + (secondEnd.y - secondStart.y) * t,
      };

      for (let depth = 0; depth < bandPixels; depth += 1) {
        const offset = depth + 0.35;
        const firstPoint = {
          x: firstEdge.x + firstInward.x * offset,
          y: firstEdge.y + firstInward.y * offset,
        };
        const secondPoint = {
          x: secondEdge.x + secondInward.x * offset,
          y: secondEdge.y + secondInward.y * offset,
        };
        const firstIndex = pixelIndex(firstPoint, width, height);
        const secondIndex = pixelIndex(secondPoint, width, height);
        const firstOffset = firstIndex * 4;
        const secondOffset = secondIndex * 4;
        const firstCovered = Boolean(coverage[firstIndex] && source[firstOffset + 3]);
        const secondCovered = Boolean(coverage[secondIndex] && source[secondOffset + 3]);

        if (options.repairMissingCoverage && firstCovered !== secondCovered) {
          const sourceOffset = firstCovered ? firstOffset : secondOffset;
          const targetOffset = firstCovered ? secondOffset : firstOffset;
          const targetIndex = firstCovered ? secondIndex : firstIndex;
          for (let channel = 0; channel < 4; channel += 1) {
            data[targetOffset + channel] = source[sourceOffset + channel];
            // Let a repaired seam become a source for another geometrically
            // connected UV edge later in this pass. This closes fragmented
            // high-poly islands without leaking across unrelated atlas space.
            source[targetOffset + channel] = source[sourceOffset + channel];
          }
          coverage[targetIndex] = 1;
          adjustedPixels += 1;
          continue;
        }

        // Transparent merged projections only need missing-coverage transfer.
        // Do not average two already valid texels across a hard/noisy high-poly
        // edge, because that would blur legitimate material boundaries.
        if (options.repairMissingCoverage) continue;
        if (!firstCovered || !secondCovered) continue;
        const strength = 0.9 * (1 - depth / bandPixels);

        for (let channel = 0; channel < 3; channel += 1) {
          const average = (source[firstOffset + channel] + source[secondOffset + channel]) * 0.5;
          data[firstOffset + channel] = Math.round(
            source[firstOffset + channel] * (1 - strength) + average * strength,
          );
          data[secondOffset + channel] = Math.round(
            source[secondOffset + channel] * (1 - strength) + average * strength,
          );
        }
        adjustedPixels += firstIndex === secondIndex ? 1 : 2;
      }
    }
  }

  return { seamPairs: seamPairs.length, adjustedPixels, bandPixels };
}
