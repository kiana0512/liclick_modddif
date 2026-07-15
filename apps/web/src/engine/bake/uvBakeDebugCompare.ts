import * as THREE from 'three';
import { getBarycentric, isInsideBarycentric } from './barycentric';
import { bakeVisibleProjectedLayersToTexture } from './bakeProjectedLayerToTexture';
import { getVisibleProjectedLayerStack } from './layerStackCache';
import type {
  BakeProgress,
  BakeReport,
  BakeVisibleProjectedLayersInput,
  GpuUvCompositeMode,
  UvBakeResolution,
} from './uvBakeTypes';
import { useLayerStore } from '@/stores/layerStore';
import { useSceneStore } from '@/stores/sceneStore';

const COVERAGE_ALPHA_THRESHOLD = 8;

type DebugCompareOptions = {
  objectId?: string;
  layerIds?: string[];
  allVisible?: boolean;
  eachLayer?: boolean;
  resolution?: UvBakeResolution;
  enableBackfaceCulling?: boolean;
  enableDilation?: boolean;
  dilationPixels?: number;
  gpuInputTextureFlipY?: boolean;
  gpuProjectedImageUvFlipY?: boolean;
  gpuCompositeMode?: GpuUvCompositeMode;
  ignoreMask?: boolean;
  ignoreDepth?: boolean;
  download?: boolean;
  logProgress?: boolean;
};

type UvGradientDebugOptions = {
  objectId?: string;
  resolution?: UvBakeResolution;
  download?: boolean;
};

type CoverageBounds = {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  centerX: number;
  centerY: number;
  width: number;
  height: number;
};

type DebugCompareMetrics = ReturnType<typeof makeDiffImage>['metrics'];

type SingleDebugCompareResult = {
  ok: true;
  elapsedMs: number;
  objectId: string;
  layerIds: string[];
  resolution: UvBakeResolution;
  rendererState?: {
    browserDevicePixelRatio: number;
    rendererPixelRatioBefore: number | undefined;
    offscreenBakePixelRatio: number;
  };
  metrics: DebugCompareMetrics;
  reports: {
    cpu: BakeReport;
    gpu: BakeReport;
  };
  canvases: {
    cpu: HTMLCanvasElement;
    gpu: HTMLCanvasElement;
    diff: HTMLCanvasElement;
  };
  png: {
    cpu: string;
    gpu: string;
    diff: string;
  };
};

type EachLayerDebugCompareResult = {
  ok: true;
  mode: 'eachLayer';
  objectId: string;
  layerIds: string[];
  resolution: UvBakeResolution;
  results: SingleDebugCompareResult[];
};

type DebugCompareResult = SingleDebugCompareResult | EachLayerDebugCompareResult;

function getContext2d(canvas: HTMLCanvasElement, label: string) {
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error(`Could not read ${label} canvas.`);
  return context;
}

