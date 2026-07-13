import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Bvh } from '@react-three/drei';
import {
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
  type DragEvent,
  type PointerEvent,
  type WheelEvent,
} from 'react';
import * as THREE from 'three';
import { useDragInteractionStore } from '@/stores/dragInteractionStore';
import { useEditorHistoryStore } from '@/stores/editorHistoryStore';
import { useLayerStore } from '@/stores/layerStore';
import { useProjectStore } from '@/stores/projectStore';
import { useSceneStore, type LocalRepaintProjectionSource } from '@/stores/sceneStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useToastStore } from '@/stores/toastStore';
import { useT } from '@/stores/i18nStore';
import { useWorkspaceLayoutStore } from '@/components/workspace/workspaceLayoutStore';
import {
  getLiveProjectedCanvasState,
  getLiveProjectedCanvasTexture,
  markLiveProjectedCanvasTextureUpdated,
  registerLiveProjectedCanvasTexture,
} from '@/engine/projection/liveProjectedCanvasTextureRegistry';
import { SceneRoot } from './SceneRoot';
import { CameraController } from './CameraController';
import { ViewCube } from './ViewCube';
import type { Layer } from '@/types/layer';
import { createId } from '@/utils/id';

type SurfacePaintTarget = {
  objectId: string;
  group: THREE.Object3D;
  boundingSize: THREE.Vector3;
};

type ViewportCanvasProps = {
  hasImportedModel: boolean;
  onImportModels: (files: File[]) => void;
  onImportReferenceImages: (files: File[]) => void;
  onOpenImport: () => void;
};

const MODEL_FILE_EXTENSIONS = new Set(['glb', 'gltf', 'fbx', 'obj', 'stl']);
const IMAGE_FILE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp']);

function RendererSettings() {
  const { gl } = useThree();
  const exposure = useSettingsStore((state) => state.exposure);

  useEffect(() => {
    gl.outputColorSpace = THREE.SRGBColorSpace;
    gl.toneMapping = THREE.LinearToneMapping;
    gl.toneMappingExposure = exposure;
  }, [exposure, gl]);

  return null;
}

function getFileExtension(file: File) {
  return file.name.split('.').pop()?.toLowerCase();
}

function getDragPayload(event: DragEvent<HTMLDivElement>) {
  const files = Array.from(event.dataTransfer.files);
  const modelFiles = files.filter((file) => {
    const extension = getFileExtension(file);
    return Boolean(extension && MODEL_FILE_EXTENSIONS.has(extension));
  });
  const imageFiles = files.filter((file) => {
    const extension = getFileExtension(file);
    if (extension && IMAGE_FILE_EXTENSIONS.has(extension)) return true;
    return file.type.startsWith('image/');
  });
  return {
    modelFiles,
    imageFiles,
    dragType:
      modelFiles.length > 0 ? 'model-file' : imageFiles.length > 0 ? 'asset-file' : undefined,
  } as const;
}

const UV_PAINT_RESOLUTION = 512;
const UV_MASK_PAINT_RESOLUTION = 1024;
const UV_STROKE_PREVIEW_RESOLUTION = 512;
const UV_TEXTURE_RESOLUTION = {
  '1K': 1024,
  '2K': 2048,
  '4K': 4096,
  '8K': 8192,
} as const;
const PAINT_HISTORY_TILE_SIZE = 256;
const PROJECTION_PAINT_MAX_SIZE = 512;
const INPAINT_BRUSH_WORLD_SCALE = 0.09;
const INPAINT_BRUSH_TEXTURE_SCALE = 0.35;
const LOCAL_REPAINT_PROJECTION_LAYER_ID_PREFIX = 'local-repaint-projection';
const LEGACY_LOCAL_REPAINT_PROJECTION_LAYER_ID_PREFIX = 'local-repaint-brush-projection';
const surfacePaintPerfSamples: number[] = [];
const gpuFrameTimeSamples: number[] = [];
let surfacePaintPerfFrame: number | undefined;

type ViewportTelemetrySnapshot = {
  drawCalls: number;
  triangles: number;
  textures: number;
  geometries: number;
  programs: number;
  width: number;
  height: number;
  dpr: number;
  maxTextureSize: number;
  maxTextureUnits: number;
  gpuTimerSupported: boolean;
  gpuName: string;
  contextLost: boolean;
};

type StrokeTelemetrySnapshot = {
  endReason: 'pointerup' | 'pointercancel' | 'effect-cleanup';
  durationMs: number;
  pointerEvents: number;
  coalescedEvents: number;
  raycasts: number;
  hits: number;
  misses: number;
  continuityBreaks: number;
  maxPointerGapPx: number;
};

let lastStrokeTelemetry: StrokeTelemetrySnapshot | undefined;

const viewportTelemetry: ViewportTelemetrySnapshot = {
  drawCalls: 0,
  triangles: 0,
  textures: 0,
  geometries: 0,
  programs: 0,
  width: 0,
  height: 0,
  dpr: 1,
  maxTextureSize: 0,
  maxTextureUnits: 0,
  gpuTimerSupported: false,
  gpuName: 'WebGL',
  contextLost: false,
};

function recordSurfacePaintPerf(durationMs: number) {
  surfacePaintPerfSamples.push(durationMs);
  if (surfacePaintPerfSamples.length > 600) surfacePaintPerfSamples.shift();
  if (!import.meta.env.DEV) return;
  if (surfacePaintPerfFrame !== undefined) return;
  surfacePaintPerfFrame = window.requestAnimationFrame(() => {
    surfacePaintPerfFrame = undefined;
    const sorted = [...surfacePaintPerfSamples].sort((a, b) => a - b);
    const total = surfacePaintPerfSamples.reduce((sum, value) => sum + value, 0);
    document.body.dataset.surfacePaintPerf = JSON.stringify({
      samples: surfacePaintPerfSamples.length,
      averageMs: total / Math.max(1, surfacePaintPerfSamples.length),
      p95Ms: sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? 0,
      maxMs: sorted[sorted.length - 1] ?? 0,
    });
  });
}

function AcceleratedSceneRoot() {
  const modelSignature = useSceneStore((state) =>
    state.importedModels.map((model) => `${model.objectId}:${model.group.uuid}`).join('|'),
  );

  return (
    <Bvh key={modelSignature} firstHitOnly maxLeafTris={12} verbose={false}>
      <SceneRoot />
    </Bvh>
  );
}

type GpuTimerQueryExtension = {
  TIME_ELAPSED_EXT: number;
  GPU_DISJOINT_EXT: number;
};

function percentile(samples: number[], ratio: number) {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)] ?? 0;
}

function ViewportPerformanceProbe({ enabled }: { enabled: boolean }) {
  const { gl } = useThree();

  useFrame(() => {
    if (!enabled) return;
    viewportTelemetry.drawCalls = gl.info.render.calls;
    viewportTelemetry.triangles = gl.info.render.triangles;
    viewportTelemetry.textures = gl.info.memory.textures;
    viewportTelemetry.geometries = gl.info.memory.geometries;
    viewportTelemetry.programs = gl.info.programs?.length ?? 0;
    viewportTelemetry.width = gl.domElement.width;
    viewportTelemetry.height = gl.domElement.height;
    viewportTelemetry.dpr = gl.getPixelRatio();
    viewportTelemetry.contextLost = gl.getContext().isContextLost();
  });

  useEffect(() => {
    if (!enabled) return undefined;
    const context = gl.getContext();
    viewportTelemetry.maxTextureSize = gl.capabilities.maxTextureSize;
    viewportTelemetry.maxTextureUnits = gl.capabilities.maxTextures;
    const debugRenderer = context.getExtension('WEBGL_debug_renderer_info');
    viewportTelemetry.gpuName = debugRenderer
      ? String(context.getParameter(debugRenderer.UNMASKED_RENDERER_WEBGL))
      : gl.capabilities.isWebGL2
        ? 'WebGL2 GPU'
        : 'WebGL GPU';

    if (!(context instanceof WebGL2RenderingContext)) {
      viewportTelemetry.gpuTimerSupported = false;
      return undefined;
    }
    const extension = context.getExtension(
      'EXT_disjoint_timer_query_webgl2',
    ) as GpuTimerQueryExtension | null;
    if (!extension) {
      viewportTelemetry.gpuTimerSupported = false;
      return undefined;
    }

    viewportTelemetry.gpuTimerSupported = true;
    const pendingQueries: WebGLQuery[] = [];
    const originalRender = gl.render;
    const pollQueries = () => {
      if (context.getParameter(extension.GPU_DISJOINT_EXT)) {
        pendingQueries.splice(0).forEach((query) => context.deleteQuery(query));
        gpuFrameTimeSamples.length = 0;
        return;
      }
      while (pendingQueries.length > 0) {
        const query = pendingQueries[0];
        if (!context.getQueryParameter(query, context.QUERY_RESULT_AVAILABLE)) break;
        pendingQueries.shift();
        const elapsedNanoseconds = Number(context.getQueryParameter(query, context.QUERY_RESULT));
        context.deleteQuery(query);
        if (!Number.isFinite(elapsedNanoseconds)) continue;
        gpuFrameTimeSamples.push(elapsedNanoseconds / 1_000_000);
        if (gpuFrameTimeSamples.length > 240) gpuFrameTimeSamples.shift();
      }
    };
    const wrappedRender: typeof gl.render = (scene, camera) => {
      pollQueries();
      const query = pendingQueries.length < 8 ? context.createQuery() : null;
      let queryStarted = false;
      if (query) {
        try {
          context.beginQuery(extension.TIME_ELAPSED_EXT, query);
          queryStarted = true;
        } catch {
          context.deleteQuery(query);
        }
      }
      try {
        originalRender.call(gl, scene, camera);
      } finally {
        if (queryStarted && query) {
          context.endQuery(extension.TIME_ELAPSED_EXT);
          pendingQueries.push(query);
        }
      }
    };
    gl.render = wrappedRender;

    return () => {
      if (gl.render === wrappedRender) gl.render = originalRender;
      pendingQueries.forEach((query) => context.deleteQuery(query));
      viewportTelemetry.gpuTimerSupported = false;
    };
  }, [enabled, gl]);

  return null;
}

type PerformanceHudMetrics = {
  fps: number;
  frameP95: number;
  droppedFrames: number;
  paintP95: number;
  paintMax: number;
  paintSamples: number;
  cpuLongTaskPercent: number;
  gpuP95: number;
  gpuSamples: number;
  heapUsedMb?: number;
  heapLimitMb?: number;
};

function metricTone(value: number, good: number, warning: number, higherIsBetter = false) {
  const goodValue = higherIsBetter ? value >= good : value <= good;
  const warningValue = higherIsBetter ? value >= warning : value <= warning;
  if (goodValue) return 'text-emerald-300';
  if (warningValue) return 'text-amber-300';
  return 'text-rose-300';
}

function PerformanceMetric({
  label,
  value,
  tone = 'text-white',
}: {
  label: string;
  value: string;
  tone?: string;
}) {
  return (
    <div className="min-w-0 rounded border border-white/10 bg-white/[0.045] px-2.5 py-1.5">
      <div className="truncate text-[10px] leading-4 text-white/45">{label}</div>
      <div className={`truncate font-mono text-xs font-semibold ${tone}`}>{value}</div>
    </div>
  );
}

