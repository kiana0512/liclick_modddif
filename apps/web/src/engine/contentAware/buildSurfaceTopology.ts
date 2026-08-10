import * as THREE from 'three';

export type ContentAwareTopologyPhase = 'analyze' | 'rasterize' | 'seams' | 'complete';

export type ContentAwareTopologyProgress = {
  phase: ContentAwareTopologyPhase;
  completed: number;
  total: number;
};

export type ContentAwareSurfaceRecord = {
  /** Stable for an unchanged Object3D traversal order. Zero is reserved for empty texels. */
  id: number;
  meshUuid: string;
  meshName: string;
  materialIndex: number;
};

export type ContentAwareSurfaceTopology = {
  width: number;
  height: number;
  /** One for every texel conservatively touched by a model UV triangle. */
  topologyMask: Uint8Array;
  /** Zero-tolerance pixel-centre coverage. Only this mask may receive repair alpha. */
  coreMask: Uint8Array;
  /** UV-connected island identity. Regular 2D propagation may not cross this boundary. */
  regionIds: Uint32Array;
  /**
   * UV overlap classification. `1` is an intra-component UV-island overlap;
   * `2` is a cross-surface/component overlap. Neither may be sampled. A
   * deterministic region owner is retained so a sparse underlay repair may
   * explicitly opt into final writes without using draw-order colour sources.
   */
  conflictMask: Uint8Array;
  /** Optional stable triangle id, allocated only when includeTriangleIds is requested. */
  triangleIds?: Uint32Array;
  /** Flattened, unordered UV-seam texel pairs: [a0, b0, a1, b1, ...]. */
  seamLinks: Uint32Array;
  /** Index zero is reserved, so componentSurfaceIds[componentId] is directly addressable. */
  componentSurfaceIds: Uint32Array;
  surfaces: ReadonlyArray<ContentAwareSurfaceRecord>;
  surfaceCount: number;
  componentCount: number;
  regionCount: number;
  triangleCount: number;
  seamLinkCount: number;
  buildTimeMs: number;
};

export type BuildContentAwareSurfaceTopologyOptions = {
  includeInvisible?: boolean;
  includeSeamLinks?: boolean;
  includeTriangleIds?: boolean;
  /** Number of paired texel rows just inside each side of a UV seam. */
  seamBandPixels?: number;
  /** Prevents a hard geometric edge from becoming a texture sampling bridge. */
  minimumSeamNormalDot?: number;
  /**
   * Minimum normal agreement for an explicit, bounded physical-seam bridge.
   * This is intentionally independent from minimumSeamNormalDot: regular UV
   * propagation must stay on a smooth surface, while a repair may cross one
   * real shared edge to reach a blank face around a structural corner.
   */
  minimumSeamBridgeNormalDot?: number;
  /** Main-thread work budget before yielding back to rendering/input. */
  yieldIntervalMs?: number;
  signal?: AbortSignal;
  onProgress?: (progress: ContentAwareTopologyProgress) => void;
};

type GeometryAttribute = THREE.BufferAttribute | THREE.InterleavedBufferAttribute;

type MeshTopologySource = {
  mesh: THREE.Mesh;
  geometry: THREE.BufferGeometry;
  position: GeometryAttribute;
  uv: GeometryAttribute;
  normal?: GeometryAttribute;
  index: THREE.BufferAttribute | null;
  triangleCount: number;
  globalTriangleOffset: number;
  triangleMaterialIndices: Int32Array;
  triangleSurfaceIds: Uint32Array;
  triangleComponentIds: Uint32Array;
  triangleRegionIds: Uint32Array;
  seamEdgePairs: number[];
};

type MutableBuildState = {
  nextSurfaceId: number;
  nextComponentId: number;
  nextRegionId: number;
  surfaces: ContentAwareSurfaceRecord[];
  componentSurfaceIds: number[];
};

const EDGE_VERTEX_SLOTS = [
  [0, 1, 2],
  [1, 2, 0],
  [2, 0, 1],
] as const;

const POSITION_QUANTIZATION = 100_000;
const UV_EQUALITY_EPSILON = 1e-7;
const MAX_CACHE_ENTRIES_PER_ROOT = 2;
const DEFAULT_YIELD_INTERVAL_MS = 8;
const DEFAULT_MINIMUM_SEAM_NORMAL_DOT = 0.35;
const DEFAULT_MINIMUM_SEAM_BRIDGE_NORMAL_DOT = DEFAULT_MINIMUM_SEAM_NORMAL_DOT;

let topologyCache = new WeakMap<THREE.Object3D, Map<string, ContentAwareSurfaceTopology>>();

function now() {
  return typeof performance === 'undefined' ? Date.now() : performance.now();
}

function throwIfAborted(signal?: AbortSignal) {
  if (!signal?.aborted) return;
  const error = new Error('Content-aware topology construction was aborted.');
  error.name = 'AbortError';
  throw error;
}

function yieldToViewportFrame() {
  if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') {
    return new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  return new Promise<void>((resolve) =>
    window.requestAnimationFrame(() => window.setTimeout(resolve, 0)),
  );
}

