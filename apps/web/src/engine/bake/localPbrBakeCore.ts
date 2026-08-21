const MathUtils = { clamp: (value: number, min: number, max: number) => Math.max(min, Math.min(max, value)) };
const DoubleSide = 2;

class Vector3 {
  constructor(public x = 0, public y = 0, public z = 0) {}
  set(x: number, y: number, z: number) { this.x = x; this.y = y; this.z = z; return this; }
  copy(value: Vector3) { return this.set(value.x, value.y, value.z); }
  subVectors(a: Vector3, b: Vector3) { return this.set(a.x - b.x, a.y - b.y, a.z - b.z); }
  multiplyScalar(value: number) { this.x *= value; this.y *= value; this.z *= value; return this; }
  addScaledVector(value: Vector3, scale: number) {
    this.x += value.x * scale; this.y += value.y * scale; this.z += value.z * scale; return this;
  }
  dot(value: Vector3) { return this.x * value.x + this.y * value.y + this.z * value.z; }
  length() { return Math.hypot(this.x, this.y, this.z); }
  cross(value: Vector3) { return this.crossVectors(this, value); }
  crossVectors(a: Vector3, b: Vector3) {
    const x = a.y * b.z - a.z * b.y;
    const y = a.z * b.x - a.x * b.z;
    const z = a.x * b.y - a.y * b.x;
    return this.set(x, y, z);
  }
  normalize() {
    const length = Math.hypot(this.x, this.y, this.z);
    return length > 1e-20 ? this.multiplyScalar(1 / length) : this.set(0, 0, 0);
  }
}

class Ray {
  origin = new Vector3();
  direction = new Vector3(0, 0, 1);
  set(origin: Vector3, direction: Vector3) {
    this.origin.copy(origin); this.direction.copy(direction); return this;
  }
}

class Box3 {
  min = new Vector3(Infinity, Infinity, Infinity);
  max = new Vector3(-Infinity, -Infinity, -Infinity);
  expandByPoint(point: Vector3) {
    this.min.x = Math.min(this.min.x, point.x); this.min.y = Math.min(this.min.y, point.y); this.min.z = Math.min(this.min.z, point.z);
    this.max.x = Math.max(this.max.x, point.x); this.max.y = Math.max(this.max.y, point.y); this.max.z = Math.max(this.max.z, point.z);
  }
  getSize(target: Vector3) { return target.set(this.max.x - this.min.x, this.max.y - this.min.y, this.max.z - this.min.z); }
}

export type LocalBakeChannel =
  | 'normal'
  | 'ambientOcclusion'
  | 'worldNormal'
  | 'position'
  | 'thickness';

export type LocalBakeMeshData = {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  uvs?: Float32Array;
};

export type LocalPbrBakeInput = {
  high: LocalBakeMeshData;
  low: LocalBakeMeshData[];
  resolution: number;
  padding: number;
  frontalDistance: number;
  rearDistance: number;
  normalOrientation: 'directx' | 'opengl';
  aoSamples: number;
  channels: LocalBakeChannel[];
};

export type LocalPbrBakeResult = {
  width: number;
  height: number;
  outputs: Partial<Record<LocalBakeChannel, Uint8Array>>;
  coveredPixels: number;
  missedPixels: number;
  overlapPixels: number;
  triangleCount: number;
};

type BvhHit = { point: Vector3; normal: Vector3; distance: number };
type BvhNode = {
  minX: number; minY: number; minZ: number;
  maxX: number; maxY: number; maxZ: number;
  start: number; count: number; left: number; right: number;
};

/** Compact, dependency-free median BVH used only inside the bake Worker. */
class TriangleBvh {
  private readonly order: Uint32Array;
  private readonly bounds: Float32Array;
  private readonly nodes: BvhNode[] = [];