function PerformanceTestHud() {
  const [collapsed, setCollapsed] = useState(false);
  const [metrics, setMetrics] = useState<PerformanceHudMetrics>({
    fps: 0,
    frameP95: 0,
    droppedFrames: 0,
    paintP95: 0,
    paintMax: 0,
    paintSamples: 0,
    cpuLongTaskPercent: 0,
    gpuP95: 0,
    gpuSamples: 0,
  });

  useEffect(() => {
    let animationFrame = 0;
    let previousFrameAt = performance.now();
    let cpuWindowStartedAt = previousFrameAt;
    let longTaskDuration = 0;
    const frameTimes: number[] = [];
    const observer =
      typeof PerformanceObserver !== 'undefined' &&
      PerformanceObserver.supportedEntryTypes.includes('longtask')
        ? new PerformanceObserver((list) => {
            list.getEntries().forEach((entry) => {
              longTaskDuration += entry.duration;
            });
          })
        : undefined;
    observer?.observe({ entryTypes: ['longtask'] });

    const sampleFrame = (now: number) => {
      const duration = now - previousFrameAt;
      previousFrameAt = now;
      if (duration > 0 && duration < 1000) {
        frameTimes.push(duration);
        if (frameTimes.length > 240) frameTimes.shift();
      }
      animationFrame = window.requestAnimationFrame(sampleFrame);
    };
    animationFrame = window.requestAnimationFrame(sampleFrame);

    const updateTimer = window.setInterval(() => {
      const now = performance.now();
      const cpuWindowDuration = Math.max(1, now - cpuWindowStartedAt);
      const averageFrame =
        frameTimes.reduce((sum, value) => sum + value, 0) / Math.max(1, frameTimes.length);
      const paintSamples = surfacePaintPerfSamples.slice(-240);
      const gpuSamples = gpuFrameTimeSamples.slice(-120);
      const memory = (
        performance as Performance & {
          memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number };
        }
      ).memory;
      setMetrics({
        fps: averageFrame > 0 ? 1000 / averageFrame : 0,
        frameP95: percentile(frameTimes, 0.95),
        droppedFrames:
          frameTimes.length > 0
            ? (frameTimes.filter((value) => value > 20).length / frameTimes.length) * 100
            : 0,
        paintP95: percentile(paintSamples, 0.95),
        paintMax: paintSamples.length > 0 ? Math.max(...paintSamples) : 0,
        paintSamples: paintSamples.length,
        cpuLongTaskPercent: Math.min(100, (longTaskDuration / cpuWindowDuration) * 100),
        gpuP95: percentile(gpuSamples, 0.95),
        gpuSamples: gpuSamples.length,
        heapUsedMb: memory ? memory.usedJSHeapSize / 1024 / 1024 : undefined,
        heapLimitMb: memory ? memory.jsHeapSizeLimit / 1024 / 1024 : undefined,
      });
      longTaskDuration = 0;
      cpuWindowStartedAt = now;
    }, 500);

    return () => {
      window.cancelAnimationFrame(animationFrame);
      window.clearInterval(updateTimer);
      observer?.disconnect();
    };
  }, []);

  if (collapsed) {
    return (
      <button
        type="button"
        onClick={() => setCollapsed(false)}
        className="absolute bottom-20 right-4 z-[28] rounded-md border border-liclick-pink/55 bg-black/78 px-3 py-2 text-xs font-semibold text-white shadow-xl backdrop-blur-md transition hover:bg-black/90"
      >
        性能测试 · {metrics.fps.toFixed(0)} FPS
      </button>
    );
  }

  return (
    <section className="absolute bottom-20 left-1/2 z-[28] w-[min(94vw,980px)] -translate-x-1/2 rounded-lg border border-white/16 bg-[#0b0b10]/92 p-2.5 text-white shadow-[0_18px_55px_rgba(0,0,0,0.48)] backdrop-blur-xl">
      <div className="mb-2 flex items-center justify-between gap-3 px-0.5">
        <div className="flex min-w-0 items-center gap-2">
          <span
            className={`h-2 w-2 shrink-0 rounded-full ${viewportTelemetry.contextLost ? 'bg-rose-400' : 'bg-emerald-400'}`}
          />
          <span className="shrink-0 text-xs font-semibold">性能测试</span>
          <span className="truncate text-[10px] text-white/38" title={viewportTelemetry.gpuName}>
            {viewportTelemetry.gpuName}
          </span>
        </div>
        <button
          type="button"
          onClick={() => setCollapsed(true)}
          className="rounded px-2 py-1 text-[11px] text-white/55 transition hover:bg-white/10 hover:text-white"
        >
          收起
        </button>
      </div>
      <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-6">
        <PerformanceMetric
          label="FPS"
          value={metrics.fps.toFixed(0)}
          tone={metricTone(metrics.fps, 50, 30, true)}
        />
        <PerformanceMetric
          label="帧耗时 P95"
          value={`${metrics.frameP95.toFixed(1)} ms`}
          tone={metricTone(metrics.frameP95, 20, 33)}
        />
        <PerformanceMetric
          label="掉帧率 (>20ms)"
          value={`${metrics.droppedFrames.toFixed(0)}%`}
          tone={metricTone(metrics.droppedFrames, 5, 20)}
        />
        <PerformanceMetric
          label={`画笔输入 P95 · ${metrics.paintSamples}`}
          value={metrics.paintSamples ? `${metrics.paintP95.toFixed(1)} ms` : '等待绘制'}
          tone={metricTone(metrics.paintP95, 8, 16)}
        />
        <PerformanceMetric
          label="上笔 UV 断点 / 射线未命中"
          value={
            lastStrokeTelemetry
              ? `${lastStrokeTelemetry.continuityBreaks} / ${lastStrokeTelemetry.misses}`
              : '等待绘制'
          }
          tone={
            !lastStrokeTelemetry ||
            (lastStrokeTelemetry.continuityBreaks === 0 && lastStrokeTelemetry.misses === 0)
              ? 'text-emerald-300'
              : 'text-amber-300'
          }
        />
        <PerformanceMetric
          label="CPU 长任务占比"
          value={`${metrics.cpuLongTaskPercent.toFixed(1)}%`}
          tone={metricTone(metrics.cpuLongTaskPercent, 5, 20)}
        />
        <PerformanceMetric
          label="GPU P95 / 16.7ms 预算"
          value={
            viewportTelemetry.gpuTimerSupported
              ? metrics.gpuSamples
                ? `${metrics.gpuP95.toFixed(1)}ms / ${Math.round((metrics.gpuP95 / 16.67) * 100)}%`
                : '采样中'
              : '不支持'
          }
          tone={metricTone(metrics.gpuP95, 12, 22)}
        />
        <PerformanceMetric
          label="WebGL Draw Calls"
          value={viewportTelemetry.drawCalls.toLocaleString()}
        />
        <PerformanceMetric
          label="三角形 / 帧"
          value={viewportTelemetry.triangles.toLocaleString()}
        />
        <PerformanceMetric
          label="纹理 / 几何 / 程序"
          value={`${viewportTelemetry.textures} / ${viewportTelemetry.geometries} / ${viewportTelemetry.programs}`}
        />
        <PerformanceMetric
          label="纹理单元 / 最大尺寸"
          value={`${viewportTelemetry.maxTextureUnits} / ${viewportTelemetry.maxTextureSize}`}
        />
        <PerformanceMetric
          label="画布 / DPR / JS 堆"
          value={`${viewportTelemetry.width}×${viewportTelemetry.height} / ${viewportTelemetry.dpr.toFixed(1)} / ${metrics.heapUsedMb === undefined ? 'N/A' : `${metrics.heapUsedMb.toFixed(0)}MB`}`}
          tone={
            metrics.heapUsedMb !== undefined &&
            metrics.heapLimitMb !== undefined &&
            metrics.heapUsedMb / metrics.heapLimitMb > 0.8
              ? 'text-rose-300'
              : 'text-white'
          }
        />
      </div>
    </section>
  );
}
type UvPaintLayer = {
  objectId: string;
  layerId: string;
  target: 'uv-image' | 'projected-mask' | 'inpaint-mask';
  assetUrl: string;
  ready: Promise<void>;
  isReady: boolean;
  paintBackingInitialized: boolean;
  paintDefaultResolution: number;
  paintCommitChain: Promise<void>;
  pendingBaseImage?: HTMLImageElement;
  paintCanvas: HTMLCanvasElement;
  paintContext: CanvasRenderingContext2D;
  paintTexture: THREE.CanvasTexture;
  paintPreviewCanvas: HTMLCanvasElement;
  paintPreviewContext: CanvasRenderingContext2D;
  paintPreviewTexture: THREE.CanvasTexture;
  paintPreviewMaterial: THREE.MeshBasicMaterial;
  paintOverlayTargets: Set<THREE.Mesh>;
  paintPreviewOverlays: THREE.Mesh[];
  projectionCanvas: HTMLCanvasElement;
  projectionContext: CanvasRenderingContext2D;
  maskCanvas: HTMLCanvasElement;
  maskContext: CanvasRenderingContext2D;
  maskDisplayCanvas: HTMLCanvasElement;
  maskDisplayContext: CanvasRenderingContext2D;
  maskPattern: CanvasPattern;
  maskTexture: THREE.CanvasTexture;
  maskDisplayTexture: THREE.CanvasTexture;
  maskMaterial: THREE.ShaderMaterial;
  overlayMeshes: THREE.Mesh[];
  overlayTargets: Set<THREE.Mesh>;
  maskSolidNormalized: boolean;
};

type UvPaintHit = {
  model: SurfacePaintTarget;
  hit: THREE.Intersection<THREE.Object3D>;
  uv: THREE.Vector2;
  screenUv: THREE.Vector2;
  worldRadius: number;
  textureRadius: number;
};

type UvPaintSample = {
  meshUuid: string;
  faceIndex?: number;
  uv: THREE.Vector2;
  screenUv: THREE.Vector2;
  point: THREE.Vector3;
};

type PaintDirtyRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type PaintStrokeDraft = {
  layer: UvPaintLayer;
  target: 'paint' | 'mask' | 'apply-local-repaint';
  bounds?: PaintDirtyRect;
  paintOperation?: 'brush' | 'eraser';
};

type ClientPoint = { x: number; y: number };

function resampleClientPath(
  start: ClientPoint | undefined,
  targets: ClientPoint[],
  maxSamples = 256,
) {
  const points = start ? [start, ...targets] : targets;
  if (points.length === 0) return { samples: [] as ClientPoint[], maxGapPx: 0 };
  if (points.length === 1) return { samples: [points[0]], maxGapPx: 0 };
  const segmentLengths: number[] = [];
  let totalLength = 0;
  let maxGapPx = 0;
  for (let index = 1; index < points.length; index += 1) {
    const length = Math.hypot(
      points[index].x - points[index - 1].x,
      points[index].y - points[index - 1].y,
    );
    segmentLengths.push(length);
    totalLength += length;
    maxGapPx = Math.max(maxGapPx, length);
  }
  if (totalLength <= 0.01) return { samples: [points[points.length - 1]], maxGapPx };

  // Preserve every visible stroke even when the browser delivers a large batch of
  // coalesced events after a slow frame. Three-pixel spacing keeps the smallest
  // brush connected; the high cap avoids unbounded raycast work on pathological input.
  const sampleCount = Math.min(maxSamples, Math.max(1, Math.ceil(totalLength / 3)));
  const samples: ClientPoint[] = [];
  let segmentIndex = 0;
  let segmentStartDistance = 0;
  for (let sampleIndex = 1; sampleIndex <= sampleCount; sampleIndex += 1) {
    const targetDistance = (totalLength * sampleIndex) / sampleCount;
    while (
      segmentIndex < segmentLengths.length - 1 &&
      segmentStartDistance + segmentLengths[segmentIndex] < targetDistance
    ) {
      segmentStartDistance += segmentLengths[segmentIndex];
      segmentIndex += 1;
    }
    const segmentLength = Math.max(segmentLengths[segmentIndex], 0.0001);
    const ratio = THREE.MathUtils.clamp(
      (targetDistance - segmentStartDistance) / segmentLength,
      0,
      1,
    );
    samples.push({
      x: THREE.MathUtils.lerp(points[segmentIndex].x, points[segmentIndex + 1].x, ratio),
      y: THREE.MathUtils.lerp(points[segmentIndex].y, points[segmentIndex + 1].y, ratio),
    });
  }
  return { samples, maxGapPx };
}

type LocalRepaintCompositeState = {
  sourceKey: string;
  layerId: string;
  maskUrl: string;
  maskCanvas: HTMLCanvasElement;
  maskContext: CanvasRenderingContext2D;
  scratchCanvas: HTMLCanvasElement;
  scratchContext: CanvasRenderingContext2D;
};

type LocalRepaintAllowedMaskState = {
  url: string;
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
  data: ImageData;
};

type PaintableMeshCache = {
  objectId: string;
  groupUuid: string;
  meshes: THREE.Mesh[];
};

function createPaintCanvas(size = UV_PAINT_RESOLUTION, willReadFrequently = true) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d', { willReadFrequently });
  if (!context) throw new Error('Could not create UV paint canvas.');
  return { canvas, context };
}

function copyCanvasRect(source: HTMLCanvasElement, bounds: PaintDirtyRect) {
  const copy = document.createElement('canvas');
  copy.width = bounds.width;
  copy.height = bounds.height;
  const context = copy.getContext('2d');
  if (!context) throw new Error('Could not create paint history tile.');
  context.drawImage(
    source,
    bounds.x,
    bounds.y,
    bounds.width,
    bounds.height,
    0,
    0,
    bounds.width,
    bounds.height,
  );
  return copy;
}

function createInpaintMaskPattern(context: CanvasRenderingContext2D) {
  const patternCanvas = document.createElement('canvas');
  patternCanvas.width = 24;
  patternCanvas.height = 24;
  const patternContext = patternCanvas.getContext('2d');
  if (!patternContext) throw new Error('Could not create UV mask pattern.');
  patternContext.clearRect(0, 0, patternCanvas.width, patternCanvas.height);
  patternContext.strokeStyle = 'rgba(214, 112, 62, 0.64)';
  patternContext.lineWidth = 6;
  patternContext.lineCap = 'butt';
  patternContext.beginPath();
  for (let offset = -48; offset <= 72; offset += 12) {
    patternContext.moveTo(offset, -18);
    patternContext.lineTo(offset + 48, 30);
  }
  patternContext.stroke();
  const pattern = context.createPattern(patternCanvas, 'repeat');
  if (!pattern) throw new Error('Could not create UV mask brush pattern.');
  return pattern;
}

function createInpaintMaskMaterial(maskTexture: THREE.CanvasTexture) {
  return new THREE.ShaderMaterial({
    uniforms: {
      maskMap: { value: maskTexture },
      stripeColor: { value: new THREE.Color('#d6703e') },
      stripeOpacity: { value: 0.64 },
      stripePeriod: { value: 14 },
      stripeWidth: { value: 7 },
    },
    vertexShader: `
      varying vec2 vUv;

      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform sampler2D maskMap;
      uniform vec3 stripeColor;
      uniform float stripeOpacity;
      uniform float stripePeriod;
      uniform float stripeWidth;
      varying vec2 vUv;

      void main() {
        float maskAlpha = texture2D(maskMap, vUv).a;
        if (maskAlpha < 0.02) discard;

        float coord = mod(gl_FragCoord.x + gl_FragCoord.y, stripePeriod);
        float edge = 1.0;
        float stripe = 1.0 - smoothstep(stripeWidth - edge, stripeWidth + edge, coord);
        if (stripe <= 0.01) discard;

        gl_FragColor = vec4(stripeColor, stripeOpacity * stripe * maskAlpha);
      }
    `,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    polygonOffset: true,
    polygonOffsetFactor: -8,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
}

function configureCanvasTexture(texture: THREE.CanvasTexture, colorSpace: THREE.ColorSpace) {
  texture.colorSpace = colorSpace;
  texture.flipY = true;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
}

function disposeUvPaintLayer(layer?: UvPaintLayer) {
  if (!layer) return;
  layer.overlayMeshes.forEach((mesh) => mesh.removeFromParent());
  layer.paintPreviewTexture.dispose();
  layer.paintPreviewMaterial.dispose();
  layer.maskTexture.dispose();
  layer.maskDisplayTexture.dispose();
  layer.maskMaterial.dispose();
}

function hasCanvasAlpha(canvas: HTMLCanvasElement, context: CanvasRenderingContext2D) {
  const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
  for (let index = 3; index < data.length; index += 4) {
    if (data[index] > 0) return true;
  }
  return false;
}

function projectionMaskToDataUrl(source: HTMLCanvasElement) {
  const canvas = document.createElement('canvas');
  canvas.width = source.width;
  canvas.height = source.height;
  const context = canvas.getContext('2d');
  if (!context) return source.toDataURL('image/png');
  context.fillStyle = '#000000';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(source, 0, 0);
  return canvas.toDataURL('image/png');
}

function loadImageElement(url: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Could not load local repaint mask.'));
    image.src = url;
  });
}

function createLocalRepaintSourceKey(source: LocalRepaintProjectionSource, objectId: string) {
  return [
    source.generationId ?? '',
    source.captureId ?? '',
    source.objectId ?? objectId,
    source.targetLayerId ?? '',
    source.imageUrl,
  ].join('|');
}

function isLocalRepaintProjectionLayer(layer: Layer) {
  return (
    layer.type === 'projected' &&
    (layer.id.startsWith(LOCAL_REPAINT_PROJECTION_LAYER_ID_PREFIX) ||
      layer.id.startsWith(LEGACY_LOCAL_REPAINT_PROJECTION_LAYER_ID_PREFIX))
  );
}

