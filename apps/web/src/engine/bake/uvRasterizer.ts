import * as THREE from 'three';
import { getBarycentric, interpolate3, isInsideBarycentric } from './barycentric';
import { dilateImageData } from './dilation';
import { sampleImageNearest } from './imageSampler';
import type { BakeProjectedLayerInput } from './uvBakeTypes';
import { buildProjectionMatrixBundle } from '@/engine/projection/projectionMath';
import type { Layer } from '@/types/layer';

type RasterizeInput = {
  group: THREE.Group;
  layer: Layer;
  projectedImage: ImageData;
  bakeInput: BakeProjectedLayerInput;
};

export type RasterizeOutput = {
  canvas: HTMLCanvasElement;
  coverage: Uint8Array;
  totalTriangles: number;
  processedTriangles: number;
  coveredPixels: number;
  skippedPixels: number;
  warnings: string[];
};

const baseColor = [185, 163, 255, 255] as const;

function createBaseImageData(width: number, height: number) {
  const imageData = new ImageData(width, height);
  for (let offset = 0; offset < imageData.data.length; offset += 4) {
    imageData.data[offset] = baseColor[0];
    imageData.data[offset + 1] = baseColor[1];
    imageData.data[offset + 2] = baseColor[2];
    imageData.data[offset + 3] = baseColor[3];
  }
  return imageData;
}

function getAttributeTuple3(attribute: THREE.BufferAttribute | THREE.InterleavedBufferAttribute, index: number) {
  return [attribute.getX(index), attribute.getY(index), attribute.getZ(index)] as [number, number, number];
}

function getAttributeTuple2(attribute: THREE.BufferAttribute | THREE.InterleavedBufferAttribute, index: number) {
  return { x: attribute.getX(index), y: attribute.getY(index) };
}

function uvToPixel(uv: { x: number; y: number }, resolution: number) {
  return {
    x: uv.x * (resolution - 1),
    y: (1 - uv.y) * (resolution - 1),
  };
}

function blendPixel(imageData: ImageData, offset: number, color: [number, number, number, number], opacity: number) {
  const alpha = (color[3] / 255) * opacity;
  imageData.data[offset] = Math.round(imageData.data[offset] * (1 - alpha) + color[0] * alpha);
  imageData.data[offset + 1] = Math.round(imageData.data[offset + 1] * (1 - alpha) + color[1] * alpha);
  imageData.data[offset + 2] = Math.round(imageData.data[offset + 2] * (1 - alpha) + color[2] * alpha);
  imageData.data[offset + 3] = 255;
}

function projectWorldToImageUv(worldPosition: THREE.Vector3, projectorMatrix: THREE.Matrix4) {
  const projected = new THREE.Vector4(worldPosition.x, worldPosition.y, worldPosition.z, 1).applyMatrix4(
    projectorMatrix,
  );
  if (projected.w === 0) return undefined;
  const ndcX = projected.x / projected.w;
  const ndcY = projected.y / projected.w;
  const ndcZ = projected.z / projected.w;
  if (ndcX < -1 || ndcX > 1 || ndcY < -1 || ndcY > 1 || ndcZ < -1 || ndcZ > 1) return undefined;
  return {
    u: ndcX * 0.5 + 0.5,
    v: 1 - (ndcY * 0.5 + 0.5),
  };
}

async function yieldToMainThread() {
  await new Promise((resolve) => window.setTimeout(resolve, 0));
}