  constructor(private readonly mesh: LocalBakeMeshData) {
    const triangleCount = mesh.indices.length / 3;
    this.order = new Uint32Array(triangleCount);
    this.bounds = new Float32Array(triangleCount * 9);
    for (let triangle = 0; triangle < triangleCount; triangle += 1) {
      this.order[triangle] = triangle;
      this.measureTriangle(triangle);
    }
    this.build(0, triangleCount);
  }

  private measureTriangle(triangle: number) {
    const indices = this.mesh.indices;
    const positions = this.mesh.positions;
    const i0 = indices[triangle * 3] * 3;
    const i1 = indices[triangle * 3 + 1] * 3;
    const i2 = indices[triangle * 3 + 2] * 3;
    const offset = triangle * 9;
    for (let axis = 0; axis < 3; axis += 1) {
      const a = positions[i0 + axis], b = positions[i1 + axis], c = positions[i2 + axis];
      this.bounds[offset + axis] = Math.min(a, b, c);
      this.bounds[offset + 3 + axis] = Math.max(a, b, c);
      this.bounds[offset + 6 + axis] = (a + b + c) / 3;
    }
  }

  private centroidAt(cursor: number, axis: number) {
    return this.bounds[this.order[cursor] * 9 + 6 + axis];
  }

  private swap(a: number, b: number) {
    const value = this.order[a];
    this.order[a] = this.order[b];
    this.order[b] = value;
  }

  private partition(left: number, right: number, pivot: number, axis: number) {
    const pivotValue = this.centroidAt(pivot, axis);
    this.swap(pivot, right);
    let store = left;
    for (let cursor = left; cursor < right; cursor += 1) {
      if (this.centroidAt(cursor, axis) < pivotValue) this.swap(store++, cursor);
    }
    this.swap(right, store);
    return store;
  }

  private selectMedian(left: number, right: number, target: number, axis: number) {
    while (left < right) {
      const pivot = this.partition(left, right, left + Math.floor((right - left) / 2), axis);
      if (pivot === target) return;
      if (target < pivot) right = pivot - 1;
      else left = pivot + 1;
    }
  }

  private build(start: number, end: number): number {
    const nodeIndex = this.nodes.length;
    const node: BvhNode = {
      minX: Infinity, minY: Infinity, minZ: Infinity,
      maxX: -Infinity, maxY: -Infinity, maxZ: -Infinity,
      start, count: end - start, left: -1, right: -1,
    };
    this.nodes.push(node);
    let cMinX = Infinity, cMinY = Infinity, cMinZ = Infinity;
    let cMaxX = -Infinity, cMaxY = -Infinity, cMaxZ = -Infinity;
    for (let cursor = start; cursor < end; cursor += 1) {
      const offset = this.order[cursor] * 9;
      node.minX = Math.min(node.minX, this.bounds[offset]);
      node.minY = Math.min(node.minY, this.bounds[offset + 1]);
      node.minZ = Math.min(node.minZ, this.bounds[offset + 2]);
      node.maxX = Math.max(node.maxX, this.bounds[offset + 3]);
      node.maxY = Math.max(node.maxY, this.bounds[offset + 4]);
      node.maxZ = Math.max(node.maxZ, this.bounds[offset + 5]);
      cMinX = Math.min(cMinX, this.bounds[offset + 6]); cMaxX = Math.max(cMaxX, this.bounds[offset + 6]);
      cMinY = Math.min(cMinY, this.bounds[offset + 7]); cMaxY = Math.max(cMaxY, this.bounds[offset + 7]);
      cMinZ = Math.min(cMinZ, this.bounds[offset + 8]); cMaxZ = Math.max(cMaxZ, this.bounds[offset + 8]);
    }
    if (end - start <= 8) return nodeIndex;
    const extents = [cMaxX - cMinX, cMaxY - cMinY, cMaxZ - cMinZ];
    const axis = extents[1] > extents[0] ? (extents[2] > extents[1] ? 2 : 1) : (extents[2] > extents[0] ? 2 : 0);
    const middle = start + Math.floor((end - start) / 2);
    this.selectMedian(start, end - 1, middle, axis);
    node.count = 0;
    node.left = this.build(start, middle);
    node.right = this.build(middle, end);
    return nodeIndex;
  }