function createDownloadLink(url: string, filename: string) {
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
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

function renderCpuUvGradient(group: THREE.Group, resolution: UvBakeResolution) {
  const imageData = new ImageData(resolution, resolution);
  const coverage = new Uint8Array(resolution * resolution);
  const sampleOffsets = [
    [0.25, 0.25],
    [0.75, 0.25],
    [0.25, 0.75],
    [0.75, 0.75],
  ] as const;

  group.updateMatrixWorld(true);
  group.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    const position = child.geometry.getAttribute('position');
    const uv = child.geometry.getAttribute('uv');
    if (!position || !uv) return;
    const index = child.geometry.getIndex();
    const triangleCount = index ? index.count / 3 : position.count / 3;
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

      for (let y = minY; y <= maxY; y += 1) {
        for (let x = minX; x <= maxX; x += 1) {
          let red = 0;
          let green = 0;
          let samples = 0;
          for (const [offsetX, offsetY] of sampleOffsets) {
            const samplePoint = { x: x + offsetX, y: y + offsetY };
            const barycentric = getBarycentric(samplePoint, px0, px1, px2);
            if (!barycentric || !isInsideBarycentric(barycentric)) continue;
            const sampleU = uv0.x * barycentric.a + uv1.x * barycentric.b + uv2.x * barycentric.c;
            const sampleV = uv0.y * barycentric.a + uv1.y * barycentric.b + uv2.y * barycentric.c;
            red += Math.max(0, Math.min(255, Math.round(sampleU * 255)));
            green += Math.max(0, Math.min(255, Math.round(sampleV * 255)));
            samples += 1;
          }
          if (samples === 0) continue;
          const pixelIndex = y * resolution + x;
          const offset = pixelIndex * 4;
          imageData.data[offset] = Math.round(red / samples);
          imageData.data[offset + 1] = Math.round(green / samples);
          imageData.data[offset + 2] = 0;
          imageData.data[offset + 3] = 255;
          coverage[pixelIndex] = 1;
        }
      }
    }
  });

  const canvas = document.createElement('canvas');
  canvas.width = resolution;
  canvas.height = resolution;
  getContext2d(canvas, 'CPU UV gradient').putImageData(imageData, 0, 0);
  return { canvas, imageData, coverage };
}

function readGradientTarget(renderer: THREE.WebGLRenderer, target: THREE.WebGLRenderTarget, resolution: UvBakeResolution) {
  const pixels = new Uint8Array(resolution * resolution * 4);
  renderer.readRenderTargetPixels(target, 0, 0, resolution, resolution, pixels);
  const imageData = new ImageData(resolution, resolution);
  const coverage = new Uint8Array(resolution * resolution);
  const rowLength = resolution * 4;
  for (let y = 0; y < resolution; y += 1) {
    const sourceY = resolution - 1 - y;
    const sourceStart = sourceY * rowLength;
    const targetStart = y * rowLength;
    for (let x = 0; x < resolution; x += 1) {
      const sourceOffset = sourceStart + x * 4;
      const targetOffset = targetStart + x * 4;
      imageData.data[targetOffset] = pixels[sourceOffset];
      imageData.data[targetOffset + 1] = pixels[sourceOffset + 1];
      imageData.data[targetOffset + 2] = pixels[sourceOffset + 2];
      imageData.data[targetOffset + 3] = pixels[sourceOffset + 3] > COVERAGE_ALPHA_THRESHOLD ? 255 : 0;
      if (imageData.data[targetOffset + 3] > 0) coverage[y * resolution + x] = 1;
    }
  }
  const canvas = document.createElement('canvas');
  canvas.width = resolution;
  canvas.height = resolution;
  getContext2d(canvas, 'GPU UV gradient').putImageData(imageData, 0, 0);
  return { canvas, imageData, coverage };
}

