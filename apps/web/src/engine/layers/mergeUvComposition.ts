import * as THREE from 'three';
import type { Layer } from '@/types/layer';

/**
 * Increment when a merged UV produced by an older editor can no longer be
 * trusted to match the live layer stack. Version 5 stores authored albedo and
 * leaves PBR lighting as a live viewport operation.
 */
export const UV_MERGE_COMPOSITION_VERSION = 5;

export function compositeRenderedColorMaskUnderInPlace(
  frontMask: Uint8Array,
  frontRgba: Uint8Array | Uint8ClampedArray,
  underlayMaskRgba: Uint8Array | Uint8ClampedArray,
  opacity = 1,
) {
  if (frontRgba.length !== underlayMaskRgba.length || frontMask.length * 4 !== frontRgba.length) {
    throw new RangeError('Rendered-color mask buffers must describe the same image size.');
  }
  const layerOpacity = Math.max(0, Math.min(1, opacity));
  for (let index = 0, offset = 0; index < frontMask.length; index += 1, offset += 4) {
    const retainedUnderlay =
      (underlayMaskRgba[offset] / 255) * layerOpacity * (1 - frontRgba[offset + 3] / 255);
    frontMask[index] = Math.round(
      Math.max(0, Math.min(1, frontMask[index] / 255 + retainedUnderlay)) * 255,
    );
  }
  return frontMask;
}

export function compositeUniformRenderedColorUnderInPlace(
  frontMask: Uint8Array,
  frontRgba: Uint8Array | Uint8ClampedArray,
  opacity = 1,
) {
  if (frontMask.length * 4 !== frontRgba.length) {
    throw new RangeError('Rendered-color mask and RGBA buffers must describe the same image size.');
  }
  const layerOpacity = Math.max(0, Math.min(1, opacity));
  for (let index = 0, offset = 0; index < frontMask.length; index += 1, offset += 4) {
    const retainedUnderlay = layerOpacity * (1 - frontRgba[offset + 3] / 255);
    frontMask[index] = Math.round(
      Math.max(0, Math.min(1, frontMask[index] / 255 + retainedUnderlay)) * 255,
    );
  }
  return frontMask;
}

type PbrLightingBakeSettings = {
  exposure: number;
  pbrEnvironmentIntensity: number;
  pbrKeyLightIntensity: number;
  pbrLightAzimuth: number;
  environmentPreset: 'color' | 'studio' | 'soft' | 'dark';
};

const SRGB_TO_LINEAR = Array.from({ length: 256 }, (_, value) => {
  const color = value / 255;
  return color <= 0.04045 ? color / 12.92 : ((color + 0.055) / 1.055) ** 2.4;
});

function linearToSrgbByte(value: number) {
  const color = Math.max(0, Math.min(1, value));
  const srgb = color <= 0.0031308 ? color * 12.92 : 1.055 * color ** (1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(srgb * 255)));
}

/**
 * Flattens the editor's deterministic PBR preview light into the merged UV.
 * Pixels already authored as display color (local repaint) retain their exact
 * value; ordinary albedo texels receive the same normal-dependent light used
 * by the viewport. The result can then be displayed unlit in both Flat/PBR.
 */