  private intersects(node: BvhNode, ray: Ray, maxDistance: number) {
    let near = 0;
    let far = maxDistance;
    for (const [origin, direction, min, max] of [
      [ray.origin.x, ray.direction.x, node.minX, node.maxX],
      [ray.origin.y, ray.direction.y, node.minY, node.maxY],
      [ray.origin.z, ray.direction.z, node.minZ, node.maxZ],
    ]) {
      if (Math.abs(direction) < 1e-20) {
        if (origin < min || origin > max) return false;
        continue;
      }
      const inverse = 1 / direction;
      let axisNear = (min - origin) * inverse;
      let axisFar = (max - origin) * inverse;
      if (axisNear > axisFar) [axisNear, axisFar] = [axisFar, axisNear];
      near = Math.max(near, axisNear);
      far = Math.min(far, axisFar);
      if (far < near) return false;
    }
    return true;
  }

  private intersectTriangle(triangle: number, ray: Ray, minDistance: number, maxDistance: number): BvhHit | undefined {
    const indices = this.mesh.indices;
    const positions = this.mesh.positions;
    const normals = this.mesh.normals;
    const ai = indices[triangle * 3], bi = indices[triangle * 3 + 1], ci = indices[triangle * 3 + 2];
    const a = ai * 3, b = bi * 3, c = ci * 3;
    const e1x = positions[b] - positions[a], e1y = positions[b + 1] - positions[a + 1], e1z = positions[b + 2] - positions[a + 2];
    const e2x = positions[c] - positions[a], e2y = positions[c + 1] - positions[a + 1], e2z = positions[c + 2] - positions[a + 2];
    const px = ray.direction.y * e2z - ray.direction.z * e2y;
    const py = ray.direction.z * e2x - ray.direction.x * e2z;
    const pz = ray.direction.x * e2y - ray.direction.y * e2x;
    const determinant = e1x * px + e1y * py + e1z * pz;
    if (Math.abs(determinant) < 1e-12) return undefined;
    const inverse = 1 / determinant;
    const tx = ray.origin.x - positions[a], ty = ray.origin.y - positions[a + 1], tz = ray.origin.z - positions[a + 2];
    const u = (tx * px + ty * py + tz * pz) * inverse;
    if (u < 0 || u > 1) return undefined;
    const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
    const v = (ray.direction.x * qx + ray.direction.y * qy + ray.direction.z * qz) * inverse;
    if (v < 0 || u + v > 1) return undefined;
    const distance = (e2x * qx + e2y * qy + e2z * qz) * inverse;
    if (distance < minDistance || distance > maxDistance) return undefined;
    const w = 1 - u - v;
    const normal = new Vector3(
      normals[a] * w + normals[b] * u + normals[c] * v,
      normals[a + 1] * w + normals[b + 1] * u + normals[c + 1] * v,
      normals[a + 2] * w + normals[b + 2] * u + normals[c + 2] * v,
    ).normalize();
    return {
      distance,
      point: new Vector3(
        ray.origin.x + ray.direction.x * distance,
        ray.origin.y + ray.direction.y * distance,
        ray.origin.z + ray.direction.z * distance,
      ),
      normal,
    };
  }

  raycastFirst(ray: Ray, _side: number, minDistance: number, maxDistance: number): BvhHit | undefined {
    let closest: BvhHit | undefined;
    const stack = [0];
    while (stack.length) {
      const node = this.nodes[stack.pop()!];
      if (!this.intersects(node, ray, closest?.distance ?? maxDistance)) continue;
      if (node.count > 0) {
        for (let cursor = node.start; cursor < node.start + node.count; cursor += 1) {
          const hit = this.intersectTriangle(this.order[cursor], ray, minDistance, closest?.distance ?? maxDistance);
          if (hit) closest = hit;
        }
      } else {
        stack.push(node.left, node.right);
      }
    }
    return closest;
  }
}