class CooperativeScheduler {
  private lastYieldAt = now();
  private readonly intervalMs: number;
  private readonly signal?: AbortSignal;

  constructor(intervalMs: number, signal?: AbortSignal) {
    this.intervalMs = intervalMs;
    this.signal = signal;
  }

  async checkpoint(force = false) {
    throwIfAborted(this.signal);
    if (!force && now() - this.lastYieldAt < this.intervalMs) return;
    // Resume only after the next visible frame. setTimeout(0) alone can run
    // several 8ms topology slices before rAF and visibly halve orbit FPS.
    await yieldToViewportFrame();
    this.lastYieldAt = now();
    throwIfAborted(this.signal);
  }
}

function quantize(value: number, scale: number) {
  return Math.round(value * scale);
}

function positionKey(position: GeometryAttribute, vertexIndex: number) {
  return `${quantize(position.getX(vertexIndex), POSITION_QUANTIZATION)},${quantize(
    position.getY(vertexIndex),
    POSITION_QUANTIZATION,
  )},${quantize(position.getZ(vertexIndex), POSITION_QUANTIZATION)}`;
}

function getTriangleVertexIndex(source: MeshTopologySource, triangle: number, slot: number) {
  const indexOffset = triangle * 3 + slot;
  return source.index ? source.index.getX(indexOffset) : indexOffset;
}

function getEncodedEdgeVertices(source: MeshTopologySource, encodedEdge: number) {
  const triangle = Math.floor(encodedEdge / 3);
  const edgeSlot = encodedEdge % 3;
  const [startSlot, endSlot, insideSlot] = EDGE_VERTEX_SLOTS[edgeSlot];
  return {
    start: getTriangleVertexIndex(source, triangle, startSlot),
    end: getTriangleVertexIndex(source, triangle, endSlot),
    inside: getTriangleVertexIndex(source, triangle, insideSlot),
  };
}

function createTriangleMaterialIndices(geometry: THREE.BufferGeometry, triangleCount: number) {
  const result = new Int32Array(triangleCount);
  for (const group of geometry.groups) {
    const firstTriangle = Math.max(0, Math.floor(group.start / 3));
    const endTriangle = Math.min(triangleCount, Math.ceil((group.start + group.count) / 3));
    result.fill(group.materialIndex ?? 0, firstTriangle, endTriangle);
  }
  return result;
}

function findRoot(parent: Int32Array, value: number) {
  let root = value;
  while (parent[root] !== root) root = parent[root];
  let current = value;
  while (parent[current] !== current) {
    const next = parent[current];
    parent[current] = root;
    current = next;
  }
  return root;
}

function union(parent: Int32Array, rank: Uint8Array, first: number, second: number) {
  let firstRoot = findRoot(parent, first);
  let secondRoot = findRoot(parent, second);
  if (firstRoot === secondRoot) return;
  if (rank[firstRoot] < rank[secondRoot]) {
    [firstRoot, secondRoot] = [secondRoot, firstRoot];
  }
  parent[secondRoot] = firstRoot;
  if (rank[firstRoot] === rank[secondRoot]) rank[firstRoot] += 1;
}

function uvEdgesAreEquivalent(
  source: MeshTopologySource,
  firstEncodedEdge: number,
  secondEncodedEdge: number,
) {
  const first = getEncodedEdgeVertices(source, firstEncodedEdge);
  const second = getEncodedEdgeVertices(source, secondEncodedEdge);
  const uv = source.uv;
  const direct =
    Math.abs(uv.getX(first.start) - uv.getX(second.start)) <= UV_EQUALITY_EPSILON &&
    Math.abs(uv.getY(first.start) - uv.getY(second.start)) <= UV_EQUALITY_EPSILON &&
    Math.abs(uv.getX(first.end) - uv.getX(second.end)) <= UV_EQUALITY_EPSILON &&
    Math.abs(uv.getY(first.end) - uv.getY(second.end)) <= UV_EQUALITY_EPSILON;
  if (direct) return true;
  return (
    Math.abs(uv.getX(first.start) - uv.getX(second.end)) <= UV_EQUALITY_EPSILON &&
    Math.abs(uv.getY(first.start) - uv.getY(second.end)) <= UV_EQUALITY_EPSILON &&
    Math.abs(uv.getX(first.end) - uv.getX(second.start)) <= UV_EQUALITY_EPSILON &&
    Math.abs(uv.getY(first.end) - uv.getY(second.start)) <= UV_EQUALITY_EPSILON
  );
}

function normalizedDot(normal: GeometryAttribute, firstVertex: number, secondVertex: number) {
  const firstX = normal.getX(firstVertex);
  const firstY = normal.getY(firstVertex);
  const firstZ = normal.getZ(firstVertex);
  const secondX = normal.getX(secondVertex);
  const secondY = normal.getY(secondVertex);
  const secondZ = normal.getZ(secondVertex);
  const denominator = Math.hypot(firstX, firstY, firstZ) * Math.hypot(secondX, secondY, secondZ);
  if (denominator <= 1e-12) return 1;
  return (firstX * secondX + firstY * secondY + firstZ * secondZ) / denominator;
}

