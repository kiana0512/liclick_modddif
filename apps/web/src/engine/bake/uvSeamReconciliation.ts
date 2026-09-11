import * as THREE from 'three';
import { matchesUvSeamGeometry, snapshotUvSeamGeometry,
  type UvSeamGeometrySnapshot } from './uvSeamGeometrySnapshot';

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

type SeamPlan = {
  snapshot: UvSeamGeometrySnapshot;
  includeDiscontinuous: boolean;
  pairs: Array<[UvSeamEdgeRecord, UvSeamEdgeRecord]>;
};
let seamPlanCache = new WeakMap<THREE.Object3D, SeamPlan>();
// Ordered donor addresses are independent of layer content. Keep one bounded
// plan, including repeated addresses: later repairs may read earlier repairs.
type RepairPlan = { snapshot: UvSeamGeometrySnapshot; key: string; chunks: Uint32Array[];
  count: number; seamPairs: number };
let repairPlanCache = new WeakMap<THREE.Object3D, RepairPlan>();
const REPAIR_CHUNK_WORDS = 32768;
const MAX_REPAIR_WORDS = 64 * 1024 * 1024 / 4;

function* getReusableSeamPairs(root: THREE.Object3D, includeDiscontinuous: boolean) {
  const cached = seamPlanCache.get(root);
  if (cached?.includeDiscontinuous === includeDiscontinuous &&
    (yield* matchesUvSeamGeometry(root, cached.snapshot))) return cached.pairs;
  const snapshot = yield* snapshotUvSeamGeometry(root);
  const pairs = yield* collectUvSeamPairSteps(root, includeDiscontinuous, true);
  // Do not cache mixed geometry if the model changed while the cooperative
  // traversal was yielding. Pair objects remain private to this consumer.
  if (snapshot && pairs.length <= 100000 && (yield* matchesUvSeamGeometry(root, snapshot))) {
    seamPlanCache = new WeakMap([[root, { snapshot, includeDiscontinuous, pairs }]]);
  } else seamPlanCache.delete(root);
  return pairs;
}

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
  // UV-PIXEL-SPACE/1: window coordinates; pixelIndex selects the containing texel.
  return { x: uv.x * width, y: (1 - uv.y) * height };
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
  const direct = reference.a.position.distanceToSquared(candidate.a.position) +
    reference.b.position.distanceToSquared(candidate.b.position);
  const crossed = reference.a.position.distanceToSquared(candidate.b.position) +
    reference.b.position.distanceToSquared(candidate.a.position);
  if (direct <= crossed) return candidate;
  return { ...candidate, a: candidate.b, b: candidate.a };
}

function normalsAreContinuous(a: UvSeamEdgeRecord, b: UvSeamEdgeRecord) {
  return a.a.normal.dot(b.a.normal) > 0.55 && a.b.normal.dot(b.b.normal) > 0.55;
}

export function collectUvSeamPairs(root: THREE.Object3D, includeDiscontinuous = false) {
  const steps = collectUvSeamPairSteps(root, includeDiscontinuous);
  let step = steps.next();
  while (!step.done) step = steps.next();
  return step.value;
}