function renderGpuUvGradient(renderer: THREE.WebGLRenderer, group: THREE.Group, resolution: UvBakeResolution) {
  const target = new THREE.WebGLRenderTarget(resolution, resolution, {
    depthBuffer: false,
    stencilBuffer: false,
    format: THREE.RGBAFormat,
    type: THREE.UnsignedByteType,
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    generateMipmaps: false,
  });
  target.texture.colorSpace = THREE.NoColorSpace;
  const previousState = {
    target: renderer.getRenderTarget(),
    clearColor: renderer.getClearColor(new THREE.Color()),
    clearAlpha: renderer.getClearAlpha(),
    viewport: renderer.getViewport(new THREE.Vector4()),
    scissor: renderer.getScissor(new THREE.Vector4()),
    scissorTest: renderer.getScissorTest(),
    autoClear: renderer.autoClear,
    xrEnabled: renderer.xr.enabled,
    pixelRatio: renderer.getPixelRatio(),
  };
  const material = new THREE.ShaderMaterial({
    vertexShader: `
      varying vec2 vDebugUv;
      void main() {
        vDebugUv = uv;
        gl_Position = vec4(uv.x * 2.0 - 1.0, uv.y * 2.0 - 1.0, 0.0, 1.0);
      }
    `,
    fragmentShader: `
      varying vec2 vDebugUv;
      void main() {
        gl_FragColor = vec4(vDebugUv.x, vDebugUv.y, 0.0, 1.0);
      }
    `,
    depthTest: false,
    depthWrite: false,
    blending: THREE.NoBlending,
    toneMapped: false,
    side: THREE.DoubleSide,
  });
  const scene = new THREE.Scene();
  group.updateMatrixWorld(true);
  group.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    if (!child.geometry.getAttribute('position') || !child.geometry.getAttribute('uv')) return;
    const mesh = new THREE.Mesh(child.geometry, material);
    mesh.frustumCulled = false;
    scene.add(mesh);
  });
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -1, 1);
  try {
    renderer.xr.enabled = false;
    renderer.setPixelRatio(1);
    renderer.autoClear = false;
    renderer.setRenderTarget(target);
    renderer.setViewport(0, 0, resolution, resolution);
    renderer.setScissorTest(false);
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, true, true);
    renderer.render(scene, camera);
    return readGradientTarget(renderer, target, resolution);
  } finally {
    renderer.setPixelRatio(previousState.pixelRatio);
    renderer.setRenderTarget(previousState.target);
    renderer.setClearColor(previousState.clearColor, previousState.clearAlpha);
    renderer.setViewport(previousState.viewport);
    renderer.setScissor(previousState.scissor);
    renderer.setScissorTest(previousState.scissorTest);
    renderer.autoClear = previousState.autoClear;
    renderer.xr.enabled = previousState.xrEnabled;
    scene.clear();
    material.dispose();
    target.dispose();
  }
}

function findCoverageBounds(imageData: ImageData): CoverageBounds | undefined {
  let minX = imageData.width;
  let minY = imageData.height;
  let maxX = -1;
  let maxY = -1;
  let sumX = 0;
  let sumY = 0;
  let count = 0;
  for (let y = 0; y < imageData.height; y += 1) {
    for (let x = 0; x < imageData.width; x += 1) {
      const offset = (y * imageData.width + x) * 4;
      if (imageData.data[offset + 3] <= COVERAGE_ALPHA_THRESHOLD) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      sumX += x;
      sumY += y;
      count += 1;
    }
  }
  if (count === 0) return undefined;
  return {
    minX,
    minY,
    maxX,
    maxY,
    centerX: sumX / count,
    centerY: sumY / count,
    width: maxX - minX + 1,
    height: maxY - minY + 1,
  };
}

function compareCoverageBounds(cpuBounds: CoverageBounds | undefined, gpuBounds: CoverageBounds | undefined) {
  if (!cpuBounds || !gpuBounds) return undefined;
  return {
    widthScale: cpuBounds.width > 0 ? gpuBounds.width / cpuBounds.width : 1,
    heightScale: cpuBounds.height > 0 ? gpuBounds.height / cpuBounds.height : 1,
    minXDelta: gpuBounds.minX - cpuBounds.minX,
    minYDelta: gpuBounds.minY - cpuBounds.minY,
    maxXDelta: gpuBounds.maxX - cpuBounds.maxX,
    maxYDelta: gpuBounds.maxY - cpuBounds.maxY,
    centerXDelta: gpuBounds.centerX - cpuBounds.centerX,
    centerYDelta: gpuBounds.centerY - cpuBounds.centerY,
    lowerLeftXDelta: gpuBounds.minX - cpuBounds.minX,
    lowerLeftYDelta: gpuBounds.maxY - cpuBounds.maxY,
    upperRightXDelta: gpuBounds.maxX - cpuBounds.maxX,
    upperRightYDelta: gpuBounds.minY - cpuBounds.minY,
  };
}