function isMatchingLocalRepaintProjectionLayer(
  layer: Layer,
  source: LocalRepaintProjectionSource,
  objectId: string,
) {
  if (!isLocalRepaintProjectionLayer(layer)) return false;
  if (source.targetLayerId && layer.replacementTargetLayerId !== source.targetLayerId) return false;
  if (source.generationId) return layer.generationId === source.generationId;
  if (source.captureId) return layer.captureId === source.captureId;
  return !layer.objectId || layer.objectId === (source.objectId ?? objectId);
}

function createLocalRepaintComposite(
  sourceKey: string,
  layerId: string,
  width: number,
  height: number,
): LocalRepaintCompositeState | undefined {
  const maskCanvas = document.createElement('canvas');
  maskCanvas.width = width;
  maskCanvas.height = height;
  const maskContext = maskCanvas.getContext('2d');
  const scratchCanvas = document.createElement('canvas');
  scratchCanvas.width = width;
  scratchCanvas.height = height;
  const scratchContext = scratchCanvas.getContext('2d');
  if (!maskContext || !scratchContext) return undefined;
  const maskUrl = registerLiveProjectedCanvasTexture(layerId, maskCanvas, THREE.NoColorSpace);
  return { sourceKey, layerId, maskUrl, maskCanvas, maskContext, scratchCanvas, scratchContext };
}

function resizeLocalRepaintComposite(
  composite: LocalRepaintCompositeState,
  width: number,
  height: number,
) {
  if (composite.maskCanvas.width === width && composite.maskCanvas.height === height) return;
  composite.maskCanvas.width = width;
  composite.maskCanvas.height = height;
  composite.scratchCanvas.width = width;
  composite.scratchCanvas.height = height;
  registerLiveProjectedCanvasTexture(composite.layerId, composite.maskCanvas, THREE.NoColorSpace);
}

function drawLocalRepaintStrokeMaskPatch(
  composite: LocalRepaintCompositeState,
  sourceImage: HTMLImageElement,
  allowedMask: LocalRepaintAllowedMaskState,
  strokeMask: HTMLCanvasElement,
  dirtyRect: PaintDirtyRect,
) {
  resizeLocalRepaintComposite(composite, strokeMask.width, strokeMask.height);
  composite.scratchContext.save();
  composite.scratchContext.globalCompositeOperation = 'source-over';
  composite.scratchContext.clearRect(dirtyRect.x, dirtyRect.y, dirtyRect.width, dirtyRect.height);
  composite.scratchContext.drawImage(
    strokeMask,
    dirtyRect.x,
    dirtyRect.y,
    dirtyRect.width,
    dirtyRect.height,
    dirtyRect.x,
    dirtyRect.y,
    dirtyRect.width,
    dirtyRect.height,
  );
  composite.scratchContext.globalCompositeOperation = 'destination-in';
  composite.scratchContext.drawImage(
    sourceImage,
    dirtyRect.x,
    dirtyRect.y,
    dirtyRect.width,
    dirtyRect.height,
    dirtyRect.x,
    dirtyRect.y,
    dirtyRect.width,
    dirtyRect.height,
  );
  composite.scratchContext.drawImage(
    allowedMask.canvas,
    dirtyRect.x,
    dirtyRect.y,
    dirtyRect.width,
    dirtyRect.height,
    dirtyRect.x,
    dirtyRect.y,
    dirtyRect.width,
    dirtyRect.height,
  );
  composite.scratchContext.restore();
  composite.maskContext.drawImage(
    composite.scratchCanvas,
    dirtyRect.x,
    dirtyRect.y,
    dirtyRect.width,
    dirtyRect.height,
    dirtyRect.x,
    dirtyRect.y,
    dirtyRect.width,
    dirtyRect.height,
  );
  composite.scratchContext.clearRect(dirtyRect.x, dirtyRect.y, dirtyRect.width, dirtyRect.height);
  markLiveProjectedCanvasTextureUpdated(composite.maskUrl);
}

function canvasToPngDataUrl(canvas: HTMLCanvasElement) {
  return new Promise<string>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error('Could not encode local repaint projection image.'));
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        if (typeof reader.result === 'string') {
          resolve(reader.result);
          return;
        }
        reject(new Error('Could not read local repaint projection image.'));
      };
      reader.onerror = () =>
        reject(reader.error ?? new Error('Could not read local repaint projection image.'));
      reader.readAsDataURL(blob);
    }, 'image/png');
  });
}

function unionDirtyRect(a: PaintDirtyRect | undefined, b: PaintDirtyRect): PaintDirtyRect {
  if (!a) return b;
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const right = Math.max(a.x + a.width, b.x + b.width);
  const bottom = Math.max(a.y + a.height, b.y + b.height);
  return { x, y, width: right - x, height: bottom - y };
}

function createDirtyRect(
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  radius: number,
  width: number,
  height: number,
): PaintDirtyRect {
  const padding = Math.ceil(radius + 3);
  const x = Math.max(0, Math.floor(Math.min(fromX, toX) - padding));
  const y = Math.max(0, Math.floor(Math.min(fromY, toY) - padding));
  const right = Math.min(width, Math.ceil(Math.max(fromX, toX) + padding));
  const bottom = Math.min(height, Math.ceil(Math.max(fromY, toY) + padding));
  return { x, y, width: Math.max(1, right - x), height: Math.max(1, bottom - y) };
}

function resizeProjectionCanvas(layer: UvPaintLayer, aspect: number) {
  const safeAspect = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
  const width =
    safeAspect >= 1
      ? PROJECTION_PAINT_MAX_SIZE
      : Math.max(1, Math.round(PROJECTION_PAINT_MAX_SIZE * safeAspect));
  const height =
    safeAspect >= 1
      ? Math.max(1, Math.round(PROJECTION_PAINT_MAX_SIZE / safeAspect))
      : PROJECTION_PAINT_MAX_SIZE;
  if (layer.projectionCanvas.width !== width || layer.projectionCanvas.height !== height) {
    layer.projectionCanvas.width = width;
    layer.projectionCanvas.height = height;
  }
  layer.projectionContext.clearRect(0, 0, width, height);
}

function getPaintHistoryTileKeys(layer: UvPaintLayer, previewBounds: PaintDirtyRect) {
  const keys = new Set<string>();
  const previewCanvas = layer.paintPreviewCanvas;
  const paintCanvas = layer.paintCanvas;
  const scaleX = paintCanvas.width / previewCanvas.width;
  const scaleY = paintCanvas.height / previewCanvas.height;
  const x = Math.max(0, Math.floor(previewBounds.x * scaleX));
  const y = Math.max(0, Math.floor(previewBounds.y * scaleY));
  const right = Math.min(
    paintCanvas.width,
    Math.ceil((previewBounds.x + previewBounds.width) * scaleX),
  );
  const bottom = Math.min(
    paintCanvas.height,
    Math.ceil((previewBounds.y + previewBounds.height) * scaleY),
  );
  const startTileX = Math.floor(x / PAINT_HISTORY_TILE_SIZE);
  const startTileY = Math.floor(y / PAINT_HISTORY_TILE_SIZE);
  const endTileX = Math.floor((Math.max(x + 1, right) - 1) / PAINT_HISTORY_TILE_SIZE);
  const endTileY = Math.floor((Math.max(y + 1, bottom) - 1) / PAINT_HISTORY_TILE_SIZE);
  for (let tileY = startTileY; tileY <= endTileY; tileY += 1) {
    for (let tileX = startTileX; tileX <= endTileX; tileX += 1) {
      keys.add(`${tileX}:${tileY}`);
    }
  }
  return keys;
}

function ensurePaintBackingCanvasInitialized(layer: UvPaintLayer) {
  if (layer.paintBackingInitialized) return;
  const baseImage = layer.pendingBaseImage;
  layer.paintCanvas.width =
    baseImage?.naturalWidth || baseImage?.width || layer.paintDefaultResolution;
  layer.paintCanvas.height =
    baseImage?.naturalHeight || baseImage?.height || layer.paintDefaultResolution;
  if (baseImage) {
    layer.paintContext.drawImage(
      baseImage,
      0,
      0,
      layer.paintCanvas.width,
      layer.paintCanvas.height,
    );
    layer.pendingBaseImage = undefined;
  } else if (layer.target === 'projected-mask') {
    layer.paintContext.fillStyle = '#ffffff';
    layer.paintContext.fillRect(0, 0, layer.paintCanvas.width, layer.paintCanvas.height);
  }
  layer.paintBackingInitialized = true;
}

function getPaintHistoryTileBounds(
  canvas: HTMLCanvasElement,
  key: string,
): PaintDirtyRect | undefined {
  const [tileX, tileY] = key.split(':').map(Number);
  if (!Number.isFinite(tileX) || !Number.isFinite(tileY)) return undefined;
  const x = tileX * PAINT_HISTORY_TILE_SIZE;
  const y = tileY * PAINT_HISTORY_TILE_SIZE;
  const width = Math.min(PAINT_HISTORY_TILE_SIZE, canvas.width - x);
  const height = Math.min(PAINT_HISTORY_TILE_SIZE, canvas.height - y);
  if (width <= 0 || height <= 0) return undefined;
  return { x, y, width, height };
}

function resizeProjectionCanvasToSize(layer: UvPaintLayer, width: number, height: number) {
  const safeWidth = Math.max(1, Math.round(width));
  const safeHeight = Math.max(1, Math.round(height));
  if (layer.projectionCanvas.width !== safeWidth || layer.projectionCanvas.height !== safeHeight) {
    layer.projectionCanvas.width = safeWidth;
    layer.projectionCanvas.height = safeHeight;
  }
  layer.projectionContext.clearRect(0, 0, safeWidth, safeHeight);
}

