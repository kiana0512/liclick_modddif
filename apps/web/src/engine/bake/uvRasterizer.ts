import * as THREE from 'three';
import { getBarycentric, isInsideBarycentric } from './barycentric';
import { dilateImageData } from './dilation';
import { sampleImageBilinear, sampleImageBilinearCleanColor, sampleImageNearest } from './imageSampler';
import type { BakeProjectedLayerInput } from './uvBakeTypes';
import { buildProjectionMatrixBundle } from '@/engine/projection/projectionMath';
import type { Layer } from '@/types/layer';

type RasterizeInput = {
  group: THREE.Group;
  layer: Layer;
  projectedImage: ImageData;
  maskImage?: ImageData;
  depthImage?: ImageData;
  bakeInput: BakeProjectedLayerInput;
};

const UV_TEXEL_SAMPLE_OFFSETS = [
  [0.25, 0.25],
  [0.75, 0.25],
  [0.25, 0.75],
  [0.75, 0.75],
] as const;
const NDV_HARD_REJECT = -0.35;
const NDV_COVERAGE_START = -0.25;
const NDV_COVERAGE_END = 0.08;
const NDV_QUALITY_START = 0.02;
const NDV_QUALITY_END = 0.25;
const BASE_ANGLE_GAMMA = 4;
const MAX_STRENGTH_FOR_ANGLE = 3;
const DEPTH_EPSILON = 0.08;
const IMAGE_COVERAGE_EDGE_FADE = 0.015;
const IMAGE_QUALITY_EDGE_FADE = 0.035;
const COVERAGE_THRESHOLD = 0.01;
const SOURCE_ALPHA_REJECT = 0.01;

export type RasterizeOutput = {
  canvas: HTMLCanvasElement;
  coverage: Uint8Array;
  quality: Float32Array;
  totalTriangles: number;
  processedTriangles: number;
  coveredPixels: number;
  skippedPixels: number;
  inFrustumPixels: number;
  maskRejectedPixels: number;
  depthRejectedPixels: number;
  backfaceRejectedPixels: number;
  warnings: string[];
};

function createBaseImageData(width: number, height: number) {
  return new ImageData(width, height);
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
    y: uv.y * (resolution - 1),
  };
}

function blendPixel(imageData: ImageData, offset: number, color: [number, number, number, number], opacity: number) {
  const sourceAlpha = (color[3] / 255) * opacity;
  const targetAlpha = imageData.data[offset + 3] / 255;
  const outputAlpha = sourceAlpha + targetAlpha * (1 - sourceAlpha);
  if (outputAlpha <= 0) return;
  imageData.data[offset] = Math.round(
    (color[0] * sourceAlpha + imageData.data[offset] * targetAlpha * (1 - sourceAlpha)) / outputAlpha,
  );
  imageData.data[offset + 1] = Math.round(
    (color[1] * sourceAlpha + imageData.data[offset + 1] * targetAlpha * (1 - sourceAlpha)) / outputAlpha,
  );
  imageData.data[offset + 2] = Math.round(
    (color[2] * sourceAlpha + imageData.data[offset + 2] * targetAlpha * (1 - sourceAlpha)) / outputAlpha,
  );
  imageData.data[offset + 3] = Math.round(outputAlpha * 255);
}

function unpackRgbaDepth(sample: [number, number, number, number]) {
  return (
    sample[0] / (255 * 256 * 256 * 256) +
    sample[1] / (255 * 256 * 256) +
    sample[2] / (255 * 256) +
    sample[3] / 255
  );
}

function hueToRgb(p: number, q: number, t: number) {
  let nextT = t;
  if (nextT < 0) nextT += 1;
  if (nextT > 1) nextT -= 1;
  if (nextT < 1 / 6) return p + (q - p) * 6 * nextT;
  if (nextT < 1 / 2) return q;
  if (nextT < 2 / 3) return p + (q - p) * (2 / 3 - nextT) * 6;
  return p;
}