function makeDiffImage(cpuImage: ImageData, gpuImage: ImageData) {
  const diff = new ImageData(cpuImage.width, cpuImage.height);
  let cpuCovered = 0;
  let gpuCovered = 0;
  let intersection = 0;
  let union = 0;
  let cpuOnly = 0;
  let gpuOnly = 0;
  let overlapPixels = 0;
  let totalColorError = 0;
  let totalAlphaError = 0;
  let maxColorError = 0;

  for (let offset = 0; offset < cpuImage.data.length; offset += 4) {
    const cpuAlpha = cpuImage.data[offset + 3];
    const gpuAlpha = gpuImage.data[offset + 3];
    const hasCpu = cpuAlpha > COVERAGE_ALPHA_THRESHOLD;
    const hasGpu = gpuAlpha > COVERAGE_ALPHA_THRESHOLD;

    if (hasCpu) cpuCovered += 1;
    if (hasGpu) gpuCovered += 1;
    if (hasCpu && hasGpu) intersection += 1;
    if (hasCpu || hasGpu) union += 1;
    if (hasCpu && !hasGpu) cpuOnly += 1;
    if (hasGpu && !hasCpu) gpuOnly += 1;

    totalAlphaError += Math.abs(cpuAlpha - gpuAlpha);

    if (hasCpu && hasGpu) {
      const redError = Math.abs(cpuImage.data[offset] - gpuImage.data[offset]);
      const greenError = Math.abs(cpuImage.data[offset + 1] - gpuImage.data[offset + 1]);
      const blueError = Math.abs(cpuImage.data[offset + 2] - gpuImage.data[offset + 2]);
      const colorError = (redError + greenError + blueError) / 3;
      totalColorError += colorError;
      maxColorError = Math.max(maxColorError, colorError);
      overlapPixels += 1;
      const diffValue = Math.max(20, Math.min(255, Math.round(colorError * 4)));
      diff.data[offset] = diffValue;
      diff.data[offset + 1] = diffValue;
      diff.data[offset + 2] = diffValue;
      diff.data[offset + 3] = 255;
    } else if (hasCpu) {
      diff.data[offset] = 255;
      diff.data[offset + 1] = 42;
      diff.data[offset + 2] = 82;
      diff.data[offset + 3] = 255;
    } else if (hasGpu) {
      diff.data[offset] = 56;
      diff.data[offset + 1] = 189;
      diff.data[offset + 2] = 248;
      diff.data[offset + 3] = 255;
    } else {
      diff.data[offset] = 0;
      diff.data[offset + 1] = 0;
      diff.data[offset + 2] = 0;
      diff.data[offset + 3] = 255;
    }
  }

  const cpuBounds = findCoverageBounds(cpuImage);
  const gpuBounds = findCoverageBounds(gpuImage);
  const boundsDelta = compareCoverageBounds(cpuBounds, gpuBounds);

  return {
    diff,
    metrics: {
      resolution: cpuImage.width,
      cpuCovered,
      gpuCovered,
      intersection,
      union,
      coverageIoU: union > 0 ? intersection / union : 1,
      gpuToCpuCoverageRatio: cpuCovered > 0 ? gpuCovered / cpuCovered : 1,
      cpuOnly,
      gpuOnly,
      colorMaeByte: overlapPixels > 0 ? totalColorError / overlapPixels : 0,
      colorMae01: overlapPixels > 0 ? totalColorError / overlapPixels / 255 : 0,
      alphaMaeByte: totalAlphaError / (cpuImage.width * cpuImage.height),
      alphaMae01: totalAlphaError / (cpuImage.width * cpuImage.height) / 255,
      maxColorErrorByte: maxColorError,
      overlapPixels,
      cpuBounds,
      gpuBounds,
      boundsDelta,
    },
  };
}