function seamNormalsAreCompatible(
  source: MeshTopologySource,
  firstEncodedEdge: number,
  secondEncodedEdge: number,
  minimumDot: number,
) {
  if (!source.normal) return true;
  const first = getEncodedEdgeVertices(source, firstEncodedEdge);
  const second = getEncodedEdgeVertices(source, secondEncodedEdge);
  const position = source.position;
  const directDistance =
    (position.getX(first.start) - position.getX(second.start)) ** 2 +
    (position.getY(first.start) - position.getY(second.start)) ** 2 +
    (position.getZ(first.start) - position.getZ(second.start)) ** 2 +
    (position.getX(first.end) - position.getX(second.end)) ** 2 +
    (position.getY(first.end) - position.getY(second.end)) ** 2 +
    (position.getZ(first.end) - position.getZ(second.end)) ** 2;
  const crossedDistance =
    (position.getX(first.start) - position.getX(second.end)) ** 2 +
    (position.getY(first.start) - position.getY(second.end)) ** 2 +
    (position.getZ(first.start) - position.getZ(second.end)) ** 2 +
    (position.getX(first.end) - position.getX(second.start)) ** 2 +
    (position.getY(first.end) - position.getY(second.start)) ** 2 +
    (position.getZ(first.end) - position.getZ(second.start)) ** 2;
  const secondStart = directDistance <= crossedDistance ? second.start : second.end;
  const secondEnd = directDistance <= crossedDistance ? second.end : second.start;
  return (
    normalizedDot(source.normal, first.start, secondStart) >= minimumDot &&
    normalizedDot(source.normal, first.end, secondEnd) >= minimumDot
  );
}

function collectMeshSources(root: THREE.Object3D, includeInvisible: boolean) {
  const sources: MeshTopologySource[] = [];
  let triangleCount = 0;
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh) || (!includeInvisible && !object.visible)) return;
    if (
      object.userData.liclickPaintOverlay ||
      object.userData.liclickViewportHelper ||
      object.userData.liclickSelectionGlow ||
      object.userData.liclickWireframeOverlay
    )
      return;
    const geometry = object.geometry;
    const position = geometry.getAttribute('position');
    const uv = geometry.getAttribute('uv');
    if (!position || !uv) return;
    const index = geometry.getIndex();
    const meshTriangleCount = Math.floor((index ? index.count : position.count) / 3);
    if (meshTriangleCount <= 0) return;
    sources.push({
      mesh: object,
      geometry,
      position,
      uv,
      normal: geometry.getAttribute('normal'),
      index,
      triangleCount: meshTriangleCount,
      globalTriangleOffset: triangleCount,
      triangleMaterialIndices: createTriangleMaterialIndices(geometry, meshTriangleCount),
      triangleSurfaceIds: new Uint32Array(meshTriangleCount),
      triangleComponentIds: new Uint32Array(meshTriangleCount),
      triangleRegionIds: new Uint32Array(meshTriangleCount),
      seamEdgePairs: [],
    });
    triangleCount += meshTriangleCount;
  });
  return { sources, triangleCount };
}