function rgbToHsl(r: number, g: number, b: number) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const lightness = (max + min) / 2;
  if (max === min) return { hue: 0, saturation: 0, lightness };
  const delta = max - min;
  const saturation = lightness > 0.5 ? delta / (2 - max - min) : delta / (max + min);
  let hue = 0;
  if (max === r) hue = (g - b) / delta + (g < b ? 6 : 0);
  if (max === g) hue = (b - r) / delta + 2;
  if (max === b) hue = (r - g) / delta + 4;
  return { hue: hue / 6, saturation, lightness };
}

function hslToRgb(hue: number, saturation: number, lightness: number) {
  if (saturation === 0) return [lightness, lightness, lightness] as const;
  const q = lightness < 0.5 ? lightness * (1 + saturation) : lightness + saturation - lightness * saturation;
  const p = 2 * lightness - q;
  return [hueToRgb(p, q, hue + 1 / 3), hueToRgb(p, q, hue), hueToRgb(p, q, hue - 1 / 3)] as const;
}

function applyLayerAdjustments(color: [number, number, number, number], layer: Layer): [number, number, number, number] {
  const adjustments = layer.adjustments;
  if (!adjustments || (adjustments.hue === 0 && adjustments.saturation === 0 && adjustments.lightness === 0)) {
    return color;
  }
  const hsl = rgbToHsl(color[0] / 255, color[1] / 255, color[2] / 255);
  const hue = (hsl.hue + adjustments.hue / 100 + 1) % 1;
  const saturation = Math.min(1, Math.max(0, hsl.saturation + adjustments.saturation / 100));
  const lightness = Math.min(1, Math.max(0, hsl.lightness + adjustments.lightness / 100));
  const [r, g, b] = hslToRgb(hue, saturation, lightness);
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255), color[3]];
}