function formatProgress(method: 'cpu' | 'gpu', progress: BakeProgress) {
  const percent = Math.round(progress.progress * 100);
  const triangles =
    progress.totalTriangles && progress.processedTriangles !== undefined
      ? ` ${progress.processedTriangles}/${progress.totalTriangles} tris`
      : '';
  const layer = progress.layerName ? ` ${progress.layerName}` : '';
  return `[Liclick UV Debug] ${method.toUpperCase()} ${progress.phase} ${percent}%${layer}${triangles}`;
}

function makeProgressLogger(method: 'cpu' | 'gpu', enabled: boolean | undefined) {
  if (!enabled) return undefined;
  return (progress: BakeProgress) => console.debug(formatProgress(method, progress));
}

export async function debugCompareCpuGpuUvBake(options: DebugCompareOptions = {}): Promise<DebugCompareResult> {
  const importedModel = useSceneStore.getState().importedModel;
  if (!importedModel) throw new Error('Please import a model first.');
  const objectId = options.objectId ?? useSceneStore.getState().selectedObjectId ?? importedModel.objectId;
  const visibleLayers = getVisibleProjectedLayerStack(useLayerStore.getState().layers, objectId);
  const layerIds =
    options.layerIds ??
    (options.allVisible ? visibleLayers.map((layer) => layer.id) : visibleLayers.slice(0, 1).map((layer) => layer.id));
  if (layerIds.length === 0) throw new Error('No projected layer is available for CPU/GPU UV debug compare.');

  const resolution = options.resolution ?? (512 as UvBakeResolution);
  const renderer = useSceneStore.getState().viewport?.gl;
  const rendererPixelRatioBefore = renderer?.getPixelRatio();
  if (options.eachLayer && layerIds.length > 1) {
    const results: SingleDebugCompareResult[] = [];
    console.groupCollapsed(`[Liclick UV Debug] Per-layer CPU/GPU compare ${resolution}px, ${layerIds.length} layers`);
    try {
      for (const layerId of layerIds) {
        const layer = visibleLayers.find((item) => item.id === layerId);
        console.info('[Liclick UV Debug] Comparing layer:', layer?.name ?? layerId, layerId);
        const result = await debugCompareCpuGpuUvBake({
          ...options,
          layerIds: [layerId],
          allVisible: false,
          eachLayer: false,
        });
        if (!('metrics' in result)) throw new Error('Unexpected nested per-layer debug compare result.');
        results.push(result);
      }
      console.table(
        results.map((result, index) => ({
          layerName: visibleLayers.find((layer) => layer.id === layerIds[index])?.name ?? layerIds[index],
          layerId: layerIds[index],
          coverageIoU: result.metrics.coverageIoU,
          gpuToCpuCoverageRatio: result.metrics.gpuToCpuCoverageRatio,
          colorMae01: result.metrics.colorMae01,
          alphaMae01: result.metrics.alphaMae01,
          cpuOnly: result.metrics.cpuOnly,
          gpuOnly: result.metrics.gpuOnly,
        })),
      );
      return {
        ok: true,
        mode: 'eachLayer',
        objectId,
        layerIds,
        resolution,
        results,
      };
    } finally {
      console.groupEnd();
    }
  }

  const commonInput: Omit<BakeVisibleProjectedLayersInput, 'method' | 'cacheKey' | 'onProgress'> = {
    objectId,
    layerIds,
    resolution,
    enableBackfaceCulling: options.enableBackfaceCulling ?? true,
    enableDilation: options.enableDilation ?? false,
    dilationPixels: options.dilationPixels ?? 0,
    outputAlpha: 'transparent',
    commitToProject: false,
    markSourceLayersBaked: false,
    preferBlobOutput: false,
    skipGpuValidation: true,
    gpuInputTextureFlipY: options.gpuInputTextureFlipY ?? true,
    gpuProjectedImageUvFlipY: options.gpuProjectedImageUvFlipY ?? true,
    gpuCompositeMode: options.gpuCompositeMode ?? 'cpu-parity',
    debugIgnoreMask: options.ignoreMask ?? false,
    debugIgnoreDepth: options.ignoreDepth ?? false,
  };

  const startedAt = performance.now();
  console.groupCollapsed(
    `[Liclick UV Debug] CPU/GPU compare ${resolution}px, ${layerIds.length} layer${layerIds.length > 1 ? 's' : ''}`,
  );
  console.table({
    canonicalUvPng: 'row 0 = UV v 1, row h-1 = UV v 0',
    objectId,
    layerIds: layerIds.join(', '),
    resolution,
    browserDevicePixelRatio: window.devicePixelRatio,
    rendererPixelRatioBefore,
    offscreenBakePixelRatio: 1,
    outputAlpha: commonInput.outputAlpha,
    enableBackfaceCulling: commonInput.enableBackfaceCulling,
    enableDilation: commonInput.enableDilation,
    dilationPixels: commonInput.dilationPixels,
    gpuValidation: 'skipped for raw diff',
    gpuFallback: 'disabled',
    gpuInputTextureFlipY: commonInput.gpuInputTextureFlipY,
    gpuProjectedImageUvFlipY: commonInput.gpuProjectedImageUvFlipY,
    gpuCompositeMode: commonInput.gpuCompositeMode,
    ignoreMask: commonInput.debugIgnoreMask,
    ignoreDepth: commonInput.debugIgnoreDepth,
  });

  try {
    const cpuResult = await bakeVisibleProjectedLayersToTexture({
      ...commonInput,
      method: 'cpu',
      cacheKey: `debug-cpu-${crypto.randomUUID()}`,
      onProgress: makeProgressLogger('cpu', options.logProgress),
    });
    const gpuResult = await bakeVisibleProjectedLayersToTexture({
      ...commonInput,
      method: 'gpu',
      cacheKey: `debug-gpu-${crypto.randomUUID()}`,
      disableGpuFallback: true,
      onProgress: makeProgressLogger('gpu', options.logProgress),
    });

    const cpuContext = getContext2d(cpuResult.canvas, 'CPU debug bake');
    const gpuContext = getContext2d(gpuResult.canvas, 'GPU debug bake');
    const cpuImage = cpuContext.getImageData(0, 0, resolution, resolution);
    const gpuImage = gpuContext.getImageData(0, 0, resolution, resolution);
    const { diff, metrics } = makeDiffImage(cpuImage, gpuImage);
    const diffCanvas = document.createElement('canvas');
    diffCanvas.width = resolution;
    diffCanvas.height = resolution;
    getContext2d(diffCanvas, 'diff').putImageData(diff, 0, 0);

    const cpuPng = cpuResult.canvas.toDataURL('image/png');
    const gpuPng = gpuResult.canvas.toDataURL('image/png');
    const diffPng = diffCanvas.toDataURL('image/png');
    const elapsedMs = performance.now() - startedAt;
    const result: SingleDebugCompareResult = {
      ok: true,
      elapsedMs,
      objectId,
      layerIds,
      resolution,
      rendererState: {
        browserDevicePixelRatio: window.devicePixelRatio,
        rendererPixelRatioBefore,
        offscreenBakePixelRatio: 1,
      },
      metrics,
      reports: {
        cpu: cpuResult.report,
        gpu: gpuResult.report,
      },
      canvases: {
        cpu: cpuResult.canvas,
        gpu: gpuResult.canvas,
        diff: diffCanvas,
      },
      png: {
        cpu: cpuPng,
        gpu: gpuPng,
        diff: diffPng,
      },
    };

    console.table(metrics);
    console.table({
      cpuDurationMs: cpuResult.report.durationMs,
      gpuDurationMs: gpuResult.report.durationMs,
      totalElapsedMs: elapsedMs,
      cpuCoverageRatio: cpuResult.report.coverageRatio,
      gpuCoverageRatio: gpuResult.report.coverageRatio,
    });
    console.info('[Liclick UV Debug] CPU report:', cpuResult.report);
    console.info('[Liclick UV Debug] GPU report:', gpuResult.report);
    console.info('[Liclick UV Debug] CPU PNG:', cpuPng);
    console.info('[Liclick UV Debug] GPU PNG:', gpuPng);
    console.info('[Liclick UV Debug] DIFF PNG: red=CPU only, cyan=GPU only, gray=color delta overlap', diffPng);

    if (options.download) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      createDownloadLink(cpuPng, `liclick-uv-debug-${stamp}-cpu.png`);
      createDownloadLink(gpuPng, `liclick-uv-debug-${stamp}-gpu.png`);
      createDownloadLink(diffPng, `liclick-uv-debug-${stamp}-diff.png`);
    }

    return result;
  } finally {
    console.groupEnd();
  }
}