async function analyzeMesh(
  source: MeshTopologySource,
  state: MutableBuildState,
  scheduler: CooperativeScheduler,
  includeSeamLinks: boolean,
  minimumSeamNormalDot: number,
  minimumSeamBridgeNormalDot: number,
  completedBeforeMesh: number,
  totalTriangles: number,
  onProgress?: (progress: ContentAwareTopologyProgress) => void,
) {
  const { triangleCount, triangleMaterialIndices, position } = source;
  const parent = new Int32Array(triangleCount);
  const rank = new Uint8Array(triangleCount);
  const regionParent = new Int32Array(triangleCount);
  const regionRank = new Uint8Array(triangleCount);
  const canonicalByVertex = new Int32Array(position.count);
  const canonicalByPosition = new Map<string, number>();
  const firstEdgeByKey = new Map<string, number>();
  const surfaceIdByMaterial = new Map<number, number>();
  let nextCanonicalId = 1;

  const canonicalVertex = (vertexIndex: number) => {
    const cached = canonicalByVertex[vertexIndex];
    if (cached) return cached;
    const key = positionKey(position, vertexIndex);
    let canonical = canonicalByPosition.get(key);
    if (!canonical) {
      canonical = nextCanonicalId;
      nextCanonicalId += 1;
      canonicalByPosition.set(key, canonical);
    }
    canonicalByVertex[vertexIndex] = canonical;
    return canonical;
  };

  for (let triangle = 0; triangle < triangleCount; triangle += 1) {
    parent[triangle] = triangle;
    regionParent[triangle] = triangle;
    const materialIndex = triangleMaterialIndices[triangle];
    let surfaceId = surfaceIdByMaterial.get(materialIndex);
    if (!surfaceId) {
      surfaceId = state.nextSurfaceId;
      state.nextSurfaceId += 1;
      surfaceIdByMaterial.set(materialIndex, surfaceId);
      state.surfaces.push({
        id: surfaceId,
        meshUuid: source.mesh.uuid,
        meshName: source.mesh.name,
        materialIndex,
      });
    }
    source.triangleSurfaceIds[triangle] = surfaceId;
    const vertices = [0, 1, 2].map((slot) => getTriangleVertexIndex(source, triangle, slot));
    for (let edgeSlot = 0; edgeSlot < EDGE_VERTEX_SLOTS.length; edgeSlot += 1) {
      const [startSlot, endSlot] = EDGE_VERTEX_SLOTS[edgeSlot];
      const firstCanonical = canonicalVertex(vertices[startSlot]);
      const secondCanonical = canonicalVertex(vertices[endSlot]);
      const low = Math.min(firstCanonical, secondCanonical);
      const high = Math.max(firstCanonical, secondCanonical);
      const edgeKey = `${materialIndex}|${low}|${high}`;
      const encodedEdge = triangle * 3 + edgeSlot;
      const firstEncodedEdge = firstEdgeByKey.get(edgeKey);
      if (firstEncodedEdge === undefined) {
        firstEdgeByKey.set(edgeKey, encodedEdge);
        continue;
      }
      const firstTriangle = Math.floor(firstEncodedEdge / 3);
      const normalsAreCompatible = seamNormalsAreCompatible(
        source,
        firstEncodedEdge,
        encodedEdge,
        minimumSeamNormalDot,
      );
      const normalsCanBridge =
        normalsAreCompatible ||
        seamNormalsAreCompatible(
          source,
          firstEncodedEdge,
          encodedEdge,
          minimumSeamBridgeNormalDot,
        );
      const uvEdgesEquivalent = uvEdgesAreEquivalent(source, firstEncodedEdge, encodedEdge);
      // Coincident shells and hard geometric edges can live in one Mesh and
      // material slot. Keeping them in separate components prevents the regular
      // UV grid from becoming an accidental clone-source bridge.
      if (normalsAreCompatible) {
        union(parent, rank, firstTriangle, triangle);
        if (uvEdgesEquivalent) {
          union(regionParent, regionRank, firstTriangle, triangle);
        }
      }
      if (includeSeamLinks && normalsCanBridge && !uvEdgesEquivalent) {
        source.seamEdgePairs.push(firstEncodedEdge, encodedEdge);
      }
    }
    if ((triangle & 511) === 0) {
      onProgress?.({
        phase: 'analyze',
        completed: completedBeforeMesh + triangle,
        total: totalTriangles,
      });
      await scheduler.checkpoint();
    }
  }

  // The edge/canonical maps are intentionally released before rasterization;
  // on multi-million-triangle meshes they are much larger than the final masks.
  firstEdgeByKey.clear();
  canonicalByPosition.clear();

  const componentIdByRoot = new Map<number, number>();
  const regionIdByRoot = new Map<number, number>();
  for (let triangle = 0; triangle < triangleCount; triangle += 1) {
    const root = findRoot(parent, triangle);
    let componentId = componentIdByRoot.get(root);
    if (!componentId) {
      componentId = state.nextComponentId;
      state.nextComponentId += 1;
      componentIdByRoot.set(root, componentId);
      state.componentSurfaceIds[componentId] = source.triangleSurfaceIds[triangle];
    }
    source.triangleComponentIds[triangle] = componentId;
    const regionRoot = findRoot(regionParent, triangle);
    let regionId = regionIdByRoot.get(regionRoot);
    if (!regionId) {
      regionId = state.nextRegionId;
      state.nextRegionId += 1;
      regionIdByRoot.set(regionRoot, regionId);
    }
    source.triangleRegionIds[triangle] = regionId;
    if ((triangle & 8191) === 0) await scheduler.checkpoint();
  }
}

function edgeValue(
  startX: number,
  startY: number,
  endX: number,
  endY: number,
  pointX: number,
  pointY: number,
) {
  return (endX - startX) * (pointY - startY) - (endY - startY) * (pointX - startX);
}

function conservativeTriangleBounds(
  points: ReadonlyArray<readonly [number, number]>,
  width: number,
  height: number,
) {
  const [a, b, c] = points;
  const minimumX = Math.max(0, Math.floor(Math.min(a[0], b[0], c[0]) - 0.5));
  const maximumX = Math.min(width - 1, Math.ceil(Math.max(a[0], b[0], c[0]) + 0.5));
  const minimumY = Math.max(0, Math.floor(Math.min(a[1], b[1], c[1]) - 0.5));
  const maximumY = Math.min(height - 1, Math.ceil(Math.max(a[1], b[1], c[1]) + 0.5));
  if (minimumX > maximumX || minimumY > maximumY) return undefined;
  return { minimumX, maximumX, minimumY, maximumY };
}