export async function bakePbrPreviewLightingIntoUv(input: {
  rgba: Uint8Array | Uint8ClampedArray;
  width: number;
  height: number;
  root: THREE.Object3D;
  settings: PbrLightingBakeSettings;
  renderedColorMask?: Uint8Array;
}) {
  const { rgba, width, height, root, settings, renderedColorMask } = input;
  if (rgba.length !== width * height * 4) throw new RangeError('RGBA size does not match UV size.');
  if (renderedColorMask && renderedColorMask.length !== width * height) {
    throw new RangeError('Rendered-color mask size does not match UV size.');
  }
  const environmentBase =
    settings.environmentPreset === 'dark'
      ? 0.38
      : settings.environmentPreset === 'soft'
        ? 0.46
        : 0.5;
  const keyBase =
    settings.environmentPreset === 'dark'
      ? 1.05
      : settings.environmentPreset === 'soft'
        ? 1.12
        : 1.22;
  const environmentScale = settings.pbrEnvironmentIntensity / 0.42;
  const ambient = environmentBase * settings.exposure * environmentScale;
  const key = keyBase * settings.exposure * settings.pbrKeyLightIntensity;
  const azimuth = THREE.MathUtils.degToRad(settings.pbrLightAzimuth);
  const lightDirection = new THREE.Vector3(
    Math.sin(azimuth) * 4.5,
    5.2,
    Math.cos(azimuth) * 4.5,
  ).normalize();
  const visited = new Uint8Array(width * height);
  let scannedPixels = 0;
  root.updateMatrixWorld(true);
  const meshes: THREE.Mesh[] = [];
  root.traverse((object) => {
    if (object instanceof THREE.Mesh && object.visible) meshes.push(object);
  });

  for (const mesh of meshes) {
    const geometry = mesh.geometry;
    const uv = geometry.getAttribute('uv');
    if (!uv) continue;
    if (!geometry.getAttribute('normal')) geometry.computeVertexNormals();
    const normal = geometry.getAttribute('normal');
    if (!normal) continue;
    const index = geometry.getIndex();
    const triangleCount = index ? index.count / 3 : uv.count / 3;
    const normalMatrix = new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld);
    for (let triangle = 0; triangle < triangleCount; triangle += 1) {
      const i0 = index ? index.getX(triangle * 3) : triangle * 3;
      const i1 = index ? index.getX(triangle * 3 + 1) : triangle * 3 + 1;
      const i2 = index ? index.getX(triangle * 3 + 2) : triangle * 3 + 2;
      const x0 = uv.getX(i0) * (width - 1);
      const y0 = (1 - uv.getY(i0)) * (height - 1);
      const x1 = uv.getX(i1) * (width - 1);
      const y1 = (1 - uv.getY(i1)) * (height - 1);
      const x2 = uv.getX(i2) * (width - 1);
      const y2 = (1 - uv.getY(i2)) * (height - 1);
      const denominator = (y1 - y2) * (x0 - x2) + (x2 - x1) * (y0 - y2);
      if (Math.abs(denominator) <= 1e-8) continue;
      const minX = Math.max(0, Math.floor(Math.min(x0, x1, x2)));
      const maxX = Math.min(width - 1, Math.ceil(Math.max(x0, x1, x2)));
      const minY = Math.max(0, Math.floor(Math.min(y0, y1, y2)));
      const maxY = Math.min(height - 1, Math.ceil(Math.max(y0, y1, y2)));
      const n0 = new THREE.Vector3(normal.getX(i0), normal.getY(i0), normal.getZ(i0))
        .applyMatrix3(normalMatrix)
        .normalize();
      const n1 = new THREE.Vector3(normal.getX(i1), normal.getY(i1), normal.getZ(i1))
        .applyMatrix3(normalMatrix)
        .normalize();
      const n2 = new THREE.Vector3(normal.getX(i2), normal.getY(i2), normal.getZ(i2))
        .applyMatrix3(normalMatrix)
        .normalize();
      for (let y = minY; y <= maxY; y += 1) {
        for (let x = minX; x <= maxX; x += 1) {
          const sampleX = x + 0.5;
          const sampleY = y + 0.5;
          const w0 = ((y1 - y2) * (sampleX - x2) + (x2 - x1) * (sampleY - y2)) / denominator;
          const w1 = ((y2 - y0) * (sampleX - x2) + (x0 - x2) * (sampleY - y2)) / denominator;
          const w2 = 1 - w0 - w1;
          if (w0 < -1e-5 || w1 < -1e-5 || w2 < -1e-5) continue;
          const pixelIndex = y * width + x;
          if (visited[pixelIndex]) continue;
          const offset = pixelIndex * 4;
          if (rgba[offset + 3] === 0) continue;
          visited[pixelIndex] = 1;
          const nx = n0.x * w0 + n1.x * w1 + n2.x * w2;
          const ny = n0.y * w0 + n1.y * w1 + n2.y * w2;
          const nz = n0.z * w0 + n1.z * w1 + n2.z * w2;
          const inverseLength = 1 / Math.max(1e-8, Math.hypot(nx, ny, nz));
          const diffuse = Math.max(
            0,
            (nx * lightDirection.x + ny * lightDirection.y + nz * lightDirection.z) *
              inverseLength,
          );
          const previewLight = Math.max(0, Math.min(2, ambient + diffuse * key * 0.55));
          const renderedWeight = (renderedColorMask?.[pixelIndex] ?? 0) / 255;
          // LinearToneMapping multiplies the lit shader output by the renderer
          // exposure after computePreviewLight. Persist both operations so an
          // unlit merged layer reproduces the exact PBR viewport result.
          const pbrDisplayFactor = previewLight * settings.exposure;
          const factor = pbrDisplayFactor * (1 - renderedWeight) + renderedWeight;
          rgba[offset] = linearToSrgbByte(SRGB_TO_LINEAR[rgba[offset]] * factor);
          rgba[offset + 1] = linearToSrgbByte(SRGB_TO_LINEAR[rgba[offset + 1]] * factor);
          rgba[offset + 2] = linearToSrgbByte(SRGB_TO_LINEAR[rgba[offset + 2]] * factor);
        }
        scannedPixels += maxX - minX + 1;
        if (scannedPixels >= 524_288) {
          scannedPixels = 0;
          await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
        }
      }
    }
  }
  return visited;
}