export async function debugCompareCpuGpuUvGradient(options: UvGradientDebugOptions = {}) {
  const importedModel = useSceneStore.getState().importedModel;
  const renderer = useSceneStore.getState().viewport?.gl;
  if (!importedModel || !renderer) throw new Error('Please import a model and wait for the viewport first.');
  const objectId = options.objectId ?? useSceneStore.getState().selectedObjectId ?? importedModel.objectId;
  const resolution = options.resolution ?? (512 as UvBakeResolution);
  const rendererPixelRatioBefore = renderer.getPixelRatio();
  const startedAt = performance.now();
  console.groupCollapsed(`[Liclick UV Debug] CPU/GPU UV-space gradient ${resolution}px`);
  console.table({
    objectId,
    resolution,
    browserDevicePixelRatio: window.devicePixelRatio,
    rendererPixelRatioBefore,
    offscreenBakePixelRatio: 1,
    purpose: 'Checks UV-space render target mapping only; no projected image, mask, depth, or object matrix.',
    canonicalUvPng: 'row 0 = UV v 1, row h-1 = UV v 0',
  });
  try {
    const cpu = renderCpuUvGradient(importedModel.group, resolution);
    const gpu = renderGpuUvGradient(renderer, importedModel.group, resolution);
    const { diff, metrics } = makeDiffImage(cpu.imageData, gpu.imageData);
    const diffCanvas = document.createElement('canvas');
    diffCanvas.width = resolution;
    diffCanvas.height = resolution;
    getContext2d(diffCanvas, 'UV gradient diff').putImageData(diff, 0, 0);
    const result = {
      ok: true,
      elapsedMs: performance.now() - startedAt,
      objectId,
      resolution,
      rendererState: {
        browserDevicePixelRatio: window.devicePixelRatio,
        rendererPixelRatioBefore,
        offscreenBakePixelRatio: 1,
      },
      metrics,
      canvases: {
        cpu: cpu.canvas,
        gpu: gpu.canvas,
        diff: diffCanvas,
      },
      png: {
        cpu: cpu.canvas.toDataURL('image/png'),
        gpu: gpu.canvas.toDataURL('image/png'),
        diff: diffCanvas.toDataURL('image/png'),
      },
    };
    console.table(metrics);
    console.info('[Liclick UV Debug] UV gradient CPU PNG:', result.png.cpu);
    console.info('[Liclick UV Debug] UV gradient GPU PNG:', result.png.gpu);
    console.info('[Liclick UV Debug] UV gradient DIFF PNG:', result.png.diff);
    if (options.download) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      createDownloadLink(result.png.cpu, `liclick-uv-gradient-${stamp}-cpu.png`);
      createDownloadLink(result.png.gpu, `liclick-uv-gradient-${stamp}-gpu.png`);
      createDownloadLink(result.png.diff, `liclick-uv-gradient-${stamp}-diff.png`);
    }
    return result;
  } finally {
    console.groupEnd();
  }
}