export async function rasterizeProjectedLayerToUv(input: RasterizeInput): Promise<RasterizeOutput> {
  if (!input.layer.camera) throw new Error('Projected layer has no capture camera.');
  const resolution = input.bakeInput.resolution;
  const canvas = document.createElement('canvas');
  canvas.width = resolution;
  canvas.height = resolution;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('Could not create UV bake canvas.');

  const imageData = createBaseImageData(resolution, resolution);
  const coverage = new Uint8Array(resolution * resolution);
  const projectorMatrix = buildProjectionMatrixBundle(input.layer.camera).projectorMatrix;
  const cameraPosition = new THREE.Vector3().fromArray(input.layer.camera.position);
  const warnings: string[] = [];
  let totalTriangles = 0;
  let processedTriangles = 0;
  let skippedPixels = 0;

  input.group.updateMatrixWorld(true);

  const meshes: THREE.Mesh[] = [];
  input.group.traverse((child) => {
    if (child instanceof THREE.Mesh) meshes.push(child);
  });

  for (const mesh of meshes) {
    const geometry = mesh.geometry;
    const position = geometry.getAttribute('position');
    const uv = geometry.getAttribute('uv');
    if (!position || !uv) {
      warnings.push(`Mesh ${mesh.name || mesh.uuid} has no UV or position attribute.`);
      continue;
    }

    if (!geometry.getAttribute('normal')) {
      geometry.computeVertexNormals();
      warnings.push(`Mesh ${mesh.name || mesh.uuid} had no normals; computed fallback normals.`);
    }

    const normal = geometry.getAttribute('normal');
    const index = geometry.getIndex();
    const triangleCount = index ? index.count / 3 : position.count / 3;
    totalTriangles += triangleCount;
    const normalMatrix = new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld);

    for (let triangle = 0; triangle < triangleCount; triangle += 1) {
      const i0 = index ? index.getX(triangle * 3) : triangle * 3;
      const i1 = index ? index.getX(triangle * 3 + 1) : triangle * 3 + 1;
      const i2 = index ? index.getX(triangle * 3 + 2) : triangle * 3 + 2;

      const uv0 = getAttributeTuple2(uv, i0);
      const uv1 = getAttributeTuple2(uv, i1);
      const uv2 = getAttributeTuple2(uv, i2);
      const px0 = uvToPixel(uv0, resolution);
      const px1 = uvToPixel(uv1, resolution);
      const px2 = uvToPixel(uv2, resolution);
      const minX = Math.max(0, Math.floor(Math.min(px0.x, px1.x, px2.x)));
      const maxX = Math.min(resolution - 1, Math.ceil(Math.max(px0.x, px1.x, px2.x)));
      const minY = Math.max(0, Math.floor(Math.min(px0.y, px1.y, px2.y)));
      const maxY = Math.min(resolution - 1, Math.ceil(Math.max(px0.y, px1.y, px2.y)));

      if (minX > maxX || minY > maxY) continue;

      const w0 = new THREE.Vector3(...getAttributeTuple3(position, i0)).applyMatrix4(mesh.matrixWorld);
      const w1 = new THREE.Vector3(...getAttributeTuple3(position, i1)).applyMatrix4(mesh.matrixWorld);
      const w2 = new THREE.Vector3(...getAttributeTuple3(position, i2)).applyMatrix4(mesh.matrixWorld);
      const n0 = new THREE.Vector3(...getAttributeTuple3(normal, i0)).applyMatrix3(normalMatrix).normalize();
      const n1 = new THREE.Vector3(...getAttributeTuple3(normal, i1)).applyMatrix3(normalMatrix).normalize();
      const n2 = new THREE.Vector3(...getAttributeTuple3(normal, i2)).applyMatrix3(normalMatrix).normalize();

      for (let y = minY; y <= maxY; y += 1) {
        for (let x = minX; x <= maxX; x += 1) {
          const barycentric = getBarycentric({ x: x + 0.5, y: y + 0.5 }, px0, px1, px2);
          if (!barycentric || !isInsideBarycentric(barycentric)) continue;

          const worldTuple = interpolate3(
            barycentric,
            [w0.x, w0.y, w0.z],
            [w1.x, w1.y, w1.z],
            [w2.x, w2.y, w2.z],
          );
          const worldPosition = new THREE.Vector3(...worldTuple);
          const worldNormal = new THREE.Vector3(
            n0.x * barycentric.a + n1.x * barycentric.b + n2.x * barycentric.c,
            n0.y * barycentric.a + n1.y * barycentric.b + n2.y * barycentric.c,
            n0.z * barycentric.a + n1.z * barycentric.b + n2.z * barycentric.c,
          ).normalize();

          if (input.bakeInput.enableBackfaceCulling) {
            const cameraToPoint = worldPosition.clone().sub(cameraPosition).normalize();
            if (worldNormal.dot(cameraToPoint) >= 0) {
              skippedPixels += 1;
              continue;
            }
          }

          const imageUv = projectWorldToImageUv(worldPosition, projectorMatrix);
          if (!imageUv) {
            skippedPixels += 1;
            continue;
          }

          const sample = sampleImageNearest(input.projectedImage, imageUv.u, imageUv.v);
          if (sample[3] <= 0) {
            skippedPixels += 1;
            continue;
          }

          const coverageIndex = y * resolution + x;
          const offset = coverageIndex * 4;
          blendPixel(imageData, offset, sample, input.bakeInput.opacity);
          coverage[coverageIndex] = 1;
        }
      }

      processedTriangles += 1;
      if (processedTriangles % 64 === 0) await yieldToMainThread();
    }
  }

  if (input.bakeInput.enableDilation) {
    dilateImageData(imageData, coverage, input.bakeInput.dilationPixels);
  }

  let coveredPixels = 0;
  for (let index = 0; index < coverage.length; index += 1) {
    if (coverage[index]) coveredPixels += 1;
  }

  context.putImageData(imageData, 0, 0);

  return {
    canvas,
    coverage,
    totalTriangles,
    processedTriangles,
    coveredPixels,
    skippedPixels,
    warnings,
  };
}