function smoothstep(edge0: number, edge1: number, value: number) {
  const t = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function computeAngleQuality(ndv: number, strength: number) {
  const strengthClamped = Math.min(MAX_STRENGTH_FOR_ANGLE, Math.max(0.25, strength));
  const gamma = BASE_ANGLE_GAMMA / strengthClamped;
  const frontFade = smoothstep(NDV_QUALITY_START, NDV_QUALITY_END, ndv);
  return frontFade * Math.pow(Math.min(1, Math.max(0, ndv)), gamma);
}

function computeImageEdgeFade(imageUv: ProjectedImageUv, edge: number) {
  const edgeDistance = Math.min(imageUv.u, 1 - imageUv.u, imageUv.v, 1 - imageUv.v);
  return smoothstep(0, edge, edgeDistance);
}

type ProjectedLayerSample = {
  color: [number, number, number, number];
  coverage: number;
  quality: number;
};

function applyLooseProjectionWeights(
  color: [number, number, number, number],
  imageUv: ProjectedImageUv,
  ndv: number,
  strength: number,
  depthWeight: number,
): ProjectedLayerSample | undefined {
  const sourceAlpha = color[3] / 255;
  if (sourceAlpha < SOURCE_ALPHA_REJECT) return undefined;
  if (ndv < NDV_HARD_REJECT) return undefined;

  const angleCoverage = smoothstep(NDV_COVERAGE_START, NDV_COVERAGE_END, ndv);
  const coverageEdge = computeImageEdgeFade(imageUv, IMAGE_COVERAGE_EDGE_FADE);
  const coverage = Math.min(1, sourceAlpha * angleCoverage * (0.35 + 0.65 * coverageEdge));
  if (coverage < COVERAGE_THRESHOLD) return undefined;

  const angleQuality = computeAngleQuality(ndv, strength);
  const qualityEdge = computeImageEdgeFade(imageUv, IMAGE_QUALITY_EDGE_FADE);
  const quality = Math.min(1, coverage * depthWeight * angleQuality * (0.3 + 0.7 * qualityEdge));

  return {
    color: [color[0], color[1], color[2], Math.round(coverage * 255)],
    coverage,
    quality,
  };
}

type SampleResult = {
  sample?: ProjectedLayerSample;
  inFrustum: boolean;
  maskRejected: boolean;
  depthRejected: boolean;
  backfaceRejected: boolean;
};

type SampleScratch = {
  worldPosition: THREE.Vector3;
  captureWorldPosition: THREE.Vector3;
  worldNormal: THREE.Vector3;
  cameraToPoint: THREE.Vector3;
  imageUv: ProjectedImageUv;
};

type ProjectedImageUv = {
  u: number;
  v: number;
  depth: number;
};

function createSampleScratch(): SampleScratch {
  return {
    worldPosition: new THREE.Vector3(),
    captureWorldPosition: new THREE.Vector3(),
    worldNormal: new THREE.Vector3(),
    cameraToPoint: new THREE.Vector3(),
    imageUv: { u: 0, v: 0, depth: 0 },
  };
}

function resolveProjectedSample({
  barycentric,
  input,
  w0,
  w1,
  w2,
  n0,
  n1,
  n2,
  objectMatrixDelta,
  objectNormalDelta,
  cameraPosition,
  projectorMatrix,
  scratch,
}: {
  barycentric: { a: number; b: number; c: number };
  input: RasterizeInput;
  w0: THREE.Vector3;
  w1: THREE.Vector3;
  w2: THREE.Vector3;
  n0: THREE.Vector3;
  n1: THREE.Vector3;
  n2: THREE.Vector3;
  objectMatrixDelta: THREE.Matrix4;
  objectNormalDelta: THREE.Matrix3;
  cameraPosition: THREE.Vector3;
  projectorMatrix: THREE.Matrix4;
  scratch: SampleScratch;
}): SampleResult {
  const worldPosition = scratch.worldPosition.set(
    w0.x * barycentric.a + w1.x * barycentric.b + w2.x * barycentric.c,
    w0.y * barycentric.a + w1.y * barycentric.b + w2.y * barycentric.c,
    w0.z * barycentric.a + w1.z * barycentric.b + w2.z * barycentric.c,
  );
  const captureWorldPosition = scratch.captureWorldPosition.copy(worldPosition).applyMatrix4(objectMatrixDelta);
  const worldNormal = scratch.worldNormal
    .set(
      n0.x * barycentric.a + n1.x * barycentric.b + n2.x * barycentric.c,
      n0.y * barycentric.a + n1.y * barycentric.b + n2.y * barycentric.c,
      n0.z * barycentric.a + n1.z * barycentric.b + n2.z * barycentric.c,
    )
    .applyMatrix3(objectNormalDelta)
    .normalize();

  if (input.bakeInput.enableBackfaceCulling) {
    const cameraToPoint = scratch.cameraToPoint.copy(cameraPosition).sub(captureWorldPosition).normalize();
    const ndv = worldNormal.dot(cameraToPoint);
    if (ndv < NDV_HARD_REJECT) {
      return { inFrustum: false, maskRejected: false, depthRejected: false, backfaceRejected: true };
    }
  } else {
    scratch.cameraToPoint.copy(cameraPosition).sub(captureWorldPosition).normalize();
  }
  const ndv = worldNormal.dot(scratch.cameraToPoint);
  if (ndv < NDV_HARD_REJECT) {
    return { inFrustum: false, maskRejected: false, depthRejected: false, backfaceRejected: true };
  }

  if (!projectWorldToImageUv(captureWorldPosition, projectorMatrix, scratch.imageUv)) {
    return { inFrustum: false, maskRejected: false, depthRejected: false, backfaceRejected: false };
  }
  const imageUv = scratch.imageUv;

  if (input.maskImage) {
    const maskSample = sampleImageBilinear(input.maskImage, imageUv.u, imageUv.v);
    const maskValue = Math.max(maskSample[0], maskSample[1], maskSample[2]);
    if (maskValue < 24) {
      return { inFrustum: true, maskRejected: true, depthRejected: false, backfaceRejected: false };
    }
  }

  let depthWeight = 1;
  if (input.depthImage) {
    const depthSample = sampleImageNearest(input.depthImage, imageUv.u, imageUv.v);
    const capturedDepth = unpackRgbaDepth(depthSample);
    const depthErr = Math.abs(imageUv.depth - capturedDepth);
    depthWeight = 0.2 + 0.8 * Math.exp(-((depthErr / DEPTH_EPSILON) ** 2));
  }

  const sample = applyLooseProjectionWeights(
    applyLayerAdjustments(sampleImageBilinearCleanColor(input.projectedImage, imageUv.u, imageUv.v), input.layer),
    imageUv,
    ndv,
    input.layer.strength ?? 1,
    depthWeight,
  );
  if (!sample) return { inFrustum: true, maskRejected: false, depthRejected: false, backfaceRejected: false };
  if (sample.coverage <= COVERAGE_THRESHOLD) {
    return { inFrustum: true, maskRejected: false, depthRejected: false, backfaceRejected: false };
  }

  return {
    sample,
    inFrustum: true,
    maskRejected: false,
    depthRejected: depthWeight < 0.45,
    backfaceRejected: false,
  };
}

function compositeSubpixelSamples(samples: ProjectedLayerSample[]): ProjectedLayerSample | undefined {
  if (samples.length === 0) return undefined;

  let red = 0;
  let green = 0;
  let blue = 0;
  let coverage = 0;
  let quality = 0;
  for (const sample of samples) {
    const sampleAlpha = sample.coverage;
    const color = sample.color;
    red += color[0] * sampleAlpha;
    green += color[1] * sampleAlpha;
    blue += color[2] * sampleAlpha;
    coverage += sampleAlpha;
    quality += sample.quality;
  }

  if (coverage <= 0.00001) return undefined;
  const averageCoverage = coverage / samples.length;
  return {
    color: [
      Math.round(red / coverage),
      Math.round(green / coverage),
      Math.round(blue / coverage),
      Math.round(averageCoverage * 255),
    ],
    coverage: averageCoverage,
    quality: quality / samples.length,
  };
}

function projectWorldToImageUv(
  worldPosition: THREE.Vector3,
  projectorMatrix: THREE.Matrix4,
  target: ProjectedImageUv,
) {
  const e = projectorMatrix.elements;
  const x = worldPosition.x;
  const y = worldPosition.y;
  const z = worldPosition.z;
  const projectedX = e[0] * x + e[4] * y + e[8] * z + e[12];
  const projectedY = e[1] * x + e[5] * y + e[9] * z + e[13];
  const projectedZ = e[2] * x + e[6] * y + e[10] * z + e[14];
  const projectedW = e[3] * x + e[7] * y + e[11] * z + e[15];
  if (projectedW <= 0) return false;
  const ndcX = projectedX / projectedW;
  const ndcY = projectedY / projectedW;
  const ndcZ = projectedZ / projectedW;
  if (ndcX < -1 || ndcX > 1 || ndcY < -1 || ndcY > 1 || ndcZ < -1 || ndcZ > 1) return false;
  target.u = ndcX * 0.5 + 0.5;
  target.v = 1 - (ndcY * 0.5 + 0.5);
  target.depth = ndcZ * 0.5 + 0.5;
  return true;
}

function createObjectMatrixDelta(group: THREE.Group, layer: Layer) {
  group.updateMatrixWorld(true);
  if (!layer.objectMatrixWorld) return new THREE.Matrix4();
  return new THREE.Matrix4().fromArray(layer.objectMatrixWorld).multiply(group.matrixWorld.clone().invert());
}

function getTriangleCount(mesh: THREE.Mesh) {
  const position = mesh.geometry.getAttribute('position');
  const uv = mesh.geometry.getAttribute('uv');
  if (!position || !uv) return 0;
  const index = mesh.geometry.getIndex();
  return index ? index.count / 3 : position.count / 3;
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
  const quality = new Float32Array(resolution * resolution);
  const projectorMatrix = buildProjectionMatrixBundle(input.layer.camera).projectorMatrix;
  const cameraPosition = new THREE.Vector3().fromArray(input.layer.camera.position);
  const objectMatrixDelta = createObjectMatrixDelta(input.group, input.layer);
  const objectNormalDelta = new THREE.Matrix3().getNormalMatrix(objectMatrixDelta);
  const sampleScratch = createSampleScratch();
  const warnings: string[] = [];
  let processedTriangles = 0;
  let skippedPixels = 0;
  let inFrustumPixels = 0;
  let maskRejectedPixels = 0;
  let depthRejectedPixels = 0;
  let backfaceRejectedPixels = 0;

  input.group.updateMatrixWorld(true);

  const meshes: THREE.Mesh[] = [];
  input.group.traverse((child) => {
    if (child instanceof THREE.Mesh) meshes.push(child);
  });
  const totalTriangles = meshes.reduce((sum, mesh) => sum + getTriangleCount(mesh), 0);
  let lastProgressAt = 0;
  const reportRasterProgress = (force = false) => {
    if (!input.bakeInput.onProgress) return;
    const now = performance.now();
    if (!force && now - lastProgressAt < 120) return;
    lastProgressAt = now;
    input.bakeInput.onProgress({
      phase: 'rasterizing',
      progress: totalTriangles > 0 ? processedTriangles / totalTriangles : 0,
      layerName: input.layer.name,
      processedTriangles,
      totalTriangles,
    });
  };
  reportRasterProgress(true);

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
          const acceptedSamples: ProjectedLayerSample[] = [];
          let touchedTriangle = false;
          let touchedFrustum = false;
          let touchedMaskReject = false;
          let touchedDepthReject = false;
          let touchedBackfaceReject = false;

          for (const [offsetX, offsetY] of UV_TEXEL_SAMPLE_OFFSETS) {
            const barycentric = getBarycentric({ x: x + offsetX, y: y + offsetY }, px0, px1, px2);
            if (!barycentric || !isInsideBarycentric(barycentric)) continue;
            touchedTriangle = true;

            const sample = resolveProjectedSample({
              barycentric,
              input,
              w0,
              w1,
              w2,
              n0,
              n1,
              n2,
              objectMatrixDelta,
              objectNormalDelta,
              cameraPosition,
              projectorMatrix,
              scratch: sampleScratch,
            });

            touchedFrustum = touchedFrustum || sample.inFrustum;
            touchedMaskReject = touchedMaskReject || sample.maskRejected;
            touchedDepthReject = touchedDepthReject || sample.depthRejected;
            touchedBackfaceReject = touchedBackfaceReject || sample.backfaceRejected;
            if (sample.sample) acceptedSamples.push(sample.sample);
          }

          if (!touchedTriangle) continue;
          if (touchedFrustum) inFrustumPixels += 1;
          if (touchedMaskReject && acceptedSamples.length === 0) maskRejectedPixels += 1;
          if (touchedDepthReject && acceptedSamples.length === 0) depthRejectedPixels += 1;
          if (touchedBackfaceReject && acceptedSamples.length === 0) backfaceRejectedPixels += 1;

          const sampledColor = compositeSubpixelSamples(acceptedSamples);
          if (!sampledColor) {
            skippedPixels += 1;
            continue;
          }

          const coverageIndex = y * resolution + x;
          const offset = coverageIndex * 4;
          blendPixel(imageData, offset, sampledColor.color, input.bakeInput.opacity);
          quality[coverageIndex] = Math.max(quality[coverageIndex], sampledColor.quality * input.bakeInput.opacity);
          coverage[coverageIndex] = 1;
        }
      }

      processedTriangles += 1;
      if (processedTriangles % 64 === 0) {
        reportRasterProgress();
        await yieldToMainThread();
      }
    }
  }
  reportRasterProgress(true);

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
    quality,
    totalTriangles,
    processedTriangles,
    coveredPixels,
    skippedPixels,
    inFrustumPixels,
    maskRejectedPixels,
    depthRejectedPixels,
    backfaceRejectedPixels,
    warnings,
  };
}