function rasterizeConservativeTriangle(
  points: ReadonlyArray<readonly [number, number]>,
  width: number,
  height: number,
  topologyMask: Uint8Array,
  coreMask: Uint8Array,
  surfaceIds: Uint32Array,
  componentIds: Uint32Array,
  regionIds: Uint32Array,
  conflictMask: Uint8Array,
  surfaceId: number,
  componentId: number,
  regionId: number,
  triangleIds: Uint32Array | undefined,
  triangleId: number,
  rowStart?: number,
  rowEnd?: number,
) {
  const [a, b, c] = points;
  const signedArea = edgeValue(a[0], a[1], b[0], b[1], c[0], c[1]);
  if (!Number.isFinite(signedArea) || Math.abs(signedArea) <= 1e-12) return;
  const orientation = signedArea > 0 ? 1 : -1;
  const bounds = conservativeTriangleBounds(points, width, height);
  if (!bounds) return;
  const { minimumX, maximumX } = bounds;
  const minimumY = Math.max(bounds.minimumY, rowStart ?? bounds.minimumY);
  const maximumY = Math.min(bounds.maximumY, rowEnd ?? bounds.maximumY);
  if (minimumY > maximumY) return;

  // Expanding each oriented edge by the support radius of a half-pixel square
  // is a fast conservative rasterizer. It deliberately prefers one extra edge
  // texel over dropping sub-pixel high-poly triangles.
  const toleranceAB = 0.5 * (Math.abs(b[0] - a[0]) + Math.abs(b[1] - a[1]));
  const toleranceBC = 0.5 * (Math.abs(c[0] - b[0]) + Math.abs(c[1] - b[1]));
  const toleranceCA = 0.5 * (Math.abs(a[0] - c[0]) + Math.abs(a[1] - c[1]));
  for (let y = minimumY; y <= maximumY; y += 1) {
    for (let x = minimumX; x <= maximumX; x += 1) {
      const edgeAB = orientation * edgeValue(a[0], a[1], b[0], b[1], x, y);
      const edgeBC = orientation * edgeValue(b[0], b[1], c[0], c[1], x, y);
      const edgeCA = orientation * edgeValue(c[0], c[1], a[0], a[1], x, y);
      if (
        edgeAB < -toleranceAB ||
        edgeBC < -toleranceBC ||
        edgeCA < -toleranceCA
      ) {
        continue;
      }
      const pixelIndex = y * width + x;
      topologyMask[pixelIndex] = 1;
      // Conservative coverage is useful for traversing sub-pixel high-poly
      // topology, but its half-pixel halo must never become visible repair
      // alpha. Record the strict sample domain separately for final writes.
      if (edgeAB >= -1e-9 && edgeBC >= -1e-9 && edgeCA >= -1e-9) {
        coreMask[pixelIndex] = 1;
      }
      const existingConflict = conflictMask[pixelIndex];
      if (existingConflict) {
        if (existingConflict > 1) continue;
        // A recoverable overlap can still be touched later by an unrelated
        // mesh/material component. Upgrade it to a hard conflict instead of
        // keeping the first draw-order owner.
        if (
          surfaceIds[pixelIndex] !== surfaceId ||
          componentIds[pixelIndex] !== componentId
        ) {
          conflictMask[pixelIndex] = 2;
          if (triangleIds) triangleIds[pixelIndex] = 0;
        }
        continue;
      }
      const existingSurfaceId = surfaceIds[pixelIndex];
      const existingComponentId = componentIds[pixelIndex];
      const existingRegionId = regionIds[pixelIndex];
      if (
        existingSurfaceId !== 0 &&
        (existingSurfaceId !== surfaceId ||
          existingComponentId !== componentId ||
          existingRegionId !== regionId)
      ) {
        const sameSurfaceComponent =
          existingSurfaceId === surfaceId && existingComponentId === componentId;
        // Adjacent UV islands from one physical component commonly touch in a
        // texel because the conservative raster has a half-pixel support. The
        // texel is ambiguous as a donor, but writing one repaired skin colour
        // there is safe and closes the visible ear/chin seam. Cross-component
        // overlap remains a hard conflict but retains a deterministic owner
        // for explicit sparse-underlay writes.
        conflictMask[pixelIndex] = sameSurfaceComponent ? 1 : 2;
        if (sameSurfaceComponent) {
          regionIds[pixelIndex] = Math.min(existingRegionId, regionId);
        }
        if (triangleIds) triangleIds[pixelIndex] = 0;
        continue;
      }
      surfaceIds[pixelIndex] = surfaceId;
      componentIds[pixelIndex] = componentId;
      regionIds[pixelIndex] = regionId;
      if (triangleIds) triangleIds[pixelIndex] = triangleId;
    }
  }
}