const scratch = {
  p0: new Vector3(),
  p1: new Vector3(),
  p2: new Vector3(),
  n0: new Vector3(),
  n1: new Vector3(),
  n2: new Vector3(),
  position: new Vector3(),
  lowNormal: new Vector3(),
  highNormal: new Vector3(),
  tangent: new Vector3(),
  bitangent: new Vector3(),
  edge1: new Vector3(),
  edge2: new Vector3(),
  ray: new Ray(),
  aoDirection: new Vector3(),
  aoTangent: new Vector3(),
  aoBitangent: new Vector3(),
  tangentNormal: new Vector3(),
  rayOrigin: new Vector3(),
  rayDirection: new Vector3(),
};

function readVec3(array: Float32Array, index: number, target: Vector3) {
  return target.set(array[index * 3], array[index * 3 + 1], array[index * 3 + 2]);
}

function barycentric2d(
  x: number,
  y: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
) {
  const v0x = bx - ax;
  const v0y = by - ay;
  const v1x = cx - ax;
  const v1y = cy - ay;
  const v2x = x - ax;
  const v2y = y - ay;
  const denominator = v0x * v1y - v1x * v0y;
  if (Math.abs(denominator) < 1e-10) return undefined;
  const b = (v2x * v1y - v1x * v2y) / denominator;
  const c = (v0x * v2y - v2x * v0y) / denominator;
  const a = 1 - b - c;
  return a >= -0.0001 && b >= -0.0001 && c >= -0.0001 ? [a, b, c] as const : undefined;
}

function writeVectorPixel(output: Uint8Array, pixel: number, vector: Vector3, alpha = 255) {
  const offset = pixel * 4;
  output[offset] = Math.round(MathUtils.clamp(vector.x * 0.5 + 0.5, 0, 1) * 255);
  output[offset + 1] = Math.round(MathUtils.clamp(vector.y * 0.5 + 0.5, 0, 1) * 255);
  output[offset + 2] = Math.round(MathUtils.clamp(vector.z * 0.5 + 0.5, 0, 1) * 255);
  output[offset + 3] = alpha;
}

function createOutputs(channels: LocalBakeChannel[], pixelCount: number) {
  return Object.fromEntries(channels.map((channel) => [channel, new Uint8Array(pixelCount * 4)])) as
    Partial<Record<LocalBakeChannel, Uint8Array>>;
}

function buildBounds(positions: Float32Array) {
  const box = new Box3();
  const point = new Vector3();
  for (let index = 0; index < positions.length; index += 3) {
    point.set(positions[index], positions[index + 1], positions[index + 2]);
    box.expandByPoint(point);
  }
  const size = box.getSize(new Vector3());
  return { box, size, diagonal: Math.max(size.length(), 1e-5) };
}

function computeFaceBasis(
  p0: Vector3,
  p1: Vector3,
  p2: Vector3,
  uv0: readonly [number, number],
  uv1: readonly [number, number],
  uv2: readonly [number, number],
  normal: Vector3,
) {
  const edge1 = scratch.edge1.subVectors(p1, p0);
  const edge2 = scratch.edge2.subVectors(p2, p0);
  const du1 = uv1[0] - uv0[0];
  const dv1 = uv1[1] - uv0[1];
  const du2 = uv2[0] - uv0[0];
  const dv2 = uv2[1] - uv0[1];
  const determinant = du1 * dv2 - du2 * dv1;
  if (Math.abs(determinant) < 1e-10) return false;
  scratch.tangent
    .copy(edge1)
    .multiplyScalar(dv2)
    .addScaledVector(edge2, -dv1)
    .multiplyScalar(1 / determinant)
    .addScaledVector(normal, -scratch.tangent.dot(normal))
    .normalize();
  const rawBitangent = scratch.bitangent
    .copy(edge2)
    .multiplyScalar(du1)
    .addScaledVector(edge1, -du2)
    .multiplyScalar(1 / determinant)
    .normalize();
  const sign = new Vector3().crossVectors(normal, scratch.tangent).dot(rawBitangent) < 0 ? -1 : 1;
  scratch.bitangent.crossVectors(normal, scratch.tangent).multiplyScalar(sign).normalize();
  return true;
}