function SurfacePaintOverlay() {
  const { gl, camera, scene } = useThree();
  const cursorRef = useRef<THREE.Mesh>(null);
  const layerRef = useRef<UvPaintLayer>();
  const paintableMeshCacheRef = useRef<PaintableMeshCache>();
  const raycasterRef = useRef(
    new THREE.Raycaster() as THREE.Raycaster & { firstHitOnly?: boolean },
  );
  raycasterRef.current.firstHitOnly = true;
  const pointerRef = useRef(new THREE.Vector2());
  const isPaintingRef = useRef(false);
  const lastUvRef = useRef<THREE.Vector2>();
  const lastSampleRef = useRef<UvPaintSample>();
  const lastPointerClientRef = useRef<{ x: number; y: number }>();
  const activePointerIdRef = useRef<number>();
  const lastPaintActivityAtRef = useRef(0);
  const strokeTelemetryRef = useRef<StrokeTelemetrySnapshot & { startedAt: number }>();
  const strokeDraftRef = useRef<PaintStrokeDraft>();
  const dirtyTexturesRef = useRef(new Set<THREE.CanvasTexture>());
  const textureUpdateFrameRef = useRef<number>();
  const maskDirtyRef = useRef(false);
  const maskHasContentRef = useRef(false);
  const localRepaintAllowedMaskRef = useRef<LocalRepaintAllowedMaskState>();
  const localRepaintSourceImageRef = useRef<{
    url: string;
    image: HTMLImageElement;
    data?: ImageData;
  }>();
  const localRepaintCompositeRef = useRef<LocalRepaintCompositeState>();
  const localRepaintCommitRevisionRef = useRef(0);
  const localRepaintUvCommitChainRef = useRef(Promise.resolve());
  const cursorNormalMatrixRef = useRef(new THREE.Matrix3());
  const cursorWorldNormalRef = useRef(new THREE.Vector3());
  const cursorLocalPointRef = useRef(new THREE.Vector3());
  const cursorLocalHitPointRef = useRef(new THREE.Vector3());
  const cursorNormalEndRef = useRef(new THREE.Vector3());
  const cursorLocalNormalRef = useRef(new THREE.Vector3());
  const cursorWorldScaleRef = useRef(new THREE.Vector3());
  const cursorQuaternionRef = useRef(new THREE.Quaternion());
  const cursorZAxisRef = useRef(new THREE.Vector3(0, 0, 1));
  const paintTool = useSceneStore((state) => state.paintTool);
  const paintMaskResetRevision = useSceneStore((state) => state.paintMaskResetRevision);
  const paintMaskSettings = useSceneStore((state) => state.paintMaskSettings);
  const paintToolSettings = useSceneStore((state) => state.paintToolSettings);
  const localRepaintProjectionSource = useSceneStore((state) => state.localRepaintProjectionSource);
  const setPaintMaskDataUrl = useSceneStore((state) => state.setPaintMaskDataUrl);
  const setOrbitControlsEnabled = useSceneStore((state) => state.setOrbitControlsEnabled);
  const importedModel = useSceneStore((state) => state.importedModel);
  const selectedObjectId = useSceneStore((state) => state.selectedObjectId);
  const activePaintLayer = useLayerStore((state) =>
    state.layers.find((layer) => layer.id === state.activeProjectedLayerId),
  );
  const setLayers = useLayerStore((state) => state.setLayers);
  const pushToast = useToastStore((state) => state.pushToast);
  const showPanel = useWorkspaceLayoutStore((state) => state.showPanel);
  const setPanelCollapsed = useWorkspaceLayoutStore((state) => state.setPanelCollapsed);
  const t = useT();
  const isInpaintMode = paintTool === 'inpaint-add' || paintTool === 'inpaint-subtract';
  const isLocalRepaintApplyMode = paintTool === 'inpaint-apply';
  const enabled =
    paintTool === 'brush' || paintTool === 'eraser' || isInpaintMode || isLocalRepaintApplyMode;
  const texturePaintReady = Boolean(importedModel || selectedObjectId);
  const canUseSurfacePaint = Boolean(
    texturePaintReady &&
    activePaintLayer &&
    (paintTool === 'brush'
      ? activePaintLayer.type === 'uv'
      : paintTool === 'eraser'
        ? activePaintLayer.type === 'uv' || activePaintLayer.type === 'projected'
        : true),
  );

  const getTargetModel = useCallback((): SurfacePaintTarget | undefined => {
    if (importedModel && (!selectedObjectId || selectedObjectId === importedModel.objectId)) {
      return {
        objectId: importedModel.objectId,
        group: importedModel.group,
        boundingSize: new THREE.Vector3().fromArray(importedModel.boundingBox.size),
      };
    }
    let target: THREE.Object3D | undefined;
    scene.traverse((object) => {
      if (target) return;
      const objectId = object.userData.liclickObjectId;
      if (typeof objectId !== 'string') return;
      if (selectedObjectId && objectId !== selectedObjectId) return;
      if (object instanceof THREE.Group || object.children.length > 0) target = object;
    });
    if (!target) {
      scene.traverse((object) => {
        if (target) return;
        if (object instanceof THREE.Group && object.userData.liclickObjectId) target = object;
      });
    }
    if (!target) return undefined;
    const box = new THREE.Box3().setFromObject(target);
    const size = new THREE.Vector3();
    box.getSize(size);
    return {
      objectId: String(target.userData.liclickObjectId ?? selectedObjectId ?? 'surface-object'),
      group: target,
      boundingSize: size,
    };
  }, [importedModel, scene, selectedObjectId]);

  const getPaintableMeshes = useCallback((model: SurfacePaintTarget) => {
    const cached = paintableMeshCacheRef.current;
    if (cached?.objectId === model.objectId && cached.groupUuid === model.group.uuid)
      return cached.meshes;

    const meshes: THREE.Mesh[] = [];
    model.group.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return;
      if (child.userData.liclickPaintOverlay) return;
      if (!child.geometry.getAttribute('uv')) return;
      meshes.push(child);
    });
    paintableMeshCacheRef.current = {
      objectId: model.objectId,
      groupUuid: model.group.uuid,
      meshes,
    };
    return meshes;
  }, []);

  const getUvPaintLayer = useCallback(
    (model: SurfacePaintTarget) => {
      const layerState = useLayerStore.getState();
      const selectedLayer =
        paintTool === 'brush' || paintTool === 'eraser'
          ? layerState.layers.find((layer) => layer.id === layerState.activeProjectedLayerId)
          : undefined;
      const target =
        selectedLayer?.type === 'projected'
          ? 'projected-mask'
          : selectedLayer
            ? 'uv-image'
            : 'inpaint-mask';
      const layerId = selectedLayer?.id ?? `inpaint:${model.objectId}`;
      if (
        layerRef.current?.objectId === model.objectId &&
        layerRef.current.layerId === layerId &&
        layerRef.current.target === target
      )
        return layerRef.current;
      disposeUvPaintLayer(layerRef.current);

      const existingAssetUrl =
        target === 'uv-image'
          ? selectedLayer?.imageUrl
          : target === 'projected-mask' && selectedLayer?.maskSpace === 'uv'
            ? selectedLayer.maskUrl
            : undefined;
      const existingLiveCanvas = existingAssetUrl
        ? getLiveProjectedCanvasState(existingAssetUrl)?.canvas
        : undefined;
      const paintResolution =
        target === 'uv-image'
          ? UV_TEXTURE_RESOLUTION[useSettingsStore.getState().resolution]
          : target === 'projected-mask'
            ? UV_MASK_PAINT_RESOLUTION
            : UV_PAINT_RESOLUTION;
      const paint = existingLiveCanvas
        ? {
            canvas: existingLiveCanvas,
            context: existingLiveCanvas.getContext('2d'),
          }
        : createPaintCanvas(1, false);
      const paintContext = paint.context;
      if (!paintContext) throw new Error('Could not restore UV paint canvas.');
      const assetId = `surface-edit:${target}:${layerId}`;
      const colorSpace = target === 'uv-image' ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      const flipY = target === 'uv-image';
      const assetUrl = registerLiveProjectedCanvasTexture(assetId, paint.canvas, colorSpace, {
        flipY,
      });
      const paintTexture = getLiveProjectedCanvasTexture(assetUrl, colorSpace, { flipY });
      if (!paintTexture) throw new Error('Could not create live UV paint texture.');
      const projection = createPaintCanvas(PROJECTION_PAINT_MAX_SIZE);
      const paintPreview = createPaintCanvas(UV_STROKE_PREVIEW_RESOLUTION, false);
      const paintPreviewTexture = new THREE.CanvasTexture(paintPreview.canvas);
      configureCanvasTexture(paintPreviewTexture, THREE.SRGBColorSpace);
      const paintPreviewMaterial = new THREE.MeshBasicMaterial({
        map: paintPreviewTexture,
        transparent: true,
        depthTest: true,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -10,
        side: THREE.DoubleSide,
        toneMapped: false,
      });
      const mask = createPaintCanvas();
      const maskDisplay = createPaintCanvas();
      const maskPattern = createInpaintMaskPattern(maskDisplay.context);
      const maskTexture = new THREE.CanvasTexture(mask.canvas);
      const maskDisplayTexture = new THREE.CanvasTexture(maskDisplay.canvas);
      configureCanvasTexture(maskTexture, THREE.NoColorSpace);
      configureCanvasTexture(maskDisplayTexture, THREE.NoColorSpace);

      const maskMaterial = createInpaintMaskMaterial(maskTexture);

      const paintLayer: UvPaintLayer = {
        objectId: model.objectId,
        layerId,
        target,
        assetUrl,
        ready: Promise.resolve(),
        isReady: !existingAssetUrl || Boolean(existingLiveCanvas),
        paintBackingInitialized: Boolean(existingLiveCanvas),
        paintDefaultResolution: paintResolution,
        paintCommitChain: Promise.resolve(),
        paintCanvas: paint.canvas,
        paintContext,
        paintTexture,
        paintPreviewCanvas: paintPreview.canvas,
        paintPreviewContext: paintPreview.context,
        paintPreviewTexture,
        paintPreviewMaterial,
        paintOverlayTargets: new Set(),
        paintPreviewOverlays: [],
        projectionCanvas: projection.canvas,
        projectionContext: projection.context,
        maskCanvas: mask.canvas,
        maskContext: mask.context,
        maskDisplayCanvas: maskDisplay.canvas,
        maskDisplayContext: maskDisplay.context,
        maskPattern,
        maskTexture,
        maskDisplayTexture,
        maskMaterial,
        overlayMeshes: [],
        overlayTargets: new Set(),
        maskSolidNormalized: false,
      };
      if (existingAssetUrl && !existingLiveCanvas) {
        paintLayer.ready = loadImageElement(existingAssetUrl)
          .then((image) => {
            // Decoding may complete while the pointer is down. Keep the decoded
            // image detached and initialize the full-resolution backing canvas only
            // inside the idle commit queue, never in the live stroke path.
            paintLayer.pendingBaseImage = image;
            paintLayer.isReady = true;
          })
          .catch((error) => {
            console.warn('[Liclick 3D Texture] Could not restore UV paint layer:', error);
          });
      }
      layerRef.current = paintLayer;
      return paintLayer;
    },
    [paintTool],
  );

  const ensureOverlayForMesh = useCallback(
    (layer: UvPaintLayer, mesh: THREE.Mesh) => {
      if (layer.overlayTargets.has(mesh)) return;
      layer.overlayTargets.add(mesh);

      const maskOverlay = new THREE.Mesh(mesh.geometry, layer.maskMaterial);
      maskOverlay.name = 'Liclick UV Inpaint Mask Overlay';
      maskOverlay.userData.liclickPaintOverlay = true;
      maskOverlay.userData.liclickInpaintMaskOverlay = true;
      maskOverlay.userData.liclickInpaintMaskTexture = layer.maskTexture;
      maskOverlay.visible = isInpaintMode;
      maskOverlay.renderOrder = 31;
      mesh.add(maskOverlay);
      layer.overlayMeshes.push(maskOverlay);
    },
    [isInpaintMode],
  );

  const ensurePaintPreviewOverlayForMesh = useCallback((layer: UvPaintLayer, mesh: THREE.Mesh) => {
    if (layer.paintOverlayTargets.has(mesh)) return;
    layer.paintOverlayTargets.add(mesh);

    const paintOverlay = new THREE.Mesh(mesh.geometry, layer.paintPreviewMaterial);
    paintOverlay.name = 'Liclick UV Paint Stroke Preview';
    paintOverlay.userData.liclickPaintOverlay = true;
    paintOverlay.userData.liclickPaintStrokePreview = true;
    paintOverlay.renderOrder = 32;
    mesh.add(paintOverlay);
    layer.overlayMeshes.push(paintOverlay);
    layer.paintPreviewOverlays.push(paintOverlay);
  }, []);

  useEffect(() => () => disposeUvPaintLayer(layerRef.current), []);

  const scheduleTextureUpdate = useCallback((texture: THREE.CanvasTexture) => {
    dirtyTexturesRef.current.add(texture);
    if (textureUpdateFrameRef.current !== undefined) return;
    textureUpdateFrameRef.current = window.requestAnimationFrame(() => {
      textureUpdateFrameRef.current = undefined;
      dirtyTexturesRef.current.forEach((dirtyTexture) => {
        dirtyTexture.needsUpdate = true;
      });
      dirtyTexturesRef.current.clear();
    });
  }, []);

  const waitForPaintCommitIdle = useCallback(
    () =>
      new Promise<void>((resolve) => {
        const minimumIdleMs = 140;
        const tryCommit = () => {
          const idleFor = performance.now() - lastPaintActivityAtRef.current;
          if (isPaintingRef.current || idleFor < minimumIdleMs) {
            window.setTimeout(tryCommit, Math.max(16, Math.min(50, minimumIdleMs - idleFor)));
            return;
          }
          const requestIdle = window.requestIdleCallback;
          if (requestIdle) {
            requestIdle(
              () => {
                if (
                  isPaintingRef.current ||
                  performance.now() - lastPaintActivityAtRef.current < minimumIdleMs
                ) {
                  tryCommit();
                  return;
                }
                resolve();
              },
              { timeout: 500 },
            );
            return;
          }
          window.setTimeout(() => {
            if (isPaintingRef.current) {
              tryCommit();
              return;
            }
            resolve();
          }, 0);
        };
        tryCommit();
      }),
    [],
  );

  const refreshMaskDisplay = useCallback(
    (layer: UvPaintLayer, dirtyRect?: PaintDirtyRect) => {
      if (!layer.maskSolidNormalized) {
        const logicalImage = layer.maskContext.getImageData(
          0,
          0,
          layer.maskCanvas.width,
          layer.maskCanvas.height,
        );
        const logicalData = logicalImage.data;
        let normalized = false;
        for (let index = 0; index < logicalData.length; index += 4) {
          if (logicalData[index + 3] === 0) continue;
          if (
            logicalData[index] !== 255 ||
            logicalData[index + 1] !== 255 ||
            logicalData[index + 2] !== 255 ||
            logicalData[index + 3] !== 255
          ) {
            logicalData[index] = 255;
            logicalData[index + 1] = 255;
            logicalData[index + 2] = 255;
            logicalData[index + 3] = 255;
            normalized = true;
          }
        }
        if (normalized) {
          layer.maskContext.putImageData(logicalImage, 0, 0);
          scheduleTextureUpdate(layer.maskTexture);
        }
        layer.maskSolidNormalized = true;
      }
      const rect = dirtyRect ?? {
        x: 0,
        y: 0,
        width: layer.maskDisplayCanvas.width,
        height: layer.maskDisplayCanvas.height,
      };
      layer.maskDisplayContext.save();
      layer.maskDisplayContext.clearRect(rect.x, rect.y, rect.width, rect.height);
      layer.maskDisplayContext.fillStyle = layer.maskPattern;
      layer.maskDisplayContext.fillRect(rect.x, rect.y, rect.width, rect.height);
      layer.maskDisplayContext.globalCompositeOperation = 'destination-in';
      layer.maskDisplayContext.drawImage(
        layer.maskCanvas,
        rect.x,
        rect.y,
        rect.width,
        rect.height,
        rect.x,
        rect.y,
        rect.width,
        rect.height,
      );
      layer.maskDisplayContext.restore();
      scheduleTextureUpdate(layer.maskDisplayTexture);
    },
    [scheduleTextureUpdate],
  );

  useEffect(
    () => () => {
      if (textureUpdateFrameRef.current !== undefined)
        window.cancelAnimationFrame(textureUpdateFrameRef.current);
      textureUpdateFrameRef.current = undefined;
      dirtyTexturesRef.current.clear();
    },
    [],
  );

  useEffect(() => {
    const source = localRepaintProjectionSource;
    if (!source) {
      localRepaintAllowedMaskRef.current = undefined;
      localRepaintSourceImageRef.current = undefined;
      localRepaintCompositeRef.current = undefined;
      return undefined;
    }
    let cancelled = false;
    void Promise.all([loadImageElement(source.allowedMaskUrl), loadImageElement(source.imageUrl)])
      .then(([allowedMaskImage, sourceImage]) => {
        if (cancelled) return;
        const maskCanvas = document.createElement('canvas');
        maskCanvas.width =
          sourceImage.naturalWidth ||
          sourceImage.width ||
          allowedMaskImage.naturalWidth ||
          allowedMaskImage.width;
        maskCanvas.height =
          sourceImage.naturalHeight ||
          sourceImage.height ||
          allowedMaskImage.naturalHeight ||
          allowedMaskImage.height;
        const maskContext = maskCanvas.getContext('2d', { willReadFrequently: true });
        if (!maskContext) return;
        maskContext.drawImage(allowedMaskImage, 0, 0, maskCanvas.width, maskCanvas.height);
        localRepaintAllowedMaskRef.current = {
          url: source.allowedMaskUrl,
          canvas: maskCanvas,
          context: maskContext,
          data: maskContext.getImageData(0, 0, maskCanvas.width, maskCanvas.height),
        };
        const sourceCanvas = document.createElement('canvas');
        sourceCanvas.width = maskCanvas.width;
        sourceCanvas.height = maskCanvas.height;
        const sourceContext = sourceCanvas.getContext('2d', { willReadFrequently: true });
        sourceContext?.drawImage(sourceImage, 0, 0, sourceCanvas.width, sourceCanvas.height);
        localRepaintSourceImageRef.current = {
          url: source.imageUrl,
          image: sourceImage,
          data: sourceContext?.getImageData(0, 0, sourceCanvas.width, sourceCanvas.height),
        };
        localRepaintCompositeRef.current = undefined;
      })
      .catch((error) => {
        console.warn(
          '[Liclick 3D Texture] Could not prepare local repaint projection source:',
          error,
        );
        localRepaintAllowedMaskRef.current = undefined;
        localRepaintSourceImageRef.current = undefined;
        localRepaintCompositeRef.current = undefined;
      });
    return () => {
      cancelled = true;
    };
  }, [localRepaintProjectionSource]);

  useEffect(() => {
    const layer = layerRef.current;
    if (!layer) return;
    layer.maskContext.clearRect(0, 0, layer.maskCanvas.width, layer.maskCanvas.height);
    layer.projectionContext.clearRect(
      0,
      0,
      layer.projectionCanvas.width,
      layer.projectionCanvas.height,
    );
    layer.maskSolidNormalized = true;
    scheduleTextureUpdate(layer.maskTexture);
    refreshMaskDisplay(layer);
    maskDirtyRef.current = false;
    maskHasContentRef.current = false;
  }, [paintMaskResetRevision, refreshMaskDisplay, scheduleTextureUpdate]);

  useEffect(() => {
    const layer = layerRef.current;
    if (!layer) return;
    layer.overlayMeshes.forEach((mesh) => {
      if (mesh.userData.liclickInpaintMaskOverlay) mesh.visible = isInpaintMode;
    });
  }, [isInpaintMode, paintTool]);

  const getBrushWorldRadius = useCallback(
    (model: SurfacePaintTarget) => {
      const maxDimension = Math.max(
        model.boundingSize.x,
        model.boundingSize.y,
        model.boundingSize.z,
        1,
      );
      const setting =
        paintTool === 'brush'
          ? paintToolSettings.brushSize
          : paintTool === 'eraser'
            ? paintToolSettings.eraserSize
            : paintMaskSettings.brushSize;
      const isMaskBrush =
        paintTool === 'inpaint-add' ||
        paintTool === 'inpaint-subtract' ||
        paintTool === 'inpaint-apply';
      const worldScale = isMaskBrush ? INPAINT_BRUSH_WORLD_SCALE : 0.45;
      const minRadius = isMaskBrush ? maxDimension * 0.001 : maxDimension * 0.004;
      const maxRadius = isMaskBrush ? maxDimension * 0.12 : maxDimension * 0.18;
      return THREE.MathUtils.clamp(
        (maxDimension * setting * worldScale) / 700,
        minRadius,
        maxRadius,
      );
    },
    [
      paintMaskSettings.brushSize,
      paintTool,
      paintToolSettings.brushSize,
      paintToolSettings.eraserSize,
    ],
  );

  const getBrushTextureRadius = useCallback(() => {
    const setting =
      paintTool === 'brush'
        ? paintToolSettings.brushSize
        : paintTool === 'eraser'
          ? paintToolSettings.eraserSize
          : paintMaskSettings.brushSize;
    const isMaskBrush =
      paintTool === 'inpaint-add' ||
      paintTool === 'inpaint-subtract' ||
      paintTool === 'inpaint-apply';
    return isMaskBrush
      ? THREE.MathUtils.clamp(setting * INPAINT_BRUSH_TEXTURE_SCALE, 1, 72)
      : THREE.MathUtils.clamp(setting * 0.45, 1.5, 96);
  }, [
    paintMaskSettings.brushSize,
    paintTool,
    paintToolSettings.brushSize,
    paintToolSettings.eraserSize,
  ]);

  const raycastModel = useCallback(
    (event: globalThis.PointerEvent): UvPaintHit | undefined => {
      const model = getTargetModel();
      if (!model) return undefined;
      const rect = gl.domElement.getBoundingClientRect();
      const screenUv = new THREE.Vector2(
        THREE.MathUtils.clamp((event.clientX - rect.left) / Math.max(rect.width, 1), 0, 1),
        THREE.MathUtils.clamp((event.clientY - rect.top) / Math.max(rect.height, 1), 0, 1),
      );
      pointerRef.current.set(screenUv.x * 2 - 1, -(screenUv.y * 2 - 1));
      raycasterRef.current.setFromCamera(pointerRef.current, camera);
      const hit = raycasterRef.current.intersectObjects(getPaintableMeshes(model), false)[0];
      if (!hit || !(hit.object instanceof THREE.Mesh) || !hit.face || !hit.uv) return undefined;
      return {
        model,
        hit,
        uv: hit.uv.clone(),
        screenUv,
        worldRadius: getBrushWorldRadius(model),
        textureRadius: getBrushTextureRadius(),
      };
    },
    [
      camera,
      getBrushTextureRadius,
      getBrushWorldRadius,
      getPaintableMeshes,
      getTargetModel,
      gl.domElement,
    ],
  );

  const warnMissingPaintLayer = useCallback(() => {
    showPanel('layers');
    setPanelCollapsed('layers', false);
    pushToast({
      tone: 'warning',
      title: t('paintLayerMissing'),
      description: t('paintLayerMissingHelp'),
      dedupeKey: 'paint-layer-missing',
    });
  }, [pushToast, setPanelCollapsed, showPanel, t]);

  const getCursorColor = useCallback(() => {
    if (paintTool === 'eraser') return '#ffffff';
    if (isInpaintMode || isLocalRepaintApplyMode) return '#ff8a68';
    return paintToolSettings.color;
  }, [isInpaintMode, isLocalRepaintApplyMode, paintTool, paintToolSettings.color]);

  const updateCursorFromHit = useCallback(
    (result: UvPaintHit | undefined) => {
      const cursor = cursorRef.current;
      if (!cursor) return result;
      if (!result) {
        cursor.visible = false;
        gl.domElement.style.cursor = enabled ? 'default' : '';
        return undefined;
      }
      const worldNormal = cursorWorldNormalRef.current;
      if (result.hit.face?.normal) {
        worldNormal.copy(result.hit.face.normal);
      } else {
        worldNormal.set(0, 1, 0);
      }
      const normalMatrix = cursorNormalMatrixRef.current.getNormalMatrix(
        result.hit.object.matrixWorld,
      );
      worldNormal.applyMatrix3(normalMatrix).normalize();
      const localPoint = result.model.group.worldToLocal(
        cursorLocalPointRef.current
          .copy(result.hit.point)
          .addScaledVector(worldNormal, result.worldRadius * 0.025),
      );
      const localHitPoint = result.model.group.worldToLocal(
        cursorLocalHitPointRef.current.copy(result.hit.point),
      );
      const normalEnd = result.model.group.worldToLocal(
        cursorNormalEndRef.current.copy(result.hit.point).add(worldNormal),
      );
      const localNormal = cursorLocalNormalRef.current
        .copy(normalEnd)
        .sub(localHitPoint)
        .normalize();
      const worldScale = cursorWorldScaleRef.current;
      result.model.group.getWorldScale(worldScale);
      if (cursor.parent !== result.model.group) result.model.group.attach(cursor);
      cursor.position.copy(localPoint);
      cursor.quaternion.copy(
        cursorQuaternionRef.current.setFromUnitVectors(cursorZAxisRef.current, localNormal),
      );
      cursor.scale.setScalar(
        result.worldRadius / Math.max(worldScale.x, worldScale.y, worldScale.z, 0.0001),
      );
      if (cursor.material instanceof THREE.MeshBasicMaterial)
        cursor.material.color.set(getCursorColor());
      cursor.visible = true;
      gl.domElement.style.cursor = 'none';
      return result;
    },
    [enabled, getCursorColor, gl.domElement],
  );

  const updateCursor = useCallback(
    (event: globalThis.PointerEvent) => {
      const canPreviewBrush =
        enabled && (isInpaintMode || isLocalRepaintApplyMode || canUseSurfacePaint);
      return updateCursorFromHit(canPreviewBrush ? raycastModel(event) : undefined);
    },
    [
      canUseSurfacePaint,
      enabled,
      isInpaintMode,
      isLocalRepaintApplyMode,
      raycastModel,
      updateCursorFromHit,
    ],
  );

  const drawBrushSegment = useCallback(
    (
      context: CanvasRenderingContext2D,
      texture: THREE.CanvasTexture,
      fromUv: THREE.Vector2 | undefined,
      toUv: THREE.Vector2,
      radius: number,
      color: string | CanvasPattern,
      compositeOperation: GlobalCompositeOperation,
      hardness: number,
      updateTexture = true,
    ) => {
      const targetUvX = THREE.MathUtils.euclideanModulo(toUv.x, 1);
      const targetUvY = THREE.MathUtils.euclideanModulo(toUv.y, 1);
      const sourceUvX = fromUv ? THREE.MathUtils.euclideanModulo(fromUv.x, 1) : targetUvX;
      const sourceUvY = fromUv ? THREE.MathUtils.euclideanModulo(fromUv.y, 1) : targetUvY;
      const textureWidth = context.canvas.width;
      const textureHeight = context.canvas.height;
      const radiusScale = Math.max(textureWidth, textureHeight) / UV_PAINT_RESOLUTION;
      const scaledRadius = Math.max(1, radius * radiusScale);
      const toX = targetUvX * textureWidth;
      const toY = (1 - targetUvY) * textureHeight;
      const fromX = sourceUvX * textureWidth;
      const fromY = (1 - sourceUvY) * textureHeight;
      const bounds = createDirtyRect(
        fromX,
        fromY,
        toX,
        toY,
        scaledRadius,
        textureWidth,
        textureHeight,
      );
      const softness = 1 - THREE.MathUtils.clamp(hardness / 100, 0, 1);
      const innerRadius = Math.max(1, scaledRadius * (1 - softness * 0.55));

      context.save();
      context.globalCompositeOperation = compositeOperation;
      context.lineCap = 'round';
      context.lineJoin = 'round';
      if (softness > 0.02) {
        context.globalAlpha = Math.max(0.18, 1 - softness * 0.68);
        context.strokeStyle = color;
        context.lineWidth = scaledRadius * 2;
        context.beginPath();
        context.moveTo(fromX, fromY);
        context.lineTo(toX, toY);
        context.stroke();
      }
      context.globalAlpha = 1;
      context.strokeStyle = color;
      context.lineWidth = innerRadius * 2;
      context.beginPath();
      context.moveTo(fromX, fromY);
      context.lineTo(toX, toY);
      context.stroke();
      context.restore();
      if (updateTexture) scheduleTextureUpdate(texture);
      return bounds;
    },
    [scheduleTextureUpdate],
  );

  const drawProjectionBrushSegment = useCallback(
    (
      context: CanvasRenderingContext2D,
      fromScreenUv: THREE.Vector2 | undefined,
      toScreenUv: THREE.Vector2,
      radius: number,
      color: string,
      hardness: number,
      compositeOperation: GlobalCompositeOperation = 'source-over',
    ) => {
      const textureWidth = context.canvas.width;
      const textureHeight = context.canvas.height;
      const radiusScale = Math.max(textureWidth, textureHeight) / UV_PAINT_RESOLUTION;
      const scaledRadius = Math.max(1, radius * radiusScale);
      const toX = THREE.MathUtils.clamp(toScreenUv.x, 0, 1) * textureWidth;
      const toY = THREE.MathUtils.clamp(toScreenUv.y, 0, 1) * textureHeight;
      const fromX = fromScreenUv ? THREE.MathUtils.clamp(fromScreenUv.x, 0, 1) * textureWidth : toX;
      const fromY = fromScreenUv
        ? THREE.MathUtils.clamp(fromScreenUv.y, 0, 1) * textureHeight
        : toY;
      const bounds = createDirtyRect(
        fromX,
        fromY,
        toX,
        toY,
        scaledRadius,
        textureWidth,
        textureHeight,
      );
      const softness = 1 - THREE.MathUtils.clamp(hardness / 100, 0, 1);
      const innerRadius = Math.max(1, scaledRadius * (1 - softness * 0.55));

      context.save();
      context.globalCompositeOperation = compositeOperation;
      context.lineCap = 'round';
      context.lineJoin = 'round';
      if (softness > 0.02) {
        context.globalAlpha = Math.max(0.18, 1 - softness * 0.68);
        context.strokeStyle = color;
        context.lineWidth = scaledRadius * 2;
        context.beginPath();
        context.moveTo(fromX, fromY);
        context.lineTo(toX, toY);
        context.stroke();
      }
      context.globalAlpha = 1;
      context.strokeStyle = color;
      context.lineWidth = innerRadius * 2;
      context.beginPath();
      context.moveTo(fromX, fromY);
      context.lineTo(toX, toY);
      context.stroke();
      context.restore();
      return bounds;
    },
    [],
  );

  const getStrokeSourceUv = useCallback(
    (result: UvPaintHit) => {
      const previous = lastSampleRef.current;
      if (!previous || !(result.hit.object instanceof THREE.Mesh)) return undefined;
      const sameMesh = previous.meshUuid === result.hit.object.uuid;

      const targetUvX = THREE.MathUtils.euclideanModulo(result.uv.x, 1);
      const targetUvY = THREE.MathUtils.euclideanModulo(result.uv.y, 1);
      const sourceUvX = THREE.MathUtils.euclideanModulo(previous.uv.x, 1);
      const sourceUvY = THREE.MathUtils.euclideanModulo(previous.uv.y, 1);
      const deltaX = Math.min(Math.abs(targetUvX - sourceUvX), 1 - Math.abs(targetUvX - sourceUvX));
      const deltaY = Math.min(Math.abs(targetUvY - sourceUvY), 1 - Math.abs(targetUvY - sourceUvY));
      const textureDistance = Math.hypot(deltaX, deltaY) * UV_PAINT_RESOLUTION;
      const directTextureDistance = previous.uv.distanceTo(result.uv) * UV_PAINT_RESOLUTION;
      const screenDistance = previous.screenUv.distanceTo(result.screenUv);
      const worldDistance = previous.point.distanceTo(result.hit.point);
      const isMaskBrush =
        paintTool === 'inpaint-add' ||
        paintTool === 'inpaint-subtract' ||
        paintTool === 'inpaint-apply';
      const maxTextureDistance = isMaskBrush
        ? THREE.MathUtils.clamp(result.textureRadius * 4, 8, 120)
        : THREE.MathUtils.clamp(result.textureRadius * 5, 16, 180);
      const maxWorldDistance = result.worldRadius * (isMaskBrush ? 5 : 7);
      const sameFace =
        sameMesh && previous.faceIndex !== undefined && previous.faceIndex === result.hit.faceIndex;
      if (sameFace) return previous.uv;
      // Pointer events can be very sparse under load (or with a fast stylus). Adjacent
      // triangles on the same mesh still belong to one visual stroke, so bridge a large
      // event gap when the screen and unwrapped UV positions remain continuous. The raw
      // UV guard prevents drawing a line across a 0/1 UV seam.
      if (
        screenDistance <= 0.65 &&
        directTextureDistance <= UV_PAINT_RESOLUTION * 0.65 &&
        worldDistance <= maxWorldDistance
      ) {
        return previous.uv;
      }
      if (worldDistance > maxWorldDistance) return undefined;
      if (textureDistance > maxTextureDistance) return undefined;
      return previous.uv;
    },
    [paintTool],
  );

  const ensureLiveLocalRepaintComposite = useCallback(
    (model: SurfacePaintTarget) => {
      const localRepaintSource = localRepaintProjectionSource;
      const sourceImage = localRepaintSourceImageRef.current?.image;
      if (!localRepaintSource || !sourceImage) return undefined;
      const width = sourceImage.naturalWidth || sourceImage.width;
      const height = sourceImage.naturalHeight || sourceImage.height;
      if (width <= 0 || height <= 0) return undefined;

      model.group.updateMatrixWorld(true);
      const sourceKey = createLocalRepaintSourceKey(localRepaintSource, model.objectId);
      const currentLayers = useLayerStore.getState().layers;
      const existingLayer = currentLayers.find((item) =>
        isMatchingLocalRepaintProjectionLayer(item, localRepaintSource, model.objectId),
      );
      const layerId = existingLayer?.id ?? createId(LOCAL_REPAINT_PROJECTION_LAYER_ID_PREFIX);
      let composite = localRepaintCompositeRef.current;
      if (
        !composite ||
        composite.sourceKey !== sourceKey ||
        composite.layerId !== layerId ||
        composite.maskCanvas.width !== width ||
        composite.maskCanvas.height !== height
      ) {
        composite = createLocalRepaintComposite(sourceKey, layerId, width, height);
        localRepaintCompositeRef.current = composite;
      }
      if (!composite) return undefined;
      if (localRepaintSource.targetLayerType === 'uv') return composite;

      const projectedLayer: Layer = {
        ...existingLayer,
        id: layerId,
        name: localRepaintSource.targetLayerName
          ? `${localRepaintSource.targetLayerName} · 局部替换`
          : (localRepaintSource.name ?? 'Local repaint brush'),
        type: 'projected',
        imageUrl: localRepaintSource.imageUrl,
        maskUrl: composite.maskUrl,
        depthUrl: localRepaintSource.depthUrl,
        objectId: localRepaintSource.objectId ?? model.objectId,
        objectMatrixWorld:
          localRepaintSource.objectMatrixWorld ?? model.group.matrixWorld.toArray(),
        camera: localRepaintSource.camera,
        generationId: localRepaintSource.generationId,
        captureId: localRepaintSource.captureId,
        replacementTargetLayerId: localRepaintSource.targetLayerId,
        visible: true,
        opacity: 1,
        strength: 1,
        blendMode: 'normal',
        adjustments: { hue: 0, saturation: 0, lightness: 0 },
        order: 0,
        createdAt: existingLayer?.createdAt ?? new Date().toISOString(),
      };
      if (
        !existingLayer ||
        existingLayer.imageUrl !== projectedLayer.imageUrl ||
        existingLayer.maskUrl !== projectedLayer.maskUrl ||
        existingLayer.camera !== projectedLayer.camera ||
        existingLayer.objectId !== projectedLayer.objectId
      ) {
        useEditorHistoryStore.getState().capture('局部重绘笔刷');
        const nextLayers = currentLayers.filter(
          (item) =>
            item.id !== projectedLayer.id &&
            !isMatchingLocalRepaintProjectionLayer(item, localRepaintSource, model.objectId),
        );
        const targetIndex = nextLayers.findIndex(
          (item) => item.id === localRepaintSource.targetLayerId,
        );
        nextLayers.splice(targetIndex >= 0 ? targetIndex : 0, 0, projectedLayer);
        setLayers(nextLayers);
        useLayerStore.getState().setActiveLayer(projectedLayer.id);
      }
      return composite;
    },
    [localRepaintProjectionSource, setLayers],
  );

  const isInsideLocalRepaintAllowedMask = useCallback((screenUv: THREE.Vector2) => {
    const allowedMask = localRepaintAllowedMaskRef.current?.data;
    if (!allowedMask) return false;
    const x = THREE.MathUtils.clamp(
      Math.floor(screenUv.x * allowedMask.width),
      0,
      allowedMask.width - 1,
    );
    const y = THREE.MathUtils.clamp(
      Math.floor(screenUv.y * allowedMask.height),
      0,
      allowedMask.height - 1,
    );
    const offset = (y * allowedMask.width + x) * 4;
    const value = Math.max(
      allowedMask.data[offset],
      allowedMask.data[offset + 1],
      allowedMask.data[offset + 2],
    );
    return value > 24;
  }, []);

  const hasLocalRepaintSourceContent = useCallback((screenUv: THREE.Vector2) => {
    const sourceData = localRepaintSourceImageRef.current?.data;
    if (!sourceData) return true;
    const x = THREE.MathUtils.clamp(
      Math.floor(screenUv.x * sourceData.width),
      0,
      sourceData.width - 1,
    );
    const y = THREE.MathUtils.clamp(
      Math.floor(screenUv.y * sourceData.height),
      0,
      sourceData.height - 1,
    );
    return sourceData.data[(y * sourceData.width + x) * 4 + 3] > 8;
  }, []);

  const paintAt = useCallback(
    (result: UvPaintHit) => {
      const layer = getUvPaintLayer(result.model);
      if ((isInpaintMode || isLocalRepaintApplyMode) && result.hit.object instanceof THREE.Mesh) {
        ensureOverlayForMesh(layer, result.hit.object);
      }
      const previousSample = lastSampleRef.current;
      const fromUv = getStrokeSourceUv(result);
      if (!fromUv && previousSample && strokeTelemetryRef.current) {
        strokeTelemetryRef.current.continuityBreaks += 1;
      }
      const fromScreenUv = fromUv ? lastSampleRef.current?.screenUv : undefined;
      if (isInpaintMode) {
        layer.overlayMeshes.forEach((mesh) => {
          if (mesh.userData.liclickInpaintMaskOverlay) mesh.visible = true;
        });
      }

      if (paintTool === 'brush') {
        if (result.hit.object instanceof THREE.Mesh)
          ensurePaintPreviewOverlayForMesh(layer, result.hit.object);
        const bounds = drawBrushSegment(
          layer.paintPreviewContext,
          layer.paintPreviewTexture,
          fromUv,
          result.uv,
          result.textureRadius,
          paintToolSettings.color,
          'source-over',
          paintToolSettings.brushHardness,
        );
        if (strokeDraftRef.current?.target === 'paint') {
          strokeDraftRef.current.bounds = unionDirtyRect(strokeDraftRef.current.bounds, bounds);
        }
      } else if (paintTool === 'eraser') {
        const bounds = drawBrushSegment(
          layer.paintPreviewContext,
          layer.paintPreviewTexture,
          fromUv,
          result.uv,
          result.textureRadius,
          '#ffffff',
          'source-over',
          paintToolSettings.eraserHardness,
          false,
        );
        if (strokeDraftRef.current?.target === 'paint') {
          strokeDraftRef.current.bounds = unionDirtyRect(strokeDraftRef.current.bounds, bounds);
        }
      } else if (paintTool === 'inpaint-add') {
        const bounds = drawBrushSegment(
          layer.maskContext,
          layer.maskTexture,
          fromUv,
          result.uv,
          result.textureRadius,
          '#ffffff',
          'source-over',
          paintMaskSettings.brushHardness,
        );
        const projectionBounds = drawProjectionBrushSegment(
          layer.projectionContext,
          fromScreenUv,
          result.screenUv,
          result.textureRadius,
          '#ffffff',
          paintMaskSettings.brushHardness,
        );
        if (strokeDraftRef.current?.target === 'mask') {
          strokeDraftRef.current.bounds = unionDirtyRect(strokeDraftRef.current.bounds, bounds);
          strokeDraftRef.current.bounds = unionDirtyRect(
            strokeDraftRef.current.bounds,
            projectionBounds,
          );
        }
        maskDirtyRef.current = true;
        maskHasContentRef.current = true;
        refreshMaskDisplay(layer, bounds);
      } else if (paintTool === 'inpaint-subtract') {
        const bounds = drawBrushSegment(
          layer.maskContext,
          layer.maskTexture,
          fromUv,
          result.uv,
          result.textureRadius,
          '#000000',
          'destination-out',
          paintMaskSettings.brushHardness,
        );
        const projectionBounds = drawProjectionBrushSegment(
          layer.projectionContext,
          fromScreenUv,
          result.screenUv,
          result.textureRadius,
          '#ffffff',
          paintMaskSettings.brushHardness,
          'destination-out',
        );
        if (strokeDraftRef.current?.target === 'mask') {
          strokeDraftRef.current.bounds = unionDirtyRect(strokeDraftRef.current.bounds, bounds);
          strokeDraftRef.current.bounds = unionDirtyRect(
            strokeDraftRef.current.bounds,
            projectionBounds,
          );
        }
        maskDirtyRef.current = true;
        refreshMaskDisplay(layer, bounds);
      } else if (paintTool === 'inpaint-apply') {
        const allowedMask = localRepaintAllowedMaskRef.current;
        if (
          !localRepaintProjectionSource ||
          !localRepaintSourceImageRef.current ||
          !allowedMask ||
          !isInsideLocalRepaintAllowedMask(result.screenUv) ||
          !hasLocalRepaintSourceContent(result.screenUv)
        ) {
          lastUvRef.current = undefined;
          lastSampleRef.current = undefined;
          return;
        }
        const projectionBounds = drawProjectionBrushSegment(
          layer.projectionContext,
          fromScreenUv,
          result.screenUv,
          result.textureRadius,
          '#ffffff',
          paintMaskSettings.brushHardness,
        );
        const remainingMaskBounds = drawBrushSegment(
          layer.maskContext,
          layer.maskTexture,
          fromUv,
          result.uv,
          result.textureRadius,
          '#000000',
          'destination-out',
          paintMaskSettings.brushHardness,
        );
        if (strokeDraftRef.current?.target === 'apply-local-repaint') {
          strokeDraftRef.current.bounds = unionDirtyRect(
            strokeDraftRef.current.bounds,
            projectionBounds,
          );
        }
        maskDirtyRef.current = true;
        refreshMaskDisplay(layer, remainingMaskBounds);
      }

      lastUvRef.current = result.uv.clone();
      lastSampleRef.current =
        result.hit.object instanceof THREE.Mesh
          ? {
              meshUuid: result.hit.object.uuid,
              faceIndex: result.hit.faceIndex ?? undefined,
              uv: result.uv.clone(),
              screenUv: result.screenUv.clone(),
              point: result.hit.point.clone(),
            }
          : undefined;
    },
    [
      drawBrushSegment,
      drawProjectionBrushSegment,
      ensureOverlayForMesh,
      ensurePaintPreviewOverlayForMesh,
      getStrokeSourceUv,
      getUvPaintLayer,
      hasLocalRepaintSourceContent,
      isInsideLocalRepaintAllowedMask,
      isInpaintMode,
      isLocalRepaintApplyMode,
      localRepaintProjectionSource,
      paintMaskSettings.brushHardness,
      paintTool,
      paintToolSettings.brushHardness,
      paintToolSettings.color,
      paintToolSettings.eraserHardness,
      refreshMaskDisplay,
    ],
  );

  const commitMaskIfDirty = useCallback(() => {
    if (!maskDirtyRef.current) return;
    const layer = layerRef.current;
    maskDirtyRef.current = false;
    // Applying a generated repaint must not rewrite and re-encode the original
    // selection mask after every stroke. That full-canvas readback was the main
    // source of the button-3 input lag.
    if (isLocalRepaintApplyMode) return;
    setPaintMaskDataUrl(
      layer && maskHasContentRef.current
        ? projectionMaskToDataUrl(layer.projectionCanvas)
        : undefined,
      maskHasContentRef.current,
    );
  }, [isLocalRepaintApplyMode, setPaintMaskDataUrl]);

  const beginStrokeHistory = useCallback(
    (result: UvPaintHit) => {
      const layer = getUvPaintLayer(result.model);
      const target = isInpaintMode
        ? 'mask'
        : isLocalRepaintApplyMode
          ? 'apply-local-repaint'
          : 'paint';
      if (target === 'paint') {
        layer.paintPreviewContext.clearRect(
          0,
          0,
          layer.paintPreviewCanvas.width,
          layer.paintPreviewCanvas.height,
        );
        scheduleTextureUpdate(layer.paintPreviewTexture);
        layer.paintPreviewOverlays.forEach((overlay) => {
          overlay.visible = true;
        });
      } else if (target === 'apply-local-repaint') {
        const sourceImage = localRepaintSourceImageRef.current?.image;
        if (sourceImage) {
          resizeProjectionCanvasToSize(
            layer,
            sourceImage.naturalWidth || sourceImage.width,
            sourceImage.naturalHeight || sourceImage.height,
          );
        } else {
          const rect = gl.domElement.getBoundingClientRect();
          resizeProjectionCanvas(layer, rect.width / Math.max(rect.height, 1));
        }
        layer.projectionContext.clearRect(
          0,
          0,
          layer.projectionCanvas.width,
          layer.projectionCanvas.height,
        );
        if (localRepaintProjectionSource?.targetLayerType === 'uv') {
          const composite = localRepaintCompositeRef.current;
          composite?.maskContext.clearRect(
            0,
            0,
            composite.maskCanvas.width,
            composite.maskCanvas.height,
          );
          if (composite) markLiveProjectedCanvasTextureUpdated(composite.maskUrl);
        }
      } else if (!maskHasContentRef.current) {
        const rect = gl.domElement.getBoundingClientRect();
        resizeProjectionCanvas(layer, rect.width / Math.max(rect.height, 1));
      }
      strokeDraftRef.current = {
        layer,
        target,
        paintOperation:
          target === 'paint' && paintTool === 'eraser'
            ? 'eraser'
            : target === 'paint'
              ? 'brush'
              : undefined,
      };
    },
    [
      getUvPaintLayer,
      gl.domElement,
      isInpaintMode,
      isLocalRepaintApplyMode,
      localRepaintProjectionSource?.targetLayerType,
      paintTool,
      scheduleTextureUpdate,
    ],
  );

  const commitPaintStroke = useCallback(() => {
    const draft = strokeDraftRef.current;
    const layer = draft?.layer;
    const localRepaintSource = localRepaintProjectionSource;
    if (!layer || !draft?.bounds) return;

    if (draft.target === 'paint') {
      // The live stroke owns a small screen-responsive canvas, exactly like local
      // repaint. Detach it now so another stroke can start while the source UV
      // image is still decoding in the background.
      const strokeCanvas = copyCanvasRect(layer.paintPreviewCanvas, {
        x: 0,
        y: 0,
        width: layer.paintPreviewCanvas.width,
        height: layer.paintPreviewCanvas.height,
      });
      layer.paintPreviewContext.clearRect(
        0,
        0,
        layer.paintPreviewCanvas.width,
        layer.paintPreviewCanvas.height,
      );
      scheduleTextureUpdate(layer.paintPreviewTexture);
      layer.paintPreviewOverlays.forEach((overlay) => {
        overlay.visible = false;
      });

      const finalizePaintStroke = () => {
        if (!layer.isReady) return;
        const commitStartedAt = performance.now();
        const backingWasInitialized = layer.paintBackingInitialized;
        ensurePaintBackingCanvasInitialized(layer);
        const backingInitMs = performance.now() - commitStartedAt;
        const currentLayer = useLayerStore
          .getState()
          .layers.find((item) => item.id === layer.layerId);
        if (!currentLayer) return;
        const touchedTiles = getPaintHistoryTileKeys(layer, draft.bounds!);
        const beforeTiles = [...touchedTiles]
          .map((key) => getPaintHistoryTileBounds(layer.paintCanvas, key))
          .filter((bounds): bounds is PaintDirtyRect => Boolean(bounds))
          .map((bounds) => ({ bounds, before: copyCanvasRect(layer.paintCanvas, bounds) }));

        layer.paintContext.save();
        layer.paintContext.globalCompositeOperation =
          draft.paintOperation === 'eraser' ? 'destination-out' : 'source-over';
        layer.paintContext.drawImage(
          strokeCanvas,
          0,
          0,
          strokeCanvas.width,
          strokeCanvas.height,
          0,
          0,
          layer.paintCanvas.width,
          layer.paintCanvas.height,
        );
        layer.paintContext.restore();

        const historyTiles = beforeTiles.map(({ bounds, before }) => ({
          bounds,
          before,
          after: copyCanvasRect(layer.paintCanvas, bounds),
        }));
        const applyTiles = (side: 'before' | 'after') => {
          historyTiles.forEach((tile) => {
            layer.paintContext.clearRect(
              tile.bounds.x,
              tile.bounds.y,
              tile.bounds.width,
              tile.bounds.height,
            );
            layer.paintContext.drawImage(tile[side], tile.bounds.x, tile.bounds.y);
          });
          markLiveProjectedCanvasTextureUpdated(layer.assetUrl);
          const latestLayer = useLayerStore
            .getState()
            .layers.find((item) => item.id === layer.layerId);
          if (!latestLayer) return;
          useLayerStore.getState().updateLayer(layer.layerId, {
            contentRevision: (latestLayer.contentRevision ?? 0) + 1,
            isBaked: false,
            needsRebake: layer.target === 'projected-mask',
          });
          useProjectStore.getState().setProjectLayers(useLayerStore.getState().layers);
        };
        markLiveProjectedCanvasTextureUpdated(layer.assetUrl);
        useLayerStore.getState().updateLayer(layer.layerId, {
          ...(layer.target === 'uv-image'
            ? { imageUrl: layer.assetUrl }
            : { maskUrl: layer.assetUrl, maskSpace: 'uv' as const }),
          contentRevision: (currentLayer.contentRevision ?? 0) + 1,
          isBaked: false,
          needsRebake: layer.target === 'projected-mask',
        });
        useProjectStore.getState().setProjectLayers(useLayerStore.getState().layers);
        if (historyTiles.length > 0) {
          useEditorHistoryStore.getState().captureRuntime({
            label:
              draft.paintOperation === 'brush'
                ? 'UV 画笔'
                : layer.target === 'projected-mask'
                  ? '投影图层蒙版擦除'
                  : 'UV 橡皮擦',
            undo: () => applyTiles('before'),
            redo: () => applyTiles('after'),
          });
        }
        if (useSettingsStore.getState().performanceTestModeEnabled) {
          console.info('[Liclick Paint Commit]', {
            tool: draft.paintOperation,
            target: layer.target,
            resolution: `${layer.paintCanvas.width}x${layer.paintCanvas.height}`,
            idleBeforeCommitMs: Math.max(0, commitStartedAt - lastPaintActivityAtRef.current),
            backingInitializedThisCommit: !backingWasInitialized,
            backingInitMs,
            historyTiles: historyTiles.length,
            totalMs: performance.now() - commitStartedAt,
          });
        }
      };

      const queuedCommit = layer.paintCommitChain
        .then(() => layer.ready)
        .then(waitForPaintCommitIdle)
        .then(finalizePaintStroke);
      layer.paintCommitChain = queuedCommit.catch((error) => {
        console.warn('[Liclick 3D Texture] Could not commit UV paint stroke:', error);
      });
      return;
    }

    if (draft.target === 'apply-local-repaint' && localRepaintSource) {
      const model = getTargetModel();
      const allowedMask = localRepaintAllowedMaskRef.current;
      const sourceImage = localRepaintSourceImageRef.current?.image;
      if (!model || !allowedMask || !sourceImage) return;
      model.group.updateMatrixWorld(true);
      const composite = ensureLiveLocalRepaintComposite(model);
      if (!composite) return;

      // The pointer path only paints a lightweight stroke canvas. Intersect it
      // with the original selection and generated cutout once, after pointer-up.
      drawLocalRepaintStrokeMaskPatch(
        composite,
        sourceImage,
        allowedMask,
        layer.projectionCanvas,
        draft.bounds,
      );
      layer.projectionContext.clearRect(
        0,
        0,
        layer.projectionCanvas.width,
        layer.projectionCanvas.height,
      );

      if (localRepaintSource.targetLayerType === 'uv' && localRepaintSource.targetLayerId) {
        const maskSnapshot = copyCanvasRect(composite.maskCanvas, {
          x: 0,
          y: 0,
          width: composite.maskCanvas.width,
          height: composite.maskCanvas.height,
        });
        const maskAssetUrl = registerLiveProjectedCanvasTexture(
          createId('local-repaint-uv-mask'),
          maskSnapshot,
          THREE.NoColorSpace,
        );
        const targetLayerId = localRepaintSource.targetLayerId;
        const transientLayer: Layer = {
          id: createId('local-repaint-uv-patch'),
          name: `${localRepaintSource.targetLayerName ?? 'UV 图层'} · 局部替换`,
          type: 'projected',
          imageUrl: localRepaintSource.imageUrl,
          maskUrl: maskAssetUrl,
          depthUrl: localRepaintSource.depthUrl,
          objectId: localRepaintSource.objectId ?? model.objectId,
          objectMatrixWorld:
            localRepaintSource.objectMatrixWorld ?? model.group.matrixWorld.toArray(),
          camera: localRepaintSource.camera,
          generationId: localRepaintSource.generationId,
          captureId: localRepaintSource.captureId,
          replacementTargetLayerId: targetLayerId,
          visible: true,
          opacity: 1,
          strength: 1,
          blendMode: 'normal',
          adjustments: { hue: 0, saturation: 0, lightness: 0 },
          order: 0,
          createdAt: new Date().toISOString(),
        };

        const commitUvReplacement = async () => {
          const currentLayer = useLayerStore
            .getState()
            .layers.find((item) => item.id === targetLayerId);
          if (!currentLayer || currentLayer.type !== 'uv') {
            throw new Error('目标 UV 图层已不存在，请重新选择图层。');
          }
          const existingLiveCanvas = getLiveProjectedCanvasState(currentLayer.imageUrl)?.canvas;
          const baseImage =
            !existingLiveCanvas && currentLayer.imageUrl
              ? await loadImageElement(currentLayer.imageUrl)
              : undefined;
          const fallbackResolution = UV_TEXTURE_RESOLUTION[useSettingsStore.getState().resolution];
          const width =
            existingLiveCanvas?.width ||
            baseImage?.naturalWidth ||
            baseImage?.width ||
            fallbackResolution;
          const height =
            existingLiveCanvas?.height ||
            baseImage?.naturalHeight ||
            baseImage?.height ||
            fallbackResolution;
          const largestDimension = Math.max(width, height);
          const bakeResolution =
            largestDimension <= 512 ? 512 : largestDimension <= 1024 ? 1024 : 2048;
          const { bakeVisibleProjectedLayersToTexture } =
            await import('@/engine/bake/bakeProjectedLayerToTexture');
          const bakeResult = await bakeVisibleProjectedLayersToTexture({
            objectId: model.objectId,
            transientLayers: [transientLayer],
            resolution: bakeResolution,
            enableBackfaceCulling: true,
            enableDilation: true,
            dilationPixels: 2,
            outputAlpha: 'transparent',
            commitToProject: false,
            markSourceLayersBaked: false,
            preferBlobOutput: false,
          });
          const nextCanvas = document.createElement('canvas');
          nextCanvas.width = width;
          nextCanvas.height = height;
          const nextContext = nextCanvas.getContext('2d');
          if (!nextContext) throw new Error('无法创建 UV 局部替换画布。');
          if (existingLiveCanvas) {
            nextContext.drawImage(existingLiveCanvas, 0, 0, width, height);
          } else if (baseImage) {
            nextContext.drawImage(baseImage, 0, 0, width, height);
          }
          nextContext.drawImage(bakeResult.canvas, 0, 0, width, height);

          useEditorHistoryStore.getState().capture('局部重绘写入 UV 图层');
          const assetUrl = registerLiveProjectedCanvasTexture(
            createId(`surface-edit:local-repaint:${targetLayerId}`),
            nextCanvas,
            THREE.SRGBColorSpace,
            { flipY: true },
          );
          markLiveProjectedCanvasTextureUpdated(assetUrl);
          const latestLayer = useLayerStore
            .getState()
            .layers.find((item) => item.id === targetLayerId);
          if (!latestLayer) throw new Error('目标 UV 图层已不存在，请重新选择图层。');
          useLayerStore.getState().updateLayer(targetLayerId, {
            imageUrl: assetUrl,
            contentRevision: (latestLayer.contentRevision ?? 0) + 1,
            isBaked: false,
            needsRebake: false,
          });
          useProjectStore.getState().setProjectLayers(useLayerStore.getState().layers);
          pushToast({
            tone: 'success',
            title: '局部替换已写入 UV 图层',
            description: currentLayer.name,
            dedupeKey: `local-repaint-uv:${targetLayerId}`,
          });
        };
        const queuedCommit = localRepaintUvCommitChainRef.current
          .then(waitForPaintCommitIdle)
          .then(commitUvReplacement);
        localRepaintUvCommitChainRef.current = queuedCommit.catch((error) => {
          const message = error instanceof Error ? error.message : '写入 UV 图层失败。';
          console.warn('[Liclick 3D Texture] Could not commit local repaint to UV layer:', error);
          pushToast({
            tone: 'error',
            title: 'UV 局部替换失败',
            description: message,
            dedupeKey: `local-repaint-uv-error:${targetLayerId}`,
          });
        });
        return;
      }

      const commitRevision = localRepaintCommitRevisionRef.current + 1;
      localRepaintCommitRevisionRef.current = commitRevision;
      void canvasToPngDataUrl(composite.maskCanvas)
        .then((maskUrl) => {
          if (localRepaintCommitRevisionRef.current !== commitRevision) return;
          const currentLayers = useLayerStore.getState().layers;
          const existingLayer = currentLayers.find((item) =>
            isMatchingLocalRepaintProjectionLayer(item, localRepaintSource, model.objectId),
          );
          const projectedLayer: Layer = {
            ...existingLayer,
            id: existingLayer?.id ?? composite.layerId,
            name: localRepaintSource.targetLayerName
              ? `${localRepaintSource.targetLayerName} · 局部替换`
              : (localRepaintSource.name ?? 'Local repaint brush'),
            type: 'projected',
            imageUrl: localRepaintSource.imageUrl,
            maskUrl,
            objectId: localRepaintSource.objectId ?? model.objectId,
            objectMatrixWorld:
              localRepaintSource.objectMatrixWorld ?? model.group.matrixWorld.toArray(),
            camera: localRepaintSource.camera,
            depthUrl: localRepaintSource.depthUrl,
            generationId: localRepaintSource.generationId,
            captureId: localRepaintSource.captureId,
            replacementTargetLayerId: localRepaintSource.targetLayerId,
            visible: true,
            opacity: 1,
            strength: 1,
            blendMode: 'normal',
            adjustments: { hue: 0, saturation: 0, lightness: 0 },
            order: 0,
            createdAt: existingLayer?.createdAt ?? new Date().toISOString(),
          };
          const nextLayers = currentLayers.filter(
            (item) =>
              item.id !== projectedLayer.id &&
              !isMatchingLocalRepaintProjectionLayer(item, localRepaintSource, model.objectId),
          );
          const targetIndex = nextLayers.findIndex(
            (item) => item.id === localRepaintSource.targetLayerId,
          );
          nextLayers.splice(targetIndex >= 0 ? targetIndex : 0, 0, projectedLayer);
          setLayers(nextLayers);
          useLayerStore.getState().setActiveLayer(projectedLayer.id);
          useProjectStore.getState().setProjectLayers(useLayerStore.getState().layers);
        })
        .catch((error) => {
          console.warn(
            '[Liclick 3D Texture] Could not commit local repaint projection image:',
            error,
          );
        });
      return;
    }
  }, [
    ensureLiveLocalRepaintComposite,
    getTargetModel,
    localRepaintProjectionSource,
    pushToast,
    scheduleTextureUpdate,
    setLayers,
    waitForPaintCommitIdle,
  ]);

  const commitStrokeHistory = useCallback(() => {
    const draft = strokeDraftRef.current;
    strokeDraftRef.current = undefined;
    if (!draft?.bounds) return;
    if (draft.target === 'paint') return;
    if (draft.target === 'apply-local-repaint') return;

    const targetCanvas = draft.target === 'mask' ? draft.layer.maskCanvas : draft.layer.paintCanvas;
    const targetContext =
      draft.target === 'mask' ? draft.layer.maskContext : draft.layer.paintContext;
    const afterMaskHasContent =
      draft.target === 'mask'
        ? paintTool === 'inpaint-add'
          ? true
          : hasCanvasAlpha(targetCanvas, targetContext)
        : maskHasContentRef.current;

    if (draft.target === 'mask') {
      draft.layer.maskSolidNormalized = true;
      maskHasContentRef.current = afterMaskHasContent;
    }
  }, [paintTool]);

  useEffect(() => {
    const canvas = gl.domElement;
    const previousTouchAction = canvas.style.touchAction;
    if (enabled) canvas.style.touchAction = 'none';
    const cursorMesh = cursorRef.current;
    const paintClientPath = (targets: ClientPoint[], maxSamples = 256) => {
      const { samples, maxGapPx } = resampleClientPath(
        lastPointerClientRef.current,
        targets,
        maxSamples,
      );
      const telemetry = strokeTelemetryRef.current;
      if (telemetry) telemetry.maxPointerGapPx = Math.max(telemetry.maxPointerGapPx, maxGapPx);
      let latestResult: UvPaintHit | undefined;
      for (const point of samples) {
        if (telemetry) telemetry.raycasts += 1;
        const result = raycastModel({
          clientX: point.x,
          clientY: point.y,
        } as globalThis.PointerEvent);
        if (!result) {
          if (telemetry) telemetry.misses += 1;
          continue;
        }
        if (telemetry) telemetry.hits += 1;
        paintAt(result);
        latestResult = result;
      }
      const finalTarget = targets[targets.length - 1];
      if (finalTarget) lastPointerClientRef.current = finalTarget;
      return latestResult;
    };
    const finishStrokeTelemetry = (endReason: StrokeTelemetrySnapshot['endReason']) => {
      const telemetry = strokeTelemetryRef.current;
      if (!telemetry) return;
      const snapshot: StrokeTelemetrySnapshot = {
        endReason,
        durationMs: performance.now() - telemetry.startedAt,
        pointerEvents: telemetry.pointerEvents,
        coalescedEvents: telemetry.coalescedEvents,
        raycasts: telemetry.raycasts,
        hits: telemetry.hits,
        misses: telemetry.misses,
        continuityBreaks: telemetry.continuityBreaks,
        maxPointerGapPx: telemetry.maxPointerGapPx,
      };
      lastStrokeTelemetry = snapshot;
      strokeTelemetryRef.current = undefined;
      if (useSettingsStore.getState().performanceTestModeEnabled) {
        console.info('[Liclick Paint Stroke]', { tool: paintTool, ...snapshot });
      }
    };
    const handlePointerMove = (event: globalThis.PointerEvent) => {
      if (isPaintingRef.current) {
        const paintStartedAt = performance.now();
        lastPaintActivityAtRef.current = paintStartedAt;
        event.preventDefault();
        event.stopPropagation();
        const events = event.getCoalescedEvents?.() ?? [event];
        const targets = events.map((sampledEvent) => ({
          x: sampledEvent.clientX,
          y: sampledEvent.clientY,
        }));
        const finalTarget = targets[targets.length - 1];
        if (!finalTarget || finalTarget.x !== event.clientX || finalTarget.y !== event.clientY) {
          targets.push({ x: event.clientX, y: event.clientY });
        }
        const telemetry = strokeTelemetryRef.current;
        if (telemetry) {
          telemetry.pointerEvents += 1;
          telemetry.coalescedEvents += events.length;
        }
        const latestResult = paintClientPath(targets);
        if (latestResult) updateCursorFromHit(latestResult);
        recordSurfacePaintPerf(performance.now() - paintStartedAt);
        return;
      }
      updateCursor(event);
    };
    const handlePointerDown = (event: globalThis.PointerEvent) => {
      if (!enabled || event.button !== 0) return;
      if (!isInpaintMode && !canUseSurfacePaint) {
        const result = raycastModel(event);
        if (!result) return;
        event.preventDefault();
        event.stopPropagation();
        warnMissingPaintLayer();
        return;
      }
      const paintStartedAt = performance.now();
      lastPaintActivityAtRef.current = paintStartedAt;
      const result = updateCursor(event);
      if (!result) return;
      event.preventDefault();
      event.stopPropagation();
      isPaintingRef.current = true;
      activePointerIdRef.current = event.pointerId;
      canvas.setPointerCapture(event.pointerId);
      lastUvRef.current = undefined;
      lastSampleRef.current = undefined;
      lastPointerClientRef.current = { x: event.clientX, y: event.clientY };
      strokeTelemetryRef.current = {
        endReason: 'pointerup',
        startedAt: paintStartedAt,
        durationMs: 0,
        pointerEvents: 1,
        coalescedEvents: 1,
        raycasts: 1,
        hits: 1,
        misses: 0,
        continuityBreaks: 0,
        maxPointerGapPx: 0,
      };
      beginStrokeHistory(result);
      setOrbitControlsEnabled(false);
      paintAt(result);
      recordSurfacePaintPerf(performance.now() - paintStartedAt);
    };
    const handlePointerUp = (event: globalThis.PointerEvent) => {
      if (!isPaintingRef.current) return;
      const previousClient = lastPointerClientRef.current;
      if (previousClient) {
        const paintStartedAt = performance.now();
        const telemetry = strokeTelemetryRef.current;
        if (telemetry) {
          telemetry.pointerEvents += 1;
          telemetry.coalescedEvents += 1;
        }
        const latestResult = paintClientPath([{ x: event.clientX, y: event.clientY }], 128);
        if (latestResult) updateCursorFromHit(latestResult);
        recordSurfacePaintPerf(performance.now() - paintStartedAt);
      }
      isPaintingRef.current = false;
      lastPaintActivityAtRef.current = performance.now();
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
      activePointerIdRef.current = undefined;
      lastUvRef.current = undefined;
      lastSampleRef.current = undefined;
      lastPointerClientRef.current = undefined;
      setOrbitControlsEnabled(true);
      commitPaintStroke();
      commitStrokeHistory();
      commitMaskIfDirty();
      finishStrokeTelemetry(event.type === 'pointercancel' ? 'pointercancel' : 'pointerup');
    };
    const handlePointerLeave = () => {
      if (cursorMesh) cursorMesh.visible = false;
      if (!isPaintingRef.current) gl.domElement.style.cursor = '';
    };
    canvas.addEventListener('pointermove', handlePointerMove, true);
    canvas.addEventListener('pointerdown', handlePointerDown, true);
    window.addEventListener('pointerup', handlePointerUp, true);
    window.addEventListener('pointercancel', handlePointerUp, true);
    canvas.addEventListener('pointerleave', handlePointerLeave);
    return () => {
      canvas.removeEventListener('pointermove', handlePointerMove, true);
      canvas.removeEventListener('pointerdown', handlePointerDown, true);
      window.removeEventListener('pointerup', handlePointerUp, true);
      window.removeEventListener('pointercancel', handlePointerUp, true);
      canvas.removeEventListener('pointerleave', handlePointerLeave);
      canvas.style.touchAction = previousTouchAction;
      if (cursorMesh) cursorMesh.visible = false;
      if (isPaintingRef.current) {
        isPaintingRef.current = false;
        lastPaintActivityAtRef.current = performance.now();
        setOrbitControlsEnabled(true);
        commitPaintStroke();
        commitStrokeHistory();
        commitMaskIfDirty();
        finishStrokeTelemetry('effect-cleanup');
      }
      const activePointerId = activePointerIdRef.current;
      if (activePointerId !== undefined && canvas.hasPointerCapture(activePointerId)) {
        canvas.releasePointerCapture(activePointerId);
      }
      activePointerIdRef.current = undefined;
      gl.domElement.style.cursor = '';
    };
  }, [
    commitMaskIfDirty,
    beginStrokeHistory,
    commitPaintStroke,
    commitStrokeHistory,
    enabled,
    gl,
    isInpaintMode,
    isLocalRepaintApplyMode,
    paintAt,
    paintTool,
    raycastModel,
    setOrbitControlsEnabled,
    canUseSurfacePaint,
    updateCursor,
    updateCursorFromHit,
    warnMissingPaintLayer,
  ]);

  return (
    <mesh ref={cursorRef} visible={false} userData={{ liclickPaintOverlay: true }}>
      <ringGeometry args={[0.84, 1, 64]} />
      <meshBasicMaterial
        color="#ffffff"
        depthTest={false}
        depthWrite={false}
        transparent
        opacity={0.96}
        side={THREE.DoubleSide}
      />
    </mesh>
  );
}