async function rasterizeSources(
  sources: MeshTopologySource[],
  width: number,
  height: number,
  topologyMask: Uint8Array,
  coreMask: Uint8Array,
  surfaceIds: Uint32Array,
  componentIds: Uint32Array,
  regionIds: Uint32Array,
  conflictMask: Uint8Array,
  triangleIds: Uint32Array | undefined,
  scheduler: CooperativeScheduler,
  totalTriangles: number,
  onProgress?: (progress: ContentAwareTopologyProgress) => void,
) {
  let completed = 0;
  for (const source of sources) {
    for (let triangle = 0; triangle < source.triangleCount; triangle += 1) {
      const points = [0, 1, 2].map((slot) => {
        const vertexIndex = getTriangleVertexIndex(source, triangle, slot);
        return [
          source.uv.getX(vertexIndex) * (width - 1),
          (1 - source.uv.getY(vertexIndex)) * (height - 1),
        ] as const;
      });
      if (points.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y))) {
        const bounds = conservativeTriangleBounds(points, width, height);
        const pixelArea = bounds
          ? (bounds.maximumX - bounds.minimumX + 1) * (bounds.maximumY - bounds.minimumY + 1)
          : 0;
        const rowsPerChunk = pixelArea > 262_144 ? 32 : Number.POSITIVE_INFINITY;
        const firstRow = bounds?.minimumY ?? 0;
        const lastRow = bounds?.maximumY ?? -1;
        for (let row = firstRow; row <= lastRow; row += rowsPerChunk) {
          rasterizeConservativeTriangle(
            points,
            width,
            height,
            topologyMask,
            coreMask,
            surfaceIds,
            componentIds,
            regionIds,
            conflictMask,
            source.triangleSurfaceIds[triangle],
            source.triangleComponentIds[triangle],
            source.triangleRegionIds[triangle],
            triangleIds,
            source.globalTriangleOffset + triangle + 1,
            row,
            Math.min(lastRow, row + rowsPerChunk - 1),
          );
          if (Number.isFinite(rowsPerChunk)) await scheduler.checkpoint();
        }
      }
      completed += 1;
      if ((triangle & 1023) === 0) {
        onProgress?.({ phase: 'rasterize', completed, total: totalTriangles });
        await scheduler.checkpoint();
      }
    }
  }
}

type PixelPoint = { x: number; y: number };

function toPixel(uv: GeometryAttribute, vertexIndex: number, width: number, height: number) {
  return {
    x: uv.getX(vertexIndex) * (width - 1),
    y: (1 - uv.getY(vertexIndex)) * (height - 1),
  };
}

function inwardPixelNormal(edgeStart: PixelPoint, edgeEnd: PixelPoint, inside: PixelPoint) {
  const edgeX = edgeEnd.x - edgeStart.x;
  const edgeY = edgeEnd.y - edgeStart.y;
  const length = Math.hypot(edgeX, edgeY);
  if (length <= 1e-6) return { x: 0, y: 0 };
  let x = -edgeY / length;
  let y = edgeX / length;
  if ((inside.x - edgeStart.x) * x + (inside.y - edgeStart.y) * y < 0) {
    x = -x;
    y = -y;
  }
  return { x, y };
}

function clampPixelIndex(point: PixelPoint, width: number, height: number) {
  const x = Math.max(0, Math.min(width - 1, Math.round(point.x)));
  const y = Math.max(0, Math.min(height - 1, Math.round(point.y)));
  return y * width + x;
}

function orientedSeamEndpoints(
  source: MeshTopologySource,
  firstEncodedEdge: number,
  secondEncodedEdge: number,
) {
  const first = getEncodedEdgeVertices(source, firstEncodedEdge);
  const second = getEncodedEdgeVertices(source, secondEncodedEdge);
  const position = source.position;
  const directDistance =
    (position.getX(first.start) - position.getX(second.start)) ** 2 +
    (position.getY(first.start) - position.getY(second.start)) ** 2 +
    (position.getZ(first.start) - position.getZ(second.start)) ** 2;
  const crossedDistance =
    (position.getX(first.start) - position.getX(second.end)) ** 2 +
    (position.getY(first.start) - position.getY(second.end)) ** 2 +
    (position.getZ(first.start) - position.getZ(second.end)) ** 2;
  return {
    first,
    second:
      directDistance <= crossedDistance
        ? second
        : { start: second.end, end: second.start, inside: second.inside },
  };
}