function sampleAmbientOcclusion(
  bvh: TriangleBvh,
  point: Vector3,
  normal: Vector3,
  maxDistance: number,
  samples: number,
  seed: number,
  epsilon: number,
) {
  if (samples <= 0) return 1;
  const helper = Math.abs(normal.z) < 0.999
    ? scratch.aoTangent.set(0, 0, 1)
    : scratch.aoTangent.set(0, 1, 0);
  helper.cross(normal).normalize();
  scratch.aoBitangent.crossVectors(normal, helper).normalize();
  let occluded = 0;
  for (let sample = 0; sample < samples; sample += 1) {
    const sequence = (sample + 0.5) / samples;
    const radius = Math.sqrt(sequence);
    const angle = (sample * 2.399963229728653 + (seed % 997) * 0.017) % (Math.PI * 2);
    const x = Math.cos(angle) * radius;
    const y = Math.sin(angle) * radius;
    const z = Math.sqrt(Math.max(0, 1 - radius * radius));
    const direction = scratch.aoDirection
      .copy(helper)
      .multiplyScalar(x)
      .addScaledVector(scratch.aoBitangent, y)
      .addScaledVector(normal, z)
      .normalize();
    scratch.ray.set(scratch.rayOrigin.copy(point).addScaledVector(normal, epsilon), direction);
    if (bvh.raycastFirst(scratch.ray, DoubleSide, epsilon, maxDistance)) occluded += 1;
  }
  return 1 - occluded / samples;
}

function dilateOutputs(
  outputs: Partial<Record<LocalBakeChannel, Uint8Array>>,
  coverage: Uint8Array,
  resolution: number,
  padding: number,
) {
  if (padding <= 0) return;
  const pixelCount = resolution * resolution;
  const source = new Int32Array(pixelCount);
  source.fill(-1);
  const distance = new Uint16Array(pixelCount);
  distance.fill(0xffff);
  const queue = new Int32Array(pixelCount);
  let head = 0;
  let tail = 0;
  for (let pixel = 0; pixel < pixelCount; pixel += 1) {
    if (!coverage[pixel]) continue;
    source[pixel] = pixel;
    distance[pixel] = 0;
    queue[tail++] = pixel;
  }
  while (head < tail) {
    const pixel = queue[head++];
    const nextDistance = distance[pixel] + 1;
    if (nextDistance > padding) continue;
    const x = pixel % resolution;
    const neighbors = [
      x > 0 ? pixel - 1 : -1,
      x + 1 < resolution ? pixel + 1 : -1,
      pixel >= resolution ? pixel - resolution : -1,
      pixel + resolution < pixelCount ? pixel + resolution : -1,
    ];
    for (const neighbor of neighbors) {
      if (neighbor < 0 || distance[neighbor] <= nextDistance) continue;
      distance[neighbor] = nextDistance;
      source[neighbor] = source[pixel];
      queue[tail++] = neighbor;
    }
  }
  for (const output of Object.values(outputs)) {
    if (!output) continue;
    for (let pixel = 0; pixel < pixelCount; pixel += 1) {
      if (coverage[pixel] || source[pixel] < 0) continue;
      const from = source[pixel] * 4;
      const to = pixel * 4;
      output[to] = output[from];
      output[to + 1] = output[from + 1];
      output[to + 2] = output[from + 2];
      output[to + 3] = output[from + 3];
    }
  }
}