function* collectUvSeamPairSteps(root: THREE.Object3D, includeDiscontinuous = false, reuseEndpoints = false) {
  const groupedEdges = new Map<string, UvSeamEdgeRecord[]>();
  root.updateMatrixWorld(true);

  const meshes: THREE.Mesh[] = [];
  root.traverse((object) => {
    if (object.userData.liclickPaintOverlay || object.userData.liclickWireframeOverlay || object.userData.liclickLocalRepaintGpuOverlay) return;
    if (object instanceof THREE.Mesh) meshes.push(object);
  });
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

    // Cache only within this pass: no stale geometry/transform state can survive a bake.
    // Synchronous public callers retain their original endpoint object identities.
    const endpointsByIndex: Array<UvSeamEndpoint | undefined> = [];
    const endpointKeys = new WeakMap<UvSeamEndpoint, string>();
    for (let triangle = 0; triangle < triangleCount; triangle += 1) {
      if (triangle % 128 === 0) yield;
      const indices = [0, 1, 2].map((offset) =>
        index ? index.getX(triangle * 3 + offset) : triangle * 3 + offset,
      );
      const endpoints = indices.map((vertexIndex): UvSeamEndpoint => {
        const cached = reuseEndpoints && index ? endpointsByIndex[vertexIndex] : undefined;
        if (cached) return cached;
        const endpoint: UvSeamEndpoint = {
          position: new THREE.Vector3(
            position.getX(vertexIndex),
            position.getY(vertexIndex),
            position.getZ(vertexIndex),
          ).applyMatrix4(object.matrixWorld),
          normal: new THREE.Vector3(
            normal.getX(vertexIndex),
            normal.getY(vertexIndex),
            normal.getZ(vertexIndex),
          ).applyMatrix3(normalMatrix).normalize(),
          uv: new THREE.Vector2(uv.getX(vertexIndex), uv.getY(vertexIndex)),
        };
        if (reuseEndpoints && index) endpointsByIndex[vertexIndex] = endpoint;
        if (reuseEndpoints) endpointKeys.set(endpoint, positionKey(endpoint.position));
        return endpoint;
      });

      const edgeIndices = [[0, 1, 2], [1, 2, 0], [2, 0, 1]] as const;
      for (const [start, end, inside] of edgeIndices) {
        const record: UvSeamEdgeRecord = {
          a: endpoints[start],
          b: endpoints[end],
          insideUv: endpoints[inside].uv,
        };
        const aKey = reuseEndpoints ? endpointKeys.get(record.a)! : '';
        const bKey = reuseEndpoints ? endpointKeys.get(record.b)! : '';
        const key = reuseEndpoints
          ? (aKey < bKey ? `${aKey}|${bKey}` : `${bKey}|${aKey}`)
          : edgeKey(record.a.position, record.b.position);
        const records = groupedEdges.get(key);
        if (records) {
          // Keep the same first UV-key order and last record per key as the
          // former final Map pass. Interior triangle edges need only one
          // retained record, avoiding a second object graph during pairing.
          // UV-SEAM-REPAIR-PLAN/1.1: shared indexed endpoints already prove UV
          // equality; avoid quantizing/stringifying the same interior edge.
          let uvKey: string | undefined;
          const existing = records.length <= 4
            ? records.findIndex((edge) =>
              (edge.a === record.a && edge.b === record.b) ||
              (edge.a === record.b && edge.b === record.a) ||
              uvEdgeKey(edge) === (uvKey ??= uvEdgeKey(record)))
            : -1;
          if (existing < 0) records.push(record);
          else records[existing] = record;
        } else groupedEdges.set(key, [record]);
      }
    }
  }

  const pairs: Array<[UvSeamEdgeRecord, UvSeamEdgeRecord]> = [];
  let groupIndex = 0;
  for (const records of groupedEdges.values()) {
    if (groupIndex++ % 512 === 0) yield;
    if (records.length < 2) continue;
    // Pathological non-manifold groups keep linear Map deduplication rather
    // than extending the bounded small-group search quadratically.
    const unique = records.length <= 4
      ? records
      : [...new Map(records.map((record) => [uvEdgeKey(record), record])).values()];
    if (unique.length < 2) continue;
    const reference = unique[0];
    for (let index = 1; index < unique.length; index += 1) {
      const candidate = orientedLike(reference, unique[index]);
      if (includeDiscontinuous || normalsAreContinuous(reference, candidate)) {
        pairs.push([reference, candidate]);
      }
    }
  }
  return pairs;
}

function pixelIndex(point: PixelPoint, width: number, height: number) {
  const x = Math.max(0, Math.min(width - 1, Math.floor(point.x)));
  const y = Math.max(0, Math.min(height - 1, Math.floor(point.y)));
  return y * width + x;
}

export function reconcileUvSeams(...args: Parameters<typeof reconcileUvSeamSteps>) {
  const steps = reconcileUvSeamSteps(...args);
  let step = steps.next();
  while (!step.done) step = steps.next();
  return step.value;
}

/** Retains donor order and precision while allowing input/paint between CPU slices. */
export async function reconcileUvSeamsCooperatively(
  yieldToUi: () => Promise<void>, ...args: Parameters<typeof reconcileUvSeamSteps>
) {
  const steps = reconcileUvSeamSteps(...args);
  let startedAt = performance.now();
  let step = steps.next();
  while (!step.done) {
    if (performance.now() - startedAt >= 8) {
      await yieldToUi();
      startedAt = performance.now();
    }
    step = steps.next();
  }
  return step.value;
}