async function buildSeamLinks(
  sources: MeshTopologySource[],
  width: number,
  height: number,
  coreMask: Uint8Array,
  surfaceIds: Uint32Array,
  componentIds: Uint32Array,
  bandPixels: number,
  scheduler: CooperativeScheduler,
  onProgress?: (progress: ContentAwareTopologyProgress) => void,
) {
  const pixelCount = width * height;
  const seamPairCount = sources.reduce((sum, source) => sum + source.seamEdgePairs.length / 2, 0);
  const uniqueLinks = new Set<number>();
  const links: number[] = [];
  let completed = 0;

  for (const source of sources) {
    for (let pairOffset = 0; pairOffset < source.seamEdgePairs.length; pairOffset += 2) {
      const { first, second } = orientedSeamEndpoints(
        source,
        source.seamEdgePairs[pairOffset],
        source.seamEdgePairs[pairOffset + 1],
      );
      const firstStart = toPixel(source.uv, first.start, width, height);
      const firstEnd = toPixel(source.uv, first.end, width, height);
      const firstInside = toPixel(source.uv, first.inside, width, height);
      const secondStart = toPixel(source.uv, second.start, width, height);
      const secondEnd = toPixel(source.uv, second.end, width, height);
      const secondInside = toPixel(source.uv, second.inside, width, height);
      const firstInward = inwardPixelNormal(firstStart, firstEnd, firstInside);
      const secondInward = inwardPixelNormal(secondStart, secondEnd, secondInside);
      const sampleCount = Math.max(
        1,
        Math.ceil(
          Math.max(
            Math.hypot(firstEnd.x - firstStart.x, firstEnd.y - firstStart.y),
            Math.hypot(secondEnd.x - secondStart.x, secondEnd.y - secondStart.y),
          ),
        ),
      );

      for (let sample = 0; sample < sampleCount; sample += 1) {
        const t = (sample + 0.5) / sampleCount;
        const firstEdge = {
          x: firstStart.x + (firstEnd.x - firstStart.x) * t,
          y: firstStart.y + (firstEnd.y - firstStart.y) * t,
        };
        const secondEdge = {
          x: secondStart.x + (secondEnd.x - secondStart.x) * t,
          y: secondStart.y + (secondEnd.y - secondStart.y) * t,
        };
        for (let depth = 0; depth < bandPixels; depth += 1) {
          const inset = depth + 0.35;
          const firstIndex = clampPixelIndex(
            {
              x: firstEdge.x + firstInward.x * inset,
              y: firstEdge.y + firstInward.y * inset,
            },
            width,
            height,
          );
          const secondIndex = clampPixelIndex(
            {
              x: secondEdge.x + secondInward.x * inset,
              y: secondEdge.y + secondInward.y * inset,
            },
            width,
            height,
          );
          if (firstIndex === secondIndex) continue;
          // A conservative-only texel can bridge propagation internally, but a
          // seam link must terminate on a real pixel-centre surface sample or
          // it can pull colour onto the visible outline of a UV island.
          if (!coreMask[firstIndex] || !coreMask[secondIndex]) continue;
          const firstSurface = surfaceIds[firstIndex];
          if (!firstSurface || firstSurface !== surfaceIds[secondIndex]) continue;
          const firstComponent = componentIds[firstIndex];
          const secondComponent = componentIds[secondIndex];
          if (!firstComponent || !secondComponent) continue;
          // Smooth UV seams normally remain in one component. A deliberately
          // relaxed bridge may connect two hard-edge components of the same
          // mesh/material surface; keeping the component ids distinct is what
          // prevents ordinary 2D propagation while this explicit link remains
          // bounded by maxSeamCrossings in the repair pass.
          const low = Math.min(firstIndex, secondIndex);
          const high = Math.max(firstIndex, secondIndex);
          const key = low * pixelCount + high;
          if (uniqueLinks.has(key)) continue;
          uniqueLinks.add(key);
          links.push(low, high);
        }
      }
      completed += 1;
      if ((completed & 255) === 0) {
        onProgress?.({ phase: 'seams', completed, total: seamPairCount });
        await scheduler.checkpoint();
      }
    }
  }
  return Uint32Array.from(links);
}

function attributeSignature(attribute?: GeometryAttribute | null) {
  if (!attribute) return '-';
  const version =
    attribute instanceof THREE.InterleavedBufferAttribute
      ? attribute.data.version
      : attribute.version;
  return `${attribute.count}:${attribute.itemSize}:${version}`;
}

function createCacheKey(
  root: THREE.Object3D,
  width: number,
  height: number,
  includeInvisible: boolean,
  includeSeamLinks: boolean,
  includeTriangleIds: boolean,
  seamBandPixels: number,
  minimumSeamNormalDot: number,
  minimumSeamBridgeNormalDot: number,
) {
  const parts = [
    `${width}x${height}`,
    includeInvisible ? 'all' : 'visible',
    includeSeamLinks
      ? `seams:${seamBandPixels}:${minimumSeamNormalDot}:${minimumSeamBridgeNormalDot}`
      : 'no-seams',
    includeTriangleIds ? 'triangles' : 'no-triangles',
  ];
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh) || (!includeInvisible && !object.visible)) return;
    if (
      object.userData.liclickPaintOverlay ||
      object.userData.liclickViewportHelper ||
      object.userData.liclickSelectionGlow ||
      object.userData.liclickWireframeOverlay
    )
      return;
    const geometry = object.geometry;
    const groups = geometry.groups
      .map(
        (group: THREE.BufferGeometry['groups'][number]) =>
          `${group.start},${group.count},${group.materialIndex ?? 0}`,
      )
      .join(';');
    parts.push(
      [
        object.uuid,
        geometry.uuid,
        attributeSignature(geometry.getAttribute('position')),
        attributeSignature(geometry.getAttribute('uv')),
        attributeSignature(geometry.getAttribute('normal')),
        attributeSignature(geometry.getIndex()),
        groups,
      ].join('/'),
    );
  });
  return parts.join('|');
}

function rememberCachedTopology(
  root: THREE.Object3D,
  cacheKey: string,
  result: ContentAwareSurfaceTopology,
) {
  let rootCache = topologyCache.get(root);
  if (!rootCache) {
    rootCache = new Map();
    topologyCache.set(root, rootCache);
  }
  rootCache.delete(cacheKey);
  rootCache.set(cacheKey, result);
  while (rootCache.size > MAX_CACHE_ENTRIES_PER_ROOT) {
    const oldestKey = rootCache.keys().next().value as string | undefined;
    if (oldestKey === undefined) break;
    rootCache.delete(oldestKey);
  }
}