export function ViewportCanvas({
  hasImportedModel,
  onImportModels,
  onImportReferenceImages,
  onOpenImport,
}: ViewportCanvasProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [captureFrameVisible, setCaptureFrameVisible] = useState(false);
  const [canvasKey, setCanvasKey] = useState(0);
  const [viewportIssue, setViewportIssue] = useState<string>();
  const recoveryAttemptsRef = useRef(0);
  const captureFrameTimerRef = useRef<number>();
  const activeDragType = useDragInteractionStore((state) => state.activeDragType);
  const startFileDrag = useDragInteractionStore((state) => state.startFileDrag);
  const clearDrag = useDragInteractionStore((state) => state.clearDrag);
  const workspaceMode = useWorkspaceLayoutStore((state) => state.mode);
  const exposure = useSettingsStore((state) => state.exposure);
  const performanceTestModeEnabled = useSettingsStore((state) => state.performanceTestModeEnabled);
  const t = useT();

  useEffect(() => () => window.clearTimeout(captureFrameTimerRef.current), []);

  function pulseCaptureFrame() {
    if (workspaceMode === 'scene') return;
    setCaptureFrameVisible(true);
    window.clearTimeout(captureFrameTimerRef.current);
    captureFrameTimerRef.current = window.setTimeout(() => {
      setCaptureFrameVisible(false);
    }, 1800);
  }

  function handlePointerMove(event: PointerEvent<HTMLDivElement>) {
    if (event.buttons === 0) return;
    pulseCaptureFrame();
  }

  function handleWheel(event: WheelEvent<HTMLDivElement>) {
    if (event.deltaX === 0 && event.deltaY === 0 && event.deltaZ === 0) return;
    pulseCaptureFrame();
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setIsDragging(false);
    if (activeDragType === 'panel') {
      clearDrag();
      return;
    }
    const payload = getDragPayload(event);
    if (payload.modelFiles.length > 0) {
      onImportModels(payload.modelFiles);
      clearDrag();
      return;
    }
    if (payload.imageFiles.length > 0) onImportReferenceImages(payload.imageFiles);
    clearDrag();
  }

  return (
    <div
      className="relative h-full w-full bg-[#080914]"
      onPointerDownCapture={pulseCaptureFrame}
      onPointerMoveCapture={handlePointerMove}
      onWheelCapture={handleWheel}
      onDragOver={(event) => {
        if (activeDragType === 'panel') return;
        event.preventDefault();
        const payload = getDragPayload(event);
        if (!payload.dragType) return;
        startFileDrag(payload.dragType);
        setIsDragging(true);
      }}
      onDragLeave={() => {
        setIsDragging(false);
        if (activeDragType !== 'panel') clearDrag();
      }}
      onDrop={handleDrop}
    >
      <Canvas
        key={canvasKey}
        dpr={[1, 1.5]}
        camera={{ position: [3.2, 2.4, 4], fov: 45, near: 0.1, far: 100 }}
        gl={{
          alpha: true,
          preserveDrawingBuffer: false,
          powerPreference: 'high-performance',
          outputColorSpace: THREE.SRGBColorSpace,
          toneMapping: THREE.LinearToneMapping,
          toneMappingExposure: exposure,
        }}
        onCreated={({ gl }) => {
          gl.outputColorSpace = THREE.SRGBColorSpace;
          gl.toneMapping = THREE.LinearToneMapping;
          gl.toneMappingExposure = exposure;
          setViewportIssue(undefined);
          recoveryAttemptsRef.current = 0;
          const canvas = gl.domElement;
          const handleContextLost = (event: Event) => {
            event.preventDefault();
            recoveryAttemptsRef.current += 1;
            if (recoveryAttemptsRef.current <= 2) {
              window.setTimeout(() => setCanvasKey((key) => key + 1), 250);
              return;
            }
            setViewportIssue(t('viewportContextLostHelp'));
          };
          const handleContextRestored = () => {
            setViewportIssue(undefined);
            setCanvasKey((key) => key + 1);
          };
          canvas.addEventListener('webglcontextlost', handleContextLost);
          canvas.addEventListener('webglcontextrestored', handleContextRestored);
        }}
        onError={(error) => {
          console.error('[Liclick 3D Texture] Viewport renderer failed:', error);
          setViewportIssue(error instanceof Error ? error.message : '视口渲染失败。');
        }}
      >
        <color attach="background" args={['#080914']} />
        <Suspense fallback={null}>
          <RendererSettings />
          <ViewportPerformanceProbe enabled={performanceTestModeEnabled} />
          <AcceleratedSceneRoot />
          <SurfacePaintOverlay />
        </Suspense>
        <CameraController />
      </Canvas>
      {performanceTestModeEnabled && <PerformanceTestHud />}
      <div
        className={`pointer-events-none absolute left-1/2 top-1/2 z-20 h-[82%] w-[72%] max-w-[1280px] -translate-x-1/2 -translate-y-1/2 rounded-[18px] border-[3px] border-dashed border-[#d9795c]/75 shadow-[0_0_0_1px_rgba(217,121,92,0.12)] transition-opacity duration-300 ${
          captureFrameVisible && workspaceMode !== 'scene' ? 'opacity-100' : 'opacity-0'
        }`}
        aria-hidden="true"
      />
      {viewportIssue && (
        <div className="absolute inset-0 z-30 grid place-items-center bg-[#080914]/86 px-5 text-white backdrop-blur-sm">
          <div className="grid max-w-[420px] gap-3 rounded-lg border border-white/14 bg-black/50 p-4 text-center shadow-2xl">
            <div className="text-sm font-semibold">{t('viewportNeedsRestore')}</div>
            <div className="text-xs leading-5 text-white/66">{viewportIssue}</div>
            <button
              type="button"
              className="mx-auto h-9 rounded-md bg-white px-4 text-xs font-semibold text-black transition hover:bg-white/90"
              onClick={() => {
                setViewportIssue(undefined);
                setCanvasKey((key) => key + 1);
              }}
            >
              {t('reloadViewport')}
            </button>
          </div>
        </div>
      )}
      <ViewCube />
      {!hasImportedModel && (
        <button
          type="button"
          onClick={onOpenImport}
          className="absolute bottom-4 left-4 rounded-md border border-white/10 bg-black/42 px-3 py-2 text-xs text-white/66 backdrop-blur transition hover:bg-white/10 hover:text-white"
        >
          {t('dropModelImport')}
        </button>
      )}
      {isDragging && activeDragType === 'model-file' && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center border-2 border-dashed border-liclick-pink bg-liclick-purple/18 text-lg font-semibold text-white backdrop-blur-sm">
          Drop models to import
        </div>
      )}
      {isDragging && activeDragType === 'asset-file' && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center border-2 border-dashed border-liclick-pink bg-liclick-purple/18 text-lg font-semibold text-white backdrop-blur-sm">
          Drop image to add reference
        </div>
      )}
    </div>
  );
}