export function bakePbrMapsLocally(
  input: LocalPbrBakeInput,
  onProgress?: (progress: number) => void,
): LocalPbrBakeResult {
  if (!input.low.length) throw new Error('本地 Bake 缺少低模。');
  if (input.resolution < 16 || input.resolution > 2048) {
    throw new Error('浏览器本地 Bake 当前支持 16 到 2048 分辨率。');
  }
  const bvh = new TriangleBvh(input.high);
  const bounds = buildBounds(input.high.positions);
  const pixelCount = input.resolution * input.resolution;
  const outputs = createOutputs(input.channels, pixelCount);
  const coverage = new Uint8Array(pixelCount);
  const rayEpsilon = bounds.diagonal * 1e-5;
  const rear = Math.max(input.rearDistance, rayEpsilon * 2);
  const span = rear + Math.max(input.frontalDistance, rayEpsilon * 2);
  const aoDistance = Math.max(span * 2, bounds.diagonal * 0.02);
  let coveredPixels = 0;
  let missedPixels = 0;
  let overlapPixels = 0;
  let processedTriangles = 0;
  const triangleCount = input.low.reduce((sum, mesh) => sum + mesh.indices.length / 3, 0);

  for (const mesh of input.low) {
      if (!mesh.uvs) throw new Error('低模缺少 UV0。');
      for (let triangle = 0; triangle < mesh.indices.length; triangle += 3) {
        const i0 = mesh.indices[triangle];
        const i1 = mesh.indices[triangle + 1];
        const i2 = mesh.indices[triangle + 2];
        const p0 = readVec3(mesh.positions, i0, scratch.p0);
        const p1 = readVec3(mesh.positions, i1, scratch.p1);
        const p2 = readVec3(mesh.positions, i2, scratch.p2);
        const uv0 = [mesh.uvs[i0 * 2], mesh.uvs[i0 * 2 + 1]] as const;
        const uv1 = [mesh.uvs[i1 * 2], mesh.uvs[i1 * 2 + 1]] as const;
        const uv2 = [mesh.uvs[i2 * 2], mesh.uvs[i2 * 2 + 1]] as const;
        const ax = uv0[0] * (input.resolution - 1);
        const ay = (1 - uv0[1]) * (input.resolution - 1);
        const bx = uv1[0] * (input.resolution - 1);
        const by = (1 - uv1[1]) * (input.resolution - 1);
        const cx = uv2[0] * (input.resolution - 1);
        const cy = (1 - uv2[1]) * (input.resolution - 1);
        const minX = Math.max(0, Math.floor(Math.min(ax, bx, cx)));
        const maxX = Math.min(input.resolution - 1, Math.ceil(Math.max(ax, bx, cx)));
        const minY = Math.max(0, Math.floor(Math.min(ay, by, cy)));
        const maxY = Math.min(input.resolution - 1, Math.ceil(Math.max(ay, by, cy)));
        const faceNormal = scratch.lowNormal
          .subVectors(p1, p0)
          .cross(scratch.edge2.subVectors(p2, p0))
          .normalize();
        if (!computeFaceBasis(p0, p1, p2, uv0, uv1, uv2, faceNormal)) continue;

        for (let y = minY; y <= maxY; y += 1) {
          for (let x = minX; x <= maxX; x += 1) {
            const barycentric = barycentric2d(x + 0.5, y + 0.5, ax, ay, bx, by, cx, cy);
            if (!barycentric) continue;
            const pixel = y * input.resolution + x;
            if (coverage[pixel]) overlapPixels += 1;
            const [a, b, c] = barycentric;
            scratch.position
              .copy(p0)
              .multiplyScalar(a)
              .addScaledVector(p1, b)
              .addScaledVector(p2, c);
            scratch.lowNormal
              .copy(readVec3(mesh.normals, i0, scratch.n0))
              .multiplyScalar(a)
              .addScaledVector(readVec3(mesh.normals, i1, scratch.n1), b)
              .addScaledVector(readVec3(mesh.normals, i2, scratch.n2), c)
              .normalize();
            scratch.ray.set(
              scratch.rayOrigin.copy(scratch.position).addScaledVector(scratch.lowNormal, -rear),
              scratch.lowNormal,
            );
            const hit = bvh.raycastFirst(scratch.ray, DoubleSide, rayEpsilon, span);
            if (!hit) {
              missedPixels += 1;
              continue;
            }
            const hitNormal = hit.normal;
            if (!hitNormal) {
              missedPixels += 1;
              continue;
            }
            scratch.highNormal.copy(hitNormal).normalize();
            if (scratch.highNormal.dot(scratch.lowNormal) < 0) scratch.highNormal.multiplyScalar(-1);
            if (!coverage[pixel]) coveredPixels += 1;
            coverage[pixel] = 1;

            const normalOutput = outputs.normal;
            if (normalOutput) {
              const tangentNormal = scratch.tangentNormal.set(
                scratch.highNormal.dot(scratch.tangent),
                scratch.highNormal.dot(scratch.bitangent) * (input.normalOrientation === 'directx' ? -1 : 1),
                scratch.highNormal.dot(scratch.lowNormal),
              ).normalize();
              writeVectorPixel(normalOutput, pixel, tangentNormal);
            }
            if (outputs.worldNormal) writeVectorPixel(outputs.worldNormal, pixel, scratch.highNormal);
            const positionOutput = outputs.position;
            if (positionOutput) {
              const offset = pixel * 4;
              positionOutput[offset] = Math.round(MathUtils.clamp((hit.point.x - bounds.box.min.x) / Math.max(bounds.size.x, 1e-6), 0, 1) * 255);
              positionOutput[offset + 1] = Math.round(MathUtils.clamp((hit.point.y - bounds.box.min.y) / Math.max(bounds.size.y, 1e-6), 0, 1) * 255);
              positionOutput[offset + 2] = Math.round(MathUtils.clamp((hit.point.z - bounds.box.min.z) / Math.max(bounds.size.z, 1e-6), 0, 1) * 255);
              positionOutput[offset + 3] = 255;
            }
            const aoOutput = outputs.ambientOcclusion;
            if (aoOutput) {
              const ao = sampleAmbientOcclusion(
                bvh,
                hit.point,
                scratch.highNormal,
                aoDistance,
                input.aoSamples,
                pixel,
                rayEpsilon,
              );
              const value = Math.round(ao * 255);
              const offset = pixel * 4;
              aoOutput[offset] = value;
              aoOutput[offset + 1] = value;
              aoOutput[offset + 2] = value;
              aoOutput[offset + 3] = 255;
            }
            const thicknessOutput = outputs.thickness;
            if (thicknessOutput) {
              scratch.ray.set(
                scratch.rayOrigin.copy(hit.point).addScaledVector(scratch.highNormal, -rayEpsilon * 2),
                scratch.rayDirection.copy(scratch.highNormal).multiplyScalar(-1),
              );
              const opposite = bvh.raycastFirst(
                scratch.ray,
                DoubleSide,
                rayEpsilon,
                bounds.diagonal,
              );
              const value = Math.round(
                MathUtils.clamp((opposite?.distance ?? 0) / bounds.diagonal, 0, 1) * 255,
              );
              const offset = pixel * 4;
              thicknessOutput[offset] = value;
              thicknessOutput[offset + 1] = value;
              thicknessOutput[offset + 2] = value;
              thicknessOutput[offset + 3] = 255;
            }
          }
        }
        processedTriangles += 1;
        if (processedTriangles % 16 === 0 || processedTriangles === triangleCount) {
          onProgress?.(processedTriangles / Math.max(triangleCount, 1));
        }
      }
    }
    dilateOutputs(outputs, coverage, input.resolution, input.padding);
  return {
    width: input.resolution,
    height: input.resolution,
    outputs,
    coveredPixels,
    missedPixels,
    overlapPixels,
    triangleCount,
  };
}