/**
 * Builds immutable-by-contract UV topology metadata for content-aware repair.
 *
 * Connectivity is deliberately scoped to one Mesh and one material slot. UV
 * islands split from the same geometric surface share a component id and are
 * connected only by seamLinks; unrelated meshes/materials can never become
 * sampling neighbors merely because their atlas coordinates or world positions
 * overlap. The returned typed arrays must be treated as read-only so cached
 * builds can be reused without cloning several 2K/4K buffers.
 */
export async function buildContentAwareSurfaceTopology(
  root: THREE.Object3D,
  width: number,
  height: number,
  options: BuildContentAwareSurfaceTopologyOptions = {},
): Promise<ContentAwareSurfaceTopology> {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`Invalid content-aware topology size: ${width}x${height}.`);
  }
  const pixelCount = width * height;
  if (!Number.isSafeInteger(pixelCount) || pixelCount > 0x7fffffff) {
    throw new Error(`Content-aware topology is too large: ${width}x${height}.`);
  }

  const includeInvisible = options.includeInvisible ?? true;
  const includeSeamLinks = options.includeSeamLinks ?? true;
  const includeTriangleIds = options.includeTriangleIds ?? false;
  const seamBandPixels = Math.max(1, Math.min(8, Math.round(options.seamBandPixels ?? 2)));
  const minimumSeamNormalDot = Math.max(
    -1,
    Math.min(1, options.minimumSeamNormalDot ?? DEFAULT_MINIMUM_SEAM_NORMAL_DOT),
  );
  const minimumSeamBridgeNormalDot = Math.max(
    -1,
    Math.min(
      minimumSeamNormalDot,
      options.minimumSeamBridgeNormalDot ?? DEFAULT_MINIMUM_SEAM_BRIDGE_NORMAL_DOT,
    ),
  );
  const cacheKey = createCacheKey(
    root,
    width,
    height,
    includeInvisible,
    includeSeamLinks,
    includeTriangleIds,
    seamBandPixels,
    minimumSeamNormalDot,
    minimumSeamBridgeNormalDot,
  );
  const cached = topologyCache.get(root)?.get(cacheKey);
  if (cached) {
    throwIfAborted(options.signal);
    options.onProgress?.({ phase: 'complete', completed: 1, total: 1 });
    return cached;
  }

  const startedAt = now();
  const scheduler = new CooperativeScheduler(
    Math.max(2, options.yieldIntervalMs ?? DEFAULT_YIELD_INTERVAL_MS),
    options.signal,
  );
  const { sources, triangleCount } = collectMeshSources(root, includeInvisible);
  const state: MutableBuildState = {
    nextSurfaceId: 1,
    nextComponentId: 1,
    nextRegionId: 1,
    surfaces: [],
    componentSurfaceIds: [0],
  };
  let analyzedTriangles = 0;
  for (const source of sources) {
    await analyzeMesh(
      source,
      state,
      scheduler,
      includeSeamLinks,
      minimumSeamNormalDot,
      minimumSeamBridgeNormalDot,
      analyzedTriangles,
      triangleCount,
      options.onProgress,
    );
    analyzedTriangles += source.triangleCount;
    await scheduler.checkpoint();
  }

  const topologyMask = new Uint8Array(pixelCount);
  const coreMask = new Uint8Array(pixelCount);
  const surfaceIds = new Uint32Array(pixelCount);
  const componentIds = new Uint32Array(pixelCount);
  const regionIds = new Uint32Array(pixelCount);
  const conflictMask = new Uint8Array(pixelCount);
  const triangleIds = includeTriangleIds ? new Uint32Array(pixelCount) : undefined;
  await rasterizeSources(
    sources,
    width,
    height,
    topologyMask,
    coreMask,
    surfaceIds,
    componentIds,
    regionIds,
    conflictMask,
    triangleIds,
    scheduler,
    triangleCount,
    options.onProgress,
  );
  const seamLinks = includeSeamLinks
    ? await buildSeamLinks(
        sources,
        width,
        height,
        coreMask,
        surfaceIds,
        componentIds,
        seamBandPixels,
        scheduler,
        options.onProgress,
      )
    : new Uint32Array();
  throwIfAborted(options.signal);

  const result: ContentAwareSurfaceTopology = {
    width,
    height,
    topologyMask,
    coreMask,
    regionIds,
    conflictMask,
    triangleIds,
    seamLinks,
    componentSurfaceIds: Uint32Array.from(state.componentSurfaceIds),
    surfaces: state.surfaces,
    surfaceCount: state.nextSurfaceId - 1,
    componentCount: state.nextComponentId - 1,
    regionCount: state.nextRegionId - 1,
    triangleCount,
    seamLinkCount: seamLinks.length / 2,
    buildTimeMs: now() - startedAt,
  };
  rememberCachedTopology(root, cacheKey, result);
  options.onProgress?.({ phase: 'complete', completed: 1, total: 1 });
  return result;
}

export function clearContentAwareSurfaceTopologyCache(root?: THREE.Object3D) {
  if (root) topologyCache.delete(root);
  else topologyCache = new WeakMap();
}