export function isContentAwareUvUnderlay(
  layer: Pick<Layer, 'id' | 'type' | 'role' | 'generationId'>,
) {
  return Boolean(
    layer.type === 'uv' &&
      (layer.role === 'content-aware-underlay' ||
        layer.generationId === 'texture-map-content-aware-repair' ||
        layer.id.startsWith('content-aware-uv-repair')),
  );
}

export function isFlattenableUvMergeSource(
  layer: Pick<Layer, 'id' | 'type' | 'role' | 'generationId' | 'imageUrl'>,
) {
  return Boolean(
    layer.type === 'uv' &&
      layer.imageUrl &&
      isContentAwareUvUnderlay(layer),
  );
}

/**
 * Composites `underlay` behind the existing straight-alpha `front` pixels.
 * The operation is intentionally in-place so a 4K/8K merge does not allocate
 * another full-size RGBA result for every selected layer.
 */
export function compositeRgbaUnderInPlace(
  front: Uint8Array | Uint8ClampedArray,
  underlay: Uint8Array | Uint8ClampedArray,
  opacity = 1,
) {
  if (front.length !== underlay.length || front.length % 4 !== 0) {
    throw new RangeError('RGBA buffers must have the same four-channel length.');
  }
  const layerOpacity = Math.max(0, Math.min(1, opacity));
  if (layerOpacity <= 0) return front;

  for (let offset = 0; offset < front.length; offset += 4) {
    const frontAlpha = front[offset + 3] / 255;
    const underlayAlpha = (underlay[offset + 3] / 255) * layerOpacity;
    const visibleUnderlayAlpha = underlayAlpha * (1 - frontAlpha);
    const outputAlpha = frontAlpha + visibleUnderlayAlpha;

    // Fully transparent RGB is still meaningful texture-atlas padding. Keep
    // the nearest-front padding instead of erasing it during the flatten.
    if (outputAlpha <= 0) {
      if (
        front[offset] === 0 &&
        front[offset + 1] === 0 &&
        front[offset + 2] === 0
      ) {
        front[offset] = underlay[offset];
        front[offset + 1] = underlay[offset + 1];
        front[offset + 2] = underlay[offset + 2];
      }
      front[offset + 3] = 0;
      continue;
    }

    for (let channel = 0; channel < 3; channel += 1) {
      front[offset + channel] = Math.round(
        (front[offset + channel] * frontAlpha +
          underlay[offset + channel] * visibleUnderlayAlpha) /
          outputAlpha,
      );
    }
    front[offset + 3] = Math.round(outputAlpha * 255);
  }
  return front;
}

export function getRgbaAlphaCoverageRatio(
  rgba: Uint8Array | Uint8ClampedArray,
  alphaThreshold = 8,
) {
  if (rgba.length % 4 !== 0) throw new RangeError('RGBA buffer length must be divisible by four.');
  let coveredPixels = 0;
  for (let offset = 3; offset < rgba.length; offset += 4) {
    if (rgba[offset] > alphaThreshold) coveredPixels += 1;
  }
  return rgba.length === 0 ? 0 : coveredPixels / (rgba.length / 4);
}

export function getMergeUvPostprocessOptions(resolution: number) {
  const safeResolution = Math.max(1, Math.floor(resolution));
  const topologyGapPixels = Math.min(
    8,
    Math.max(2, Math.ceil(safeResolution / 512)),
  );
  return {
    // Restore the verified atlas postprocess profile. The two-pixel gutter is
    // outside model UV triangles and retains source alpha for bilinear sampling.
    uvIslandGutterPixels: Math.min(8, Math.max(2, Math.ceil(safeResolution / 512))),
    // GPU UV rasterization can leave narrow, edge-connected cracks between
    // adjacent high-poly triangles. Those cracks are not enclosed components,
    // so the dedicated hole pass cannot see them. Restore a small,
    // resolution-scaled topology-constrained grow: the bake pipeline applies
    // half this value as the actual radius, copies straight alpha unchanged,
    // and may only write texels touched by model UV triangles. This closes the
    // black hairlines without crossing the real atlas gap between UV islands
    // or hardening an Overlay transition band.
    uvCoverageGapPixels: topologyGapPixels,
    uvInteriorHolePixels: Math.min(3, Math.max(1, Math.ceil(safeResolution / 2048))),
    // Reconcile only a small geometry-paired seam band.
    uvSeamRepairPixels: Math.min(4, Math.max(2, Math.ceil(safeResolution / 1024))),
  };
}