function* reconcileUvSeamSteps(
  imageData: ImageData,
  root: THREE.Object3D,
  coverage: Uint8Array,
  options: { repairMissingCoverage?: boolean; bandPixels?: number } = {},
) {
  const { width, height, data } = imageData;
  // Missing-coverage repair has always updated both arrays after each donor
  // transfer, so its working source is exactly data. Averaging still needs the
  // immutable original. Avoid the redundant 64 MiB copy for a 4K Merge.
  const source = options.repairMissingCoverage ? data : new Uint8ClampedArray(data);
  const bandPixels = Math.max(
    2,
    Math.min(32, options.bandPixels ?? Math.round(Math.max(width, height) / 1024)),
  );
  let adjustedPixels = 0;
  const repairKey = `${width}:${height}:${bandPixels}`;
  const cached = options.repairMissingCoverage ? repairPlanCache.get(root) : undefined;
  if (typeof document !== 'undefined') document.body.dataset.residentUvSeamPlanHit = '0';
  if (cached?.key === repairKey && (yield* matchesUvSeamGeometry(root, cached.snapshot))) {
    if (typeof document !== 'undefined') document.body.dataset.residentUvSeamPlanHit = '1';
    let remaining = cached.count;
    for (const chunk of cached.chunks) {
      const length = Math.min(remaining, chunk.length);
      for (let index = 0; index < length; index += 2) {
        if ((index & 8191) === 0) yield;
        const first = chunk[index], second = chunk[index + 1];
        const firstCovered = Boolean(coverage[first] && data[first * 4 + 3]);
        const secondCovered = Boolean(coverage[second] && data[second * 4 + 3]);
        if (firstCovered === secondCovered) continue;
        const donor = (firstCovered ? first : second) * 4;
        const target = firstCovered ? second : first;
        for (let channel = 0; channel < 4; channel++) data[target * 4 + channel] = data[donor + channel];
        coverage[target] = 1;
        adjustedPixels++;
      }
      remaining -= length;
    }
    return { seamPairs: cached.seamPairs, adjustedPixels, bandPixels };
  }
  const snapshot = options.repairMissingCoverage ? yield* snapshotUvSeamGeometry(root) : undefined;
  const chunks: Uint32Array[] = [];
  let addressCount = 0;
  let cacheable = Boolean(snapshot);
  const seamPairs = yield* getReusableSeamPairs(root, Boolean(options.repairMissingCoverage));

  for (const [first, second] of seamPairs) {
    const firstStart = toPixel(first.a.uv, width, height);
    const firstEnd = toPixel(first.b.uv, width, height);
    const secondStart = toPixel(second.a.uv, width, height);
    const secondEnd = toPixel(second.b.uv, width, height);
    const firstInward = inwardPixelNormal(firstStart, firstEnd, toPixel(first.insideUv, width, height));
    const secondInward = inwardPixelNormal(secondStart, secondEnd, toPixel(second.insideUv, width, height));
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
      if (sampleIndex % 128 === 0) yield;
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
        if (cacheable) {
          if (addressCount === MAX_REPAIR_WORDS) { cacheable = false; chunks.length = 0; }
          else {
            const offset = addressCount % REPAIR_CHUNK_WORDS;
            if (offset === 0) chunks.push(new Uint32Array(REPAIR_CHUNK_WORDS));
            const chunk = chunks[chunks.length - 1];
            chunk[offset] = firstIndex;
            chunk[offset + 1] = secondIndex;
            addressCount += 2;
          }
        }
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

  if (cacheable && snapshot && (yield* matchesUvSeamGeometry(root, snapshot))) {
    repairPlanCache = new WeakMap([[root, { snapshot, key: repairKey, chunks,
      count: addressCount, seamPairs: seamPairs.length }]]);
    // The compact repair plan supersedes the large edge object graph.
    seamPlanCache.delete(root);
  } else if (options.repairMissingCoverage) repairPlanCache.delete(root);
  if (typeof document !== 'undefined') {
    document.body.dataset.residentUvSeamPlanWords = String(addressCount);
    document.body.dataset.residentUvSeamPlanCached = String(repairPlanCache.has(root));
  }
  return { seamPairs: seamPairs.length, adjustedPixels, bandPixels };
}
