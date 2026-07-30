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
  type ReactNode,
  type WheelEvent,
} from 'react';
import * as THREE from 'three';
import { useDragInteractionStore } from '@/stores/dragInteractionStore';
import { useEditorHistoryStore } from '@/stores/editorHistoryStore';
import { useLayerStore } from '@/stores/layerStore';
import { useProjectStore } from '@/stores/projectStore';
import {
  MAX_PAINT_MASK_BRUSH_SIZE,
  MIN_PAINT_MASK_BRUSH_SIZE,
  useSceneStore,
  type LocalRepaintProjectionSource,
} from '@/stores/sceneStore';
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
import { buildProjectionMatrixBundle } from '@/engine/projection/projectionMath';
import {
  clearLiveSurfacePaintPreview,
  publishLiveSurfacePaintPreview,
} from '@/engine/paint/liveSurfacePaintPreviewRegistry';
import { serializeCamera } from '@/engine/projection/ProjectionCamera';
import { SceneRoot } from './SceneRoot';
import { CameraController } from './CameraController';
import { ViewCube } from './ViewCube';
import type { UvBakeResolution } from '@/engine/bake/uvBakeTypes';
import type { Layer } from '@/types/layer';
import type { SerializedCamera } from '@/types/capture';
import { createId } from '@/utils/id';
import { getCanvasAlphaBoundsAsync } from '@/utils/getCanvasAlphaBounds';

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
  showGrid?: boolean;
  gridVariant?: 'default' | 'subtle';
  backgroundColor?: string;
  showCaptureFrame?: boolean;
  showViewCube?: boolean;
  sceneOverlay?: ReactNode;
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
const LOCAL_REPAINT_LIVE_MASK_MAX_SIZE = 288;
const LOCAL_REPAINT_PREVIEW_MAX_SIZE = 512;
// Keep brush interaction on the lightweight projected preview, then promote the
// accumulated result to the selected UV resolution once the editor is idle.
// New paint input invalidates the queued commit, so the expensive pass never
// competes with an active stroke.
const LOCAL_REPAINT_INTERACTIVE_UV_BAKE_ENABLED = true;
const LOCAL_REPAINT_HIGH_RES_IDLE_MS = 3000;
const LOCAL_REPAINT_HANDOFF_DURATION_MS = 160;
const PROJECTED_ERASER_HIGH_RES_IDLE_MS = 1800;
// Stop projection before a surface becomes so foreshortened that a few source
// pixels stretch into visible scan lines. 0.31 is about 72 degrees from face-on;
// the shared 0.08 cosine feather starts fading at roughly 67 degrees.
const LOCAL_REPAINT_MINIMUM_FACE_ON = 0.31;
const INPAINT_BRUSH_MIN_WORLD_RADIUS_RATIO = 0.004;
const INPAINT_BRUSH_MAX_WORLD_RADIUS_RATIO = 0.12;
const INPAINT_BRUSH_MIN_TEXTURE_RADIUS = 1;
const INPAINT_BRUSH_MAX_TEXTURE_RADIUS = 72;
const LOCAL_REPAINT_PROJECTION_LAYER_ID_PREFIX = 'local-repaint-projection';
const LEGACY_LOCAL_REPAINT_PROJECTION_LAYER_ID_PREFIX = 'local-repaint-brush-projection';
const LOCAL_REPAINT_UV_MERGE_LAYER_ID_PREFIX = 'local-repaint-uv-merge';
const LOCAL_REPAINT_UV_MERGE_LAYER_NAME = '局部重绘合并层';
// Paint feedback is an editor overlay, not part of the texture layer stack.
// Keep it above projected textures, topology wireframes and selection helpers.
// The inpaint selection must be the final model-space overlay so its striped
// feedback cannot be covered by a paint preview or any texture-layer material.
const PAINT_STROKE_PREVIEW_RENDER_ORDER = 1000;
const INPAINT_MASK_OVERLAY_RENDER_ORDER = 1_000_000_000;
const surfacePaintPerfSamples: number[] = [];
const gpuFrameTimeSamples: number[] = [];
const automaticFadeBrushStampCache = new Map<number, HTMLCanvasElement>();
const paintBrushStampCache = new Map<string, HTMLCanvasElement>();
let surfacePaintPerfFrame: number | undefined;
let surfacePaintPerfLastPublishAt = 0;

function getAutomaticFadeBrushStamp(value: number) {
  const key = Math.round(THREE.MathUtils.clamp(value, 0, 255));
  const cached = automaticFadeBrushStampCache.get(key);
  if (cached) return cached;
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const context = canvas.getContext('2d');
  if (!context) return undefined;
  const center = canvas.width / 2;
  const gradient = context.createRadialGradient(center, center, 0, center, center, center);
  const gray = (alpha: number) => `rgba(${key}, ${key}, ${key}, ${alpha})`;
  gradient.addColorStop(0, gray(1));
  gradient.addColorStop(0.55, gray(1));
  gradient.addColorStop(0.78, gray(0.55));
  gradient.addColorStop(0.92, gray(0.16));
  gradient.addColorStop(1, gray(0));
  context.fillStyle = gradient;
  context.fillRect(0, 0, canvas.width, canvas.height);
  automaticFadeBrushStampCache.set(key, canvas);
  return canvas;
}

function getPaintBrushStamp(color: string, hardness: number) {
  const normalizedHardness = Math.round(THREE.MathUtils.clamp(hardness, 0, 100));
  const key = `${color}:${normalizedHardness}`;
  const cached = paintBrushStampCache.get(key);
  if (cached) return cached;
  const canvas = document.createElement('canvas');
  canvas.width = 96;
  canvas.height = 96;
  const context = canvas.getContext('2d');
  if (!context) return undefined;
  const center = canvas.width / 2;
  const gradient = context.createRadialGradient(center, center, 0, center, center, center);
  const hardStop = (normalizedHardness / 100) * 0.94;
  gradient.addColorStop(0, 'rgba(255, 255, 255, 1)');
  if (hardStop > 0.001) gradient.addColorStop(hardStop, 'rgba(255, 255, 255, 1)');
  gradient.addColorStop(1, 'rgba(255, 255, 255, 0)');
  context.fillStyle = gradient;
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.globalCompositeOperation = 'source-in';
  context.fillStyle = color;
  context.fillRect(0, 0, canvas.width, canvas.height);
  paintBrushStampCache.set(key, canvas);
  return canvas;
}

function normalizePaintMaskBrushSize(size: number) {
  return THREE.MathUtils.clamp(
    (size - MIN_PAINT_MASK_BRUSH_SIZE) / (MAX_PAINT_MASK_BRUSH_SIZE - MIN_PAINT_MASK_BRUSH_SIZE),
    0,
    1,
  );
}

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
  pointerType: string;
  durationMs: number;
  pointerEvents: number;
  coalescedEvents: number;
  raycasts: number;
  hits: number;
  misses: number;
  continuityBreaks: number;
  maxPointerGapPx: number;
  minPressure: number;
  maxPressure: number;
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
  if (performance.now() - surfacePaintPerfLastPublishAt < 500) return;
  if (surfacePaintPerfFrame !== undefined) return;
  surfacePaintPerfFrame = window.requestAnimationFrame(() => {
    surfacePaintPerfFrame = undefined;
    surfacePaintPerfLastPublishAt = performance.now();
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

function AcceleratedSceneRoot({ sceneOverlay }: { sceneOverlay?: ReactNode }) {
  const modelSignature = useSceneStore((state) =>
    state.importedModels.map((model) => `${model.objectId}:${model.group.uuid}`).join('|'),
  );

  return (
    <Bvh key={modelSignature} firstHitOnly maxLeafTris={12} verbose={false}>
      <SceneRoot />
      {sceneOverlay}
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
  paintPreviewMaterial: THREE.ShaderMaterial;
  liveResultCanvas: HTMLCanvasElement;
  liveResultContext: CanvasRenderingContext2D;
  liveResultTexture: THREE.CanvasTexture;
  liveResultUrl: string;
  liveEraserPreviewActive: boolean;
  paintOverlayTargets: Set<THREE.Mesh>;
  paintPreviewOverlays: THREE.Mesh[];
  projectionCanvas: HTMLCanvasElement;
  projectionContext: CanvasRenderingContext2D;
  projectionTexture: THREE.CanvasTexture;
  maskCanvas: HTMLCanvasElement;
  maskContext: CanvasRenderingContext2D;
  maskTexture: THREE.CanvasTexture;
  maskMaterial: THREE.ShaderMaterial;
  maskProjectorMatrix: THREE.Matrix4;
  maskProjectionReady: boolean;
  overlayMeshes: THREE.Mesh[];
  overlayTargets: Set<THREE.Mesh>;
};

type UvPaintHit = {
  model: SurfacePaintTarget;
  hit: THREE.Intersection<THREE.Object3D>;
  uv: THREE.Vector2;
  screenUv: THREE.Vector2;
  worldRadius: number;
  textureRadius: number;
  uvBrush: BrushStampTransform;
  screenBrush: BrushStampTransform;
  screenBrushRadiusPx: number;
};

type BrushStampTransform = {
  axisX: THREE.Vector2;
  axisY: THREE.Vector2;
};

function createCircularBrushTransform(radius: number, resolution = UV_PAINT_RESOLUTION) {
  const normalizedRadius = Math.max(1, radius) / Math.max(1, resolution);
  return {
    axisX: new THREE.Vector2(normalizedRadius, 0),
    axisY: new THREE.Vector2(0, normalizedRadius),
  };
}

const surfaceBrushScratch = {
  p0: new THREE.Vector3(),
  p1: new THREE.Vector3(),
  p2: new THREE.Vector3(),
  edge1: new THREE.Vector3(),
  edge2: new THREE.Vector3(),
  dpdu: new THREE.Vector3(),
  dpdv: new THREE.Vector3(),
  tangentX: new THREE.Vector3(),
  tangentY: new THREE.Vector3(),
  normal: new THREE.Vector3(),
  delta: new THREE.Vector3(),
  projected: new THREE.Vector3(),
  screenCenter: new THREE.Vector2(),
  projectedUv: new THREE.Vector2(),
  uv0: new THREE.Vector2(),
  uv1: new THREE.Vector2(),
  uv2: new THREE.Vector2(),
  uvEdge1: new THREE.Vector2(),
  uvEdge2: new THREE.Vector2(),
  uvAxisX: new THREE.Vector2(),
  uvAxisY: new THREE.Vector2(),
};

function computeUvBrushTransform(
  mesh: THREE.Mesh,
  face: THREE.Face,
  worldRadius: number,
  fallbackRadius: number,
) {
  const position = mesh.geometry.getAttribute('position');
  const uv = mesh.geometry.getAttribute('uv');
  if (!(position instanceof THREE.BufferAttribute) || !(uv instanceof THREE.BufferAttribute)) {
    return createCircularBrushTransform(fallbackRadius);
  }

  const {
    p0,
    p1,
    p2,
    edge1,
    edge2,
    dpdu,
    dpdv,
    tangentX,
    tangentY,
    normal,
    uv0,
    uv1,
    uv2,
    uvEdge1,
    uvEdge2,
    uvAxisX,
    uvAxisY,
  } = surfaceBrushScratch;
  p0.fromBufferAttribute(position, face.a).applyMatrix4(mesh.matrixWorld);
  p1.fromBufferAttribute(position, face.b).applyMatrix4(mesh.matrixWorld);
  p2.fromBufferAttribute(position, face.c).applyMatrix4(mesh.matrixWorld);
  uv0.fromBufferAttribute(uv, face.a);
  uv1.fromBufferAttribute(uv, face.b);
  uv2.fromBufferAttribute(uv, face.c);
  edge1.copy(p1).sub(p0);
  edge2.copy(p2).sub(p0);
  uvEdge1.copy(uv1).sub(uv0);
  uvEdge2.copy(uv2).sub(uv0);
  const determinant = uvEdge1.x * uvEdge2.y - uvEdge1.y * uvEdge2.x;
  if (Math.abs(determinant) < 1e-12 || edge1.lengthSq() < 1e-16 || edge2.lengthSq() < 1e-16) {
    return createCircularBrushTransform(fallbackRadius);
  }

  const inverseDeterminant = 1 / determinant;
  dpdu
    .copy(edge1)
    .multiplyScalar(uvEdge2.y)
    .addScaledVector(edge2, -uvEdge1.y)
    .multiplyScalar(inverseDeterminant);
  dpdv
    .copy(edge2)
    .multiplyScalar(uvEdge1.x)
    .addScaledVector(edge1, -uvEdge2.x)
    .multiplyScalar(inverseDeterminant);
  const metric00 = dpdu.dot(dpdu);
  const metric01 = dpdu.dot(dpdv);
  const metric11 = dpdv.dot(dpdv);
  const metricDeterminant = metric00 * metric11 - metric01 * metric01;
  if (!Number.isFinite(metricDeterminant) || metricDeterminant < 1e-18) {
    return createCircularBrushTransform(fallbackRadius);
  }

  tangentX.copy(edge1).normalize();
  normal.crossVectors(edge1, edge2).normalize();
  if (normal.lengthSq() < 0.5) return createCircularBrushTransform(fallbackRadius);
  tangentY.crossVectors(normal, tangentX).normalize();
  const inverseMetric00 = metric11 / metricDeterminant;
  const inverseMetric01 = -metric01 / metricDeterminant;
  const inverseMetric11 = metric00 / metricDeterminant;
  const solveUvAxis = (worldAxis: THREE.Vector3, target: THREE.Vector2) => {
    const rhs0 = dpdu.dot(worldAxis) * worldRadius;
    const rhs1 = dpdv.dot(worldAxis) * worldRadius;
    return target.set(
      inverseMetric00 * rhs0 + inverseMetric01 * rhs1,
      inverseMetric01 * rhs0 + inverseMetric11 * rhs1,
    );
  };
  solveUvAxis(tangentX, uvAxisX);
  solveUvAxis(tangentY, uvAxisY);
  if (
    !Number.isFinite(uvAxisX.lengthSq()) ||
    !Number.isFinite(uvAxisY.lengthSq()) ||
    uvAxisX.lengthSq() < 1e-20 ||
    uvAxisY.lengthSq() < 1e-20
  ) {
    return createCircularBrushTransform(fallbackRadius);
  }
  return { axisX: uvAxisX.clone(), axisY: uvAxisY.clone() };
}

function computeScreenBrushTransform(
  mesh: THREE.Mesh,
  face: THREE.Face,
  hitPoint: THREE.Vector3,
  camera: THREE.Camera,
  worldRadius: number,
  fallbackRadius: number,
) {
  const position = mesh.geometry.getAttribute('position');
  if (!(position instanceof THREE.BufferAttribute)) {
    return createCircularBrushTransform(fallbackRadius);
  }

  const { p0, p1, p2, edge1, edge2, tangentX, tangentY, normal, delta } = surfaceBrushScratch;
  p0.fromBufferAttribute(position, face.a).applyMatrix4(mesh.matrixWorld);
  p1.fromBufferAttribute(position, face.b).applyMatrix4(mesh.matrixWorld);
  p2.fromBufferAttribute(position, face.c).applyMatrix4(mesh.matrixWorld);
  edge1.copy(p1).sub(p0);
  edge2.copy(p2).sub(p0);
  if (edge1.lengthSq() < 1e-16 || edge2.lengthSq() < 1e-16) {
    return createCircularBrushTransform(fallbackRadius);
  }
  tangentX.copy(edge1).normalize();
  normal.crossVectors(edge1, edge2).normalize();
  if (normal.lengthSq() < 0.5) return createCircularBrushTransform(fallbackRadius);
  tangentY.crossVectors(normal, tangentX).normalize();

  const projectToScreen = (point: THREE.Vector3) => {
    const projected = surfaceBrushScratch.projected.copy(point).project(camera);
    return new THREE.Vector2((projected.x + 1) * 0.5, (1 - projected.y) * 0.5);
  };
  const screenCenter = surfaceBrushScratch.screenCenter.copy(projectToScreen(hitPoint));
  const screenAxisX = projectToScreen(
    delta.copy(hitPoint).addScaledVector(tangentX, worldRadius),
  ).sub(screenCenter);
  const screenAxisY = projectToScreen(
    delta.copy(hitPoint).addScaledVector(tangentY, worldRadius),
  ).sub(screenCenter);
  if (
    !Number.isFinite(screenAxisX.lengthSq()) ||
    !Number.isFinite(screenAxisY.lengthSq()) ||
    screenAxisX.lengthSq() < 1e-20 ||
    screenAxisY.lengthSq() < 1e-20
  ) {
    return createCircularBrushTransform(fallbackRadius);
  }
  return { axisX: screenAxisX, axisY: screenAxisY };
}

type UvPaintSample = {
  meshUuid: string;
  faceIndex?: number;
  uv: THREE.Vector2;
  screenUv: THREE.Vector2;
  localRepaintUv?: THREE.Vector2;
  point: THREE.Vector3;
  screenBrushRadiusPx: number;
};

type PaintDirtyRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type PaintStrokeDraft = {
  layer?: UvPaintLayer;
  target: 'paint' | 'mask' | 'apply-local-repaint';
  bounds?: PaintDirtyRect;
  paintOperation?: 'brush' | 'eraser';
  previewRevision?: number;
  paintSegments?: Array<{
    fromUv?: THREE.Vector2;
    toUv: THREE.Vector2;
    brush: BrushStampTransform;
    color: string;
    hardness: number;
  }>;
  localRepaintSource?: LocalRepaintProjectionSource;
  localRepaintComposite?: LocalRepaintCompositeState;
};

type PaintHistoryTile = {
  bounds: PaintDirtyRect;
  before: HTMLCanvasElement;
  after: HTMLCanvasElement;
};

type PendingProjectedEraserBatch = {
  layer: UvPaintLayer;
  snapshots: ProjectedEraserSnapshot[];
  revision: number;
  timerId?: number;
  idleCallbackId?: number;
  latestHistoryTiles?: PaintHistoryTile[];
};

function appendProjectedEraserSnapshot(
  snapshots: ProjectedEraserSnapshot[],
  snapshot: ProjectedEraserSnapshot,
) {
  const previous = snapshots.at(-1);
  const sharesProjection =
    previous &&
    previous.model.objectId === snapshot.model.objectId &&
    previous.maskCanvas.width === snapshot.maskCanvas.width &&
    previous.maskCanvas.height === snapshot.maskCanvas.height &&
    previous.objectMatrixWorld.every(
      (value, index) => Math.abs(value - snapshot.objectMatrixWorld[index]) < 1e-6,
    ) &&
    JSON.stringify(previous.camera) === JSON.stringify(snapshot.camera);
  if (!sharesProjection) {
    snapshots.push(snapshot);
    return;
  }
  const context = previous.maskCanvas.getContext('2d');
  if (!context) {
    snapshots.push(snapshot);
    return;
  }
  context.drawImage(snapshot.maskCanvas, 0, 0);
}

type ClientPoint = { x: number; y: number; pressure: number };

function getPointerPressure(event: Pick<globalThis.PointerEvent, 'pointerType' | 'pressure'>) {
  if (event.pointerType !== 'pen') return 1;
  const pressure = Number.isFinite(event.pressure) ? event.pressure : 0.5;
  return Math.max(0.02, Math.min(1, pressure || 0.02));
}

function getPressureSizeScale(pressure: number) {
  return 0.1 + Math.pow(THREE.MathUtils.clamp(pressure, 0.02, 1), 0.72) * 0.9;
}

function scaleBrushTransform(brush: BrushStampTransform, scale: number): BrushStampTransform {
  return {
    axisX: brush.axisX.clone().multiplyScalar(scale),
    axisY: brush.axisY.clone().multiplyScalar(scale),
  };
}

function resampleClientPath(
  start: ClientPoint | undefined,
  targets: ClientPoint[],
  maxSamples = 256,
  spacingPx = 3,
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

  // Preserve every visible stroke when the browser delivers a large batch of
  // coalesced events. Spacing follows the visible brush radius, while the cap keeps
  // pathological input from triggering unbounded raycast work in one frame.
  const sampleCount = Math.min(
    maxSamples,
    Math.max(1, Math.ceil(totalLength / Math.max(1, spacingPx))),
  );
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
      pressure: THREE.MathUtils.lerp(
        points[segmentIndex].pressure,
        points[segmentIndex + 1].pressure,
        ratio,
      ),
    });
  }
  return { samples, maxGapPx };
}

type LocalRepaintCompositeState = {
  sourceKey: string;
  layerId: string;
  maskUrl: string;
  maskTexture: THREE.CanvasTexture;
  maskCanvas: HTMLCanvasElement;
  maskContext: CanvasRenderingContext2D;
  scratchCanvas: HTMLCanvasElement;
  scratchContext: CanvasRenderingContext2D;
  falloffCanvas: HTMLCanvasElement;
  worldToSourceClip: THREE.Matrix4;
  objectMatrixDelta: THREE.Matrix4;
  objectNormalDelta: THREE.Matrix3;
  projectorViewMatrix: THREE.Matrix4;
  projectorViewNormalMatrix: THREE.Matrix3;
  restoredMaskUrl?: string;
};

function createLocalRepaintFalloffCanvas(
  allowedMaskImage: HTMLImageElement | undefined,
  width: number,
  height: number,
) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return canvas;

  // A missing/empty legacy mask must not make the apply brush unusable.
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, width, height);
  if (!allowedMaskImage) return canvas;

  context.clearRect(0, 0, width, height);
  context.drawImage(allowedMaskImage, 0, 0, width, height);
  const mask = context.getImageData(0, 0, width, height);
  let weightTotal = 0;
  let weightedX = 0;
  let weightedY = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const weight =
        (Math.max(mask.data[offset], mask.data[offset + 1], mask.data[offset + 2]) / 255) *
        (mask.data[offset + 3] / 255);
      if (weight <= 0.03) continue;
      weightTotal += weight;
      weightedX += x * weight;
      weightedY += y * weight;
    }
  }
  if (weightTotal <= 0) {
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, width, height);
    return canvas;
  }

  const centerX = weightedX / weightTotal;
  const centerY = weightedY / weightTotal;
  let coreRadius = 1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const coverage =
        (Math.max(mask.data[offset], mask.data[offset + 1], mask.data[offset + 2]) / 255) *
        (mask.data[offset + 3] / 255);
      if (coverage <= 0.03) continue;
      coreRadius = Math.max(coreRadius, Math.hypot(x - centerX, y - centerY));
    }
  }

  // Preserve full opacity throughout the authored mask, then fade around its
  // centroid across the complete captured view. Put the zero point beyond the
  // farthest canvas corner so every visible model pixel remains paintable while
  // distant replacement content still blends much more softly.
  const farthestCornerRadius = Math.max(
    Math.hypot(centerX, centerY),
    Math.hypot(width - 1 - centerX, centerY),
    Math.hypot(centerX, height - 1 - centerY),
    Math.hypot(width - 1 - centerX, height - 1 - centerY),
  );
  const fadeEndRadius = Math.max(coreRadius + 1, farthestCornerRadius * 1.2);
  const expansionRadius = fadeEndRadius - coreRadius;
  const output = context.createImageData(width, height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const distance = Math.hypot(x - centerX, y - centerY);
      const linearFade = THREE.MathUtils.clamp(
        (fadeEndRadius - distance) / Math.max(expansionRadius, 1),
        0,
        1,
      );
      const opacity = linearFade * linearFade * (3 - 2 * linearFade);
      const offset = (y * width + x) * 4;
      output.data[offset] = 255;
      output.data[offset + 1] = 255;
      output.data[offset + 2] = 255;
      output.data[offset + 3] = Math.round(opacity * 255);
    }
  }
  context.putImageData(output, 0, 0);
  return canvas;
}

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

function scaleDirtyRect(
  bounds: PaintDirtyRect,
  sourceWidth: number,
  sourceHeight: number,
  targetWidth: number,
  targetHeight: number,
): PaintDirtyRect {
  const scaleX = targetWidth / Math.max(sourceWidth, 1);
  const scaleY = targetHeight / Math.max(sourceHeight, 1);
  const x = Math.max(0, Math.floor(bounds.x * scaleX));
  const y = Math.max(0, Math.floor(bounds.y * scaleY));
  const right = Math.min(targetWidth, Math.ceil((bounds.x + bounds.width) * scaleX));
  const bottom = Math.min(targetHeight, Math.ceil((bounds.y + bounds.height) * scaleY));
  return {
    x,
    y,
    width: Math.max(1, right - x),
    height: Math.max(1, bottom - y),
  };
}

function getEraserBakeResolution(canvas: HTMLCanvasElement): UvBakeResolution {
  const size = Math.max(canvas.width, canvas.height);
  if (size >= 8192) return 4096;
  if (size >= 4096) return 4096;
  if (size >= 2048) return 2048;
  if (size >= 1024) return 1024;
  return 512;
}

type ProjectedEraserSnapshot = {
  model: SurfacePaintTarget;
  camera: SerializedCamera;
  objectMatrixWorld: number[];
  maskCanvas: HTMLCanvasElement;
};

async function bakeProjectedEraserStrokesToUv(input: {
  snapshots: ProjectedEraserSnapshot[];
  resolution: UvBakeResolution;
  runtimeKey: string;
}) {
  if (input.snapshots.length === 0) throw new Error('Projected eraser batch is empty.');
  const transientLayers = input.snapshots.map((snapshot, index): Layer => {
    const whiteCanvas = document.createElement('canvas');
    whiteCanvas.width = snapshot.maskCanvas.width;
    whiteCanvas.height = snapshot.maskCanvas.height;
    const whiteContext = whiteCanvas.getContext('2d');
    if (!whiteContext) throw new Error('Could not create projected eraser source.');
    whiteContext.fillStyle = '#ffffff';
    whiteContext.fillRect(0, 0, whiteCanvas.width, whiteCanvas.height);
    const imageUrl = registerLiveProjectedCanvasTexture(
      `surface-eraser:${input.runtimeKey}:${index}:image`,
      whiteCanvas,
      THREE.SRGBColorSpace,
    );
    const maskUrl = registerLiveProjectedCanvasTexture(
      `surface-eraser:${input.runtimeKey}:${index}:mask`,
      snapshot.maskCanvas,
      THREE.NoColorSpace,
    );
    return {
      id: createId('surface-eraser-projection'),
      name: '投影橡皮擦笔迹',
      type: 'projected',
      imageUrl,
      maskUrl,
      maskSpace: 'projection',
      objectId: snapshot.model.objectId,
      objectMatrixWorld: snapshot.objectMatrixWorld,
      camera: snapshot.camera,
      renderedColor: true,
      visible: true,
      opacity: 1,
      strength: 1,
      blendMode: 'normal',
      adjustments: { hue: 0, saturation: 0, lightness: 0 },
      order: index,
      createdAt: new Date().toISOString(),
    };
  });
  const { bakeVisibleProjectedLayersToTexture } =
    await import('@/engine/bake/bakeProjectedLayerToTexture');
  return bakeVisibleProjectedLayersToTexture({
    objectId: input.snapshots[0].model.objectId,
    transientLayers,
    resolution: input.resolution,
    enableBackfaceCulling: true,
    enableDilation: false,
    dilationPixels: 0,
    outputAlpha: 'transparent',
    gpuCompositeMode: 'coverage-alpha',
    // Repair paired UV seams in the GPU pass. Keeping this result GPU-final
    // avoids a 4K getImageData/topology scan on the editor thread.
    uvCoverageGapPixels: 0,
    repairMissingUvSeams: true,
    uvSeamRepairPixels: 2,
    skipGpuValidation: true,
    minimumCoverageRatio: 0,
    commitToProject: false,
    markSourceLayersBaked: false,
    skipImageEncoding: true,
    skipCpuPostprocess: true,
  });
}

function createInpaintMaskMaterial(maskTexture: THREE.CanvasTexture) {
  return new THREE.ShaderMaterial({
    uniforms: {
      maskMap: { value: maskTexture },
      projectorMatrix: { value: new THREE.Matrix4() },
      projectorPosition: { value: new THREE.Vector3() },
      projectionReady: { value: 0 },
      stripeColor: { value: new THREE.Color('#d6703e') },
      stripeOpacity: { value: 0.64 },
      stripePeriod: { value: 14 },
      stripeWidth: { value: 7 },
    },
    vertexShader: `
      uniform mat4 projectorMatrix;
      uniform vec3 projectorPosition;
      varying vec4 vProjectedPosition;
      varying float vProjectorFacing;

      void main() {
        vec4 worldPosition = modelMatrix * vec4(position, 1.0);
        vec3 worldNormal = normalize(mat3(modelMatrix) * normal);
        vec3 projectorDirection = normalize(projectorPosition - worldPosition.xyz);
        vProjectedPosition = projectorMatrix * worldPosition;
        vProjectorFacing = dot(worldNormal, projectorDirection);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform sampler2D maskMap;
      uniform float projectionReady;
      uniform vec3 stripeColor;
      uniform float stripeOpacity;
      uniform float stripePeriod;
      uniform float stripeWidth;
      varying vec4 vProjectedPosition;
      varying float vProjectorFacing;

      void main() {
        if (projectionReady < 0.5) discard;
        if (vProjectedPosition.w <= 0.0001) discard;
        vec3 ndc = vProjectedPosition.xyz / vProjectedPosition.w;
        if (abs(ndc.x) > 1.0 || abs(ndc.y) > 1.0 || abs(ndc.z) > 1.0) discard;
        vec2 maskUv = ndc.xy * 0.5 + 0.5;
        maskUv.y = 1.0 - maskUv.y;
        vec4 maskTexel = texture2D(maskMap, maskUv);
        float maskAlpha = max(maskTexel.r, max(maskTexel.g, maskTexel.b)) * maskTexel.a;
        if (maskAlpha <= 0.01) discard;

        float coord = mod(gl_FragCoord.x + gl_FragCoord.y, stripePeriod);
        float stripe = 1.0 - step(stripeWidth, coord);
        if (stripe <= 0.01) discard;

        gl_FragColor = vec4(stripeColor, stripeOpacity * stripe);
      }
    `,
    transparent: true,
    depthWrite: false,
    // This material is display-only feedback for the already recorded mask.
    // Draw it after every model/material pass without consulting scene depth so
    // no fitting, projected texture or preview layer can cover the stripes.
    depthTest: false,
    polygonOffset: true,
    polygonOffsetFactor: -8,
    polygonOffsetUnits: -8,
    // Imported production meshes can contain reversed winding or two-sided
    // parts. Visibility is decided by the scene depth buffer, so render both
    // sides here instead of letting inconsistent normals punch holes through
    // the topmost selection overlay.
    side: THREE.DoubleSide,
    toneMapped: false,
  });
}

function createProjectedPaintPreviewMaterial(maskTexture: THREE.CanvasTexture) {
  return new THREE.ShaderMaterial({
    uniforms: {
      maskMap: { value: maskTexture },
      projectorMatrix: { value: new THREE.Matrix4() },
      projectorPosition: { value: new THREE.Vector3() },
      projectionReady: { value: 0 },
      previewColor: { value: new THREE.Color('#ffffff') },
      previewOpacity: { value: 1 },
    },
    vertexShader: `
      uniform mat4 projectorMatrix;
      uniform vec3 projectorPosition;
      varying vec4 vProjectedPosition;
      varying float vProjectorFacing;

      void main() {
        vec4 worldPosition = modelMatrix * vec4(position, 1.0);
        vec3 worldNormal = normalize(mat3(modelMatrix) * normal);
        vec3 projectorDirection = normalize(projectorPosition - worldPosition.xyz);
        vProjectedPosition = projectorMatrix * worldPosition;
        vProjectorFacing = dot(worldNormal, projectorDirection);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform sampler2D maskMap;
      uniform float projectionReady;
      uniform vec3 previewColor;
      uniform float previewOpacity;
      varying vec4 vProjectedPosition;
      varying float vProjectorFacing;

      void main() {
        if (projectionReady < 0.5) discard;
        if (vProjectedPosition.w <= 0.0001 || vProjectorFacing <= 0.01) discard;
        vec3 ndc = vProjectedPosition.xyz / vProjectedPosition.w;
        if (abs(ndc.x) > 1.0 || abs(ndc.y) > 1.0 || abs(ndc.z) > 1.0) discard;
        vec2 maskUv = ndc.xy * 0.5 + 0.5;
        maskUv.y = 1.0 - maskUv.y;
        vec4 maskTexel = texture2D(maskMap, maskUv);
        float coverage = max(maskTexel.r, max(maskTexel.g, maskTexel.b)) * maskTexel.a;
        if (coverage <= 0.01) discard;
        gl_FragColor = vec4(previewColor, coverage * previewOpacity);
      }
    `,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    polygonOffset: true,
    polygonOffsetFactor: -10,
    polygonOffsetUnits: -10,
    side: THREE.FrontSide,
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

function updateInpaintProjectionCamera(layer: UvPaintLayer, camera: THREE.Camera) {
  camera.updateMatrixWorld(true);
  layer.maskProjectorMatrix.copy(camera.projectionMatrix).multiply(camera.matrixWorldInverse);
  layer.maskProjectionReady = true;
  [layer.maskMaterial, layer.paintPreviewMaterial].forEach((material) => {
    const uniforms = material.uniforms;
    (uniforms.projectorMatrix.value as THREE.Matrix4).copy(layer.maskProjectorMatrix);
    (uniforms.projectorPosition.value as THREE.Vector3).setFromMatrixPosition(camera.matrixWorld);
    uniforms.projectionReady.value = 1;
  });
}

const inpaintProjectorComparisonScratch = new THREE.Matrix4();

function hasInpaintProjectionCameraChanged(layer: UvPaintLayer, camera: THREE.Camera) {
  if (!layer.maskProjectionReady) return true;
  camera.updateMatrixWorld(true);
  inpaintProjectorComparisonScratch
    .copy(camera.projectionMatrix)
    .multiply(camera.matrixWorldInverse);
  const previous = layer.maskProjectorMatrix.elements;
  const current = inpaintProjectorComparisonScratch.elements;
  for (let index = 0; index < 16; index += 1) {
    if (Math.abs(previous[index] - current[index]) > 1e-5) return true;
  }
  return false;
}

function disposeUvPaintLayer(layer?: UvPaintLayer) {
  if (!layer) return;
  endLiveEraserPreview(layer);
  layer.overlayMeshes.forEach((mesh) => mesh.removeFromParent());
  layer.paintPreviewMaterial.dispose();
  layer.projectionTexture.dispose();
  layer.maskTexture.dispose();
  layer.maskMaterial.dispose();
}

function hasCanvasAlpha(canvas: HTMLCanvasElement, context: CanvasRenderingContext2D) {
  const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
  for (let index = 3; index < data.length; index += 4) {
    if (data[index] > 0) return true;
  }
  return false;
}

async function projectionMaskToDataUrl(source: HTMLCanvasElement) {
  const canvas = document.createElement('canvas');
  canvas.width = source.width;
  canvas.height = source.height;
  const context = canvas.getContext('2d');
  if (!context) return canvasToPngDataUrl(source);
  context.fillStyle = '#000000';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(source, 0, 0);
  const image = context.getImageData(0, 0, canvas.width, canvas.height);
  for (let index = 0; index < image.data.length; index += 4) {
    const value = Math.max(image.data[index], image.data[index + 1], image.data[index + 2]);
    image.data[index] = value;
    image.data[index + 1] = value;
    image.data[index + 2] = value;
    image.data[index + 3] = 255;
  }
  context.putImageData(image, 0, 0);
  return canvasToPngDataUrl(canvas);
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

function createLocalRepaintPreviewCanvas(image: HTMLImageElement) {
  const sourceWidth = image.naturalWidth || image.width;
  const sourceHeight = image.naturalHeight || image.height;
  if (
    sourceWidth <= 0 ||
    sourceHeight <= 0 ||
    Math.max(sourceWidth, sourceHeight) <= LOCAL_REPAINT_PREVIEW_MAX_SIZE
  )
    return undefined;
  const scale = LOCAL_REPAINT_PREVIEW_MAX_SIZE / Math.max(sourceWidth, sourceHeight);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(sourceWidth * scale));
  canvas.height = Math.max(1, Math.round(sourceHeight * scale));
  const context = canvas.getContext('2d');
  if (!context) return undefined;
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  // The 4K source is already decoded here. Creating a resized ImageBitmap can
  // take seconds on some Windows GPU/driver combinations and delayed the first
  // apply-brush click. A single 512px canvas draw is deterministic and cheap.
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas;
}

function createLocalRepaintSourceKey(source: LocalRepaintProjectionSource, objectId: string) {
  return [
    source.generationId ?? source.captureId ?? source.imageUrl,
    source.objectId ?? objectId,
    source.targetLayerId ?? '',
  ].join('|');
}

function isLocalRepaintProjectionLayer(layer: Layer) {
  return (
    layer.type === 'projected' &&
    (layer.id.startsWith(LOCAL_REPAINT_PROJECTION_LAYER_ID_PREFIX) ||
      layer.id.startsWith(LEGACY_LOCAL_REPAINT_PROJECTION_LAYER_ID_PREFIX))
  );
}

function isLocalRepaintUvMergeLayer(layer: Layer, objectId?: string) {
  return (
    layer.type === 'uv' &&
    layer.id.startsWith(LOCAL_REPAINT_UV_MERGE_LAYER_ID_PREFIX) &&
    (!objectId || !layer.objectId || layer.objectId === objectId)
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
  allowedMaskImage?: HTMLImageElement,
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
  const maskTexture = getLiveProjectedCanvasTexture(maskUrl, THREE.NoColorSpace);
  if (!maskTexture) return undefined;
  return {
    sourceKey,
    layerId,
    maskUrl,
    maskTexture,
    maskCanvas,
    maskContext,
    scratchCanvas,
    scratchContext,
    falloffCanvas: createLocalRepaintFalloffCanvas(allowedMaskImage, width, height),
    worldToSourceClip: new THREE.Matrix4(),
    objectMatrixDelta: new THREE.Matrix4(),
    objectNormalDelta: new THREE.Matrix3(),
    projectorViewMatrix: new THREE.Matrix4(),
    projectorViewNormalMatrix: new THREE.Matrix3(),
  };
}

const localRepaintProjectionScratch = {
  currentObjectInverse: new THREE.Matrix4(),
  captureObjectMatrix: new THREE.Matrix4(),
  captureViewPoint: new THREE.Vector3(),
  viewDirection: new THREE.Vector3(),
  clipPoint: new THREE.Vector4(),
  projectedUv: new THREE.Vector2(),
};

function updateLocalRepaintProjectionMatrix(
  composite: LocalRepaintCompositeState,
  model: SurfacePaintTarget,
  source: LocalRepaintProjectionSource,
) {
  model.group.updateMatrixWorld(true);
  localRepaintProjectionScratch.currentObjectInverse.copy(model.group.matrixWorld).invert();
  const captureObjectMatrix = source.objectMatrixWorld
    ? localRepaintProjectionScratch.captureObjectMatrix.fromArray(source.objectMatrixWorld)
    : model.group.matrixWorld;
  composite.objectMatrixDelta
    .copy(captureObjectMatrix)
    .multiply(localRepaintProjectionScratch.currentObjectInverse);
  composite.objectNormalDelta.getNormalMatrix(composite.objectMatrixDelta);
  composite.projectorViewMatrix.fromArray(source.camera.viewMatrix);
  composite.projectorViewNormalMatrix.getNormalMatrix(composite.projectorViewMatrix);
  composite.worldToSourceClip
    .copy(buildProjectionMatrixBundle(source.camera).projectorMatrix)
    .multiply(composite.objectMatrixDelta);
  return composite.worldToSourceClip;
}

function isLocalRepaintSurfaceFacingProjector(
  composite: LocalRepaintCompositeState,
  mesh: THREE.Mesh,
  face: THREE.Face,
  hitPoint: THREE.Vector3,
) {
  const position = mesh.geometry.getAttribute('position');
  if (!(position instanceof THREE.BufferAttribute)) return false;
  const { p0, p1, p2, edge1, edge2, normal } = surfaceBrushScratch;
  p0.fromBufferAttribute(position, face.a).applyMatrix4(mesh.matrixWorld);
  p1.fromBufferAttribute(position, face.b).applyMatrix4(mesh.matrixWorld);
  p2.fromBufferAttribute(position, face.c).applyMatrix4(mesh.matrixWorld);
  edge1.copy(p1).sub(p0);
  edge2.copy(p2).sub(p0);
  normal.crossVectors(edge1, edge2);
  if (normal.lengthSq() < 1e-16) return false;
  normal
    .normalize()
    .applyMatrix3(composite.objectNormalDelta)
    .applyMatrix3(composite.projectorViewNormalMatrix)
    .normalize();
  const captureViewPoint = localRepaintProjectionScratch.captureViewPoint
    .copy(hitPoint)
    .applyMatrix4(composite.objectMatrixDelta)
    .applyMatrix4(composite.projectorViewMatrix);
  const viewDirection = localRepaintProjectionScratch.viewDirection
    .copy(captureViewPoint)
    .multiplyScalar(-1);
  if (viewDirection.lengthSq() < 1e-16) return false;
  viewDirection.normalize();
  return Math.abs(normal.dot(viewDirection)) >= LOCAL_REPAINT_MINIMUM_FACE_ON;
}

function projectWorldPointToLocalRepaintUv(
  worldPoint: THREE.Vector3,
  worldToSourceClip: THREE.Matrix4,
  target = new THREE.Vector2(),
) {
  const projected = localRepaintProjectionScratch.clipPoint
    .set(worldPoint.x, worldPoint.y, worldPoint.z, 1)
    .applyMatrix4(worldToSourceClip);
  if (projected.w <= 0.0001) return undefined;
  const ndcX = projected.x / projected.w;
  const ndcY = projected.y / projected.w;
  const ndcZ = projected.z / projected.w;
  if (Math.abs(ndcX) > 1 || Math.abs(ndcY) > 1 || ndcZ < -1 || ndcZ > 1) return undefined;
  return target.set((ndcX + 1) * 0.5, (1 - ndcY) * 0.5);
}

function computeLocalRepaintBrushTransform(
  mesh: THREE.Mesh,
  face: THREE.Face,
  hitPoint: THREE.Vector3,
  worldToSourceClip: THREE.Matrix4,
  worldRadius: number,
  fallbackRadius: number,
) {
  const position = mesh.geometry.getAttribute('position');
  if (!(position instanceof THREE.BufferAttribute))
    return createCircularBrushTransform(fallbackRadius);
  const { p0, p1, p2, edge1, edge2, tangentX, tangentY, normal, delta } = surfaceBrushScratch;
  p0.fromBufferAttribute(position, face.a).applyMatrix4(mesh.matrixWorld);
  p1.fromBufferAttribute(position, face.b).applyMatrix4(mesh.matrixWorld);
  p2.fromBufferAttribute(position, face.c).applyMatrix4(mesh.matrixWorld);
  edge1.copy(p1).sub(p0);
  edge2.copy(p2).sub(p0);
  if (edge1.lengthSq() < 1e-16 || edge2.lengthSq() < 1e-16)
    return createCircularBrushTransform(fallbackRadius);
  tangentX.copy(edge1).normalize();
  normal.crossVectors(edge1, edge2).normalize();
  if (normal.lengthSq() < 0.5) return createCircularBrushTransform(fallbackRadius);
  tangentY.crossVectors(normal, tangentX).normalize();

  const center = projectWorldPointToLocalRepaintUv(
    hitPoint,
    worldToSourceClip,
    surfaceBrushScratch.screenCenter,
  );
  if (!center) return createCircularBrushTransform(fallbackRadius);
  const axisXPoint = projectWorldPointToLocalRepaintUv(
    delta.copy(hitPoint).addScaledVector(tangentX, worldRadius),
    worldToSourceClip,
    surfaceBrushScratch.projectedUv,
  );
  if (!axisXPoint) return createCircularBrushTransform(fallbackRadius);
  const axisX = axisXPoint.clone().sub(center);
  const axisYPoint = projectWorldPointToLocalRepaintUv(
    delta.copy(hitPoint).addScaledVector(tangentY, worldRadius),
    worldToSourceClip,
    surfaceBrushScratch.projectedUv,
  );
  if (!axisYPoint) return createCircularBrushTransform(fallbackRadius);
  const axisY = axisYPoint.clone().sub(center);
  if (axisX.lengthSq() < 1e-20 || axisY.lengthSq() < 1e-20)
    return createCircularBrushTransform(fallbackRadius);
  return { axisX, axisY };
}

function mergeLocalRepaintScratchPatch(
  composite: LocalRepaintCompositeState,
  dirtyRect: PaintDirtyRect,
) {
  const x = Math.max(0, Math.floor(dirtyRect.x));
  const y = Math.max(0, Math.floor(dirtyRect.y));
  const right = Math.min(composite.maskCanvas.width, Math.ceil(dirtyRect.x + dirtyRect.width));
  const bottom = Math.min(composite.maskCanvas.height, Math.ceil(dirtyRect.y + dirtyRect.height));
  const width = Math.max(1, right - x);
  const height = Math.max(1, bottom - y);

  composite.scratchContext.save();
  composite.scratchContext.globalCompositeOperation = 'destination-in';
  composite.scratchContext.drawImage(
    composite.falloffCanvas,
    x,
    y,
    width,
    height,
    x,
    y,
    width,
    height,
  );
  composite.scratchContext.restore();

  composite.maskContext.save();
  composite.maskContext.globalCompositeOperation = 'lighten';
  composite.maskContext.drawImage(
    composite.scratchCanvas,
    x,
    y,
    width,
    height,
    x,
    y,
    width,
    height,
  );
  composite.maskContext.restore();
  composite.scratchContext.clearRect(x, y, width, height);
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

function resizeProjectionCanvas(layer: UvPaintLayer, aspect: number, clear = true) {
  const safeAspect = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
  const width =
    safeAspect >= 1
      ? PROJECTION_PAINT_MAX_SIZE
      : Math.max(1, Math.round(PROJECTION_PAINT_MAX_SIZE * safeAspect));
  const height =
    safeAspect >= 1
      ? Math.max(1, Math.round(PROJECTION_PAINT_MAX_SIZE / safeAspect))
      : PROJECTION_PAINT_MAX_SIZE;
  const sizeChanged =
    layer.projectionCanvas.width !== width || layer.projectionCanvas.height !== height;
  if (sizeChanged && !clear) {
    const previous = document.createElement('canvas');
    previous.width = layer.projectionCanvas.width;
    previous.height = layer.projectionCanvas.height;
    previous.getContext('2d')?.drawImage(layer.projectionCanvas, 0, 0);
    layer.projectionCanvas.width = width;
    layer.projectionCanvas.height = height;
    layer.projectionContext.drawImage(previous, 0, 0, width, height);
  } else if (sizeChanged) {
    layer.projectionCanvas.width = width;
    layer.projectionCanvas.height = height;
  }
  if (clear) layer.projectionContext.clearRect(0, 0, width, height);
}

function getPaintHistoryTileKeysForBounds(paintCanvas: HTMLCanvasElement, bounds: PaintDirtyRect) {
  const keys = new Set<string>();
  const x = Math.max(0, Math.floor(bounds.x));
  const y = Math.max(0, Math.floor(bounds.y));
  const right = Math.min(paintCanvas.width, Math.ceil(bounds.x + bounds.width));
  const bottom = Math.min(paintCanvas.height, Math.ceil(bounds.y + bounds.height));
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

function getPaintHistoryTileKeys(layer: UvPaintLayer, previewBounds: PaintDirtyRect) {
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
  return getPaintHistoryTileKeysForBounds(paintCanvas, {
    x,
    y,
    width: Math.max(1, right - x),
    height: Math.max(1, bottom - y),
  });
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

function beginLiveEraserPreview(layer: UvPaintLayer) {
  // UV image erasing previews a copy of the edited image. Projected masks use
  // a separate all-white keep-mask that is multiplied over the original mask
  // in the shader, regardless of whether that original lives in projection or
  // UV space.
  const source =
    layer.target === 'uv-image'
      ? layer.paintBackingInitialized
        ? layer.paintCanvas
        : layer.pendingBaseImage
      : undefined;
  if (!source && layer.target === 'uv-image') {
    layer.liveEraserPreviewActive = false;
    return false;
  }
  const sourceWidth =
    source instanceof HTMLImageElement
      ? source.naturalWidth || source.width
      : source?.width || layer.paintDefaultResolution;
  const sourceHeight =
    source instanceof HTMLImageElement
      ? source.naturalHeight || source.height
      : source?.height || layer.paintDefaultResolution;
  const scale = UV_STROKE_PREVIEW_RESOLUTION / Math.max(sourceWidth, sourceHeight, 1);
  layer.liveResultCanvas.width = Math.max(1, Math.round(sourceWidth * scale));
  layer.liveResultCanvas.height = Math.max(1, Math.round(sourceHeight * scale));
  layer.liveResultContext.clearRect(
    0,
    0,
    layer.liveResultCanvas.width,
    layer.liveResultCanvas.height,
  );
  if (source) {
    layer.liveResultContext.drawImage(
      source,
      0,
      0,
      layer.liveResultCanvas.width,
      layer.liveResultCanvas.height,
    );
  } else {
    // A projected layer without an existing UV mask starts fully visible.
    layer.liveResultContext.fillStyle = '#ffffff';
    layer.liveResultContext.fillRect(
      0,
      0,
      layer.liveResultCanvas.width,
      layer.liveResultCanvas.height,
    );
  }
  layer.liveEraserPreviewActive = true;
  markLiveProjectedCanvasTextureUpdated(layer.liveResultUrl);
  publishLiveSurfacePaintPreview({
    objectId: layer.objectId,
    layerId: layer.layerId,
    target: layer.target === 'projected-mask' ? 'projected-mask' : 'uv-image',
    assetUrl: layer.liveResultUrl,
    composition:
      layer.target === 'projected-mask' ? 'multiply-original-mask' : 'replace',
  });
  return true;
}

function endLiveEraserPreview(layer: UvPaintLayer) {
  layer.liveEraserPreviewActive = false;
  clearLiveSurfacePaintPreview(layer.layerId, layer.liveResultUrl);
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

function SurfacePaintOverlay() {
  const { gl, camera, scene } = useThree();
  const cursorOverlayRef = useRef<SVGSVGElement>();
  const cursorCircleRef = useRef<SVGCircleElement>();
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
  const lastPointerClientRef = useRef<ClientPoint>();
  const pendingPaintTargetsRef = useRef<ClientPoint[]>([]);
  const paintInputFrameRef = useRef<number>();
  const activePointerIdRef = useRef<number>();
  const pointerCancelRecoveryTimerRef = useRef<number>();
  const strokePaintToolRef = useRef<'brush' | 'eraser'>();
  const lastPaintActivityAtRef = useRef(0);
  const strokeTelemetryRef = useRef<StrokeTelemetrySnapshot & { startedAt: number }>();
  const strokeDraftRef = useRef<PaintStrokeDraft>();
  const dirtyTexturesRef = useRef(new Set<THREE.CanvasTexture>());
  const textureUpdateFrameRef = useRef<number>();
  const projectionTextureUpdateTimerRef = useRef<number>();
  const projectionTextureLastUpdateAtRef = useRef(0);
  const projectedEraserBatchesRef = useRef(new Map<string, PendingProjectedEraserBatch>());
  const pointerListenerGenerationRef = useRef(0);
  const localRepaintUvCommitRevisionRef = useRef(0);
  const localRepaintUvCommitChainRef = useRef(Promise.resolve());
  const localRepaintUvScheduleFrameRef = useRef<number>();
  const localRepaintHandoffFrameRef = useRef<number>();
  const localRepaintPreviewTextureIdRef = useRef(createId('local-repaint-source-preview'));
  const paintPreviewRevisionRef = useRef(0);
  const maskDirtyRef = useRef(false);
  const maskHasContentRef = useRef(false);
  const paintMaskCommitRevisionRef = useRef(0);
  const localRepaintSourceImageRef = useRef<{
    url: string;
    image: HTMLImageElement;
    previewImageUrl: string;
    allowedMaskImage?: HTMLImageElement;
  }>();
  const [localRepaintAssetsRevision, setLocalRepaintAssetsRevision] = useState(0);
  const localRepaintCompositeRef = useRef<LocalRepaintCompositeState>();
  const paintTool = useSceneStore((state) => state.paintTool);
  const paintMaskResetRevision = useSceneStore((state) => state.paintMaskResetRevision);
  const paintMaskHasContent = useSceneStore((state) => state.paintMaskHasContent);
  const paintMaskSettings = useSceneStore((state) => state.paintMaskSettings);
  const paintToolSettings = useSceneStore((state) => state.paintToolSettings);
  const textureResolutionSetting = useSettingsStore((state) => state.resolution);
  const localRepaintProjectionSource = useSceneStore((state) => state.localRepaintProjectionSource);
  const setPaintMaskDataUrl = useSceneStore((state) => state.setPaintMaskDataUrl);
  const setOrbitControlsEnabled = useSceneStore((state) => state.setOrbitControlsEnabled);
  const importedModel = useSceneStore((state) => state.importedModel);
  const selectedObjectId = useSceneStore((state) => state.selectedObjectId);
  const activePaintLayer = useLayerStore((state) =>
    state.layers.find((layer) => layer.id === state.activeProjectedLayerId),
  );
  const pushToast = useToastStore((state) => state.pushToast);
  const showPanel = useWorkspaceLayoutStore((state) => state.showPanel);
  const setPanelCollapsed = useWorkspaceLayoutStore((state) => state.setPanelCollapsed);
  const t = useT();
  const isInpaintMode = paintTool === 'inpaint-add' || paintTool === 'inpaint-subtract';
  const isLocalRepaintApplyMode = paintTool === 'inpaint-apply';
  const shouldShowInpaintMask = isInpaintMode || (paintTool === 'none' && paintMaskHasContent);
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

  useEffect(() => {
    const canvas = gl.domElement;
    const parent = canvas.parentElement;
    if (!parent) return;
    const previousInlinePosition = parent.style.position;
    const adjustedParentPosition = window.getComputedStyle(parent).position === 'static';
    if (adjustedParentPosition) parent.style.position = 'relative';

    const svgNamespace = 'http://www.w3.org/2000/svg';
    const overlay = document.createElementNS(svgNamespace, 'svg');
    overlay.setAttribute('aria-hidden', 'true');
    Object.assign(overlay.style, {
      position: 'absolute',
      inset: '0',
      width: '100%',
      height: '100%',
      overflow: 'hidden',
      pointerEvents: 'none',
      zIndex: '4',
    });
    const circle = document.createElementNS(svgNamespace, 'circle');
    circle.setAttribute('cx', '0');
    circle.setAttribute('cy', '0');
    circle.setAttribute('r', '1');
    circle.setAttribute('fill', 'none');
    circle.setAttribute('stroke-width', '2');
    circle.setAttribute('vector-effect', 'non-scaling-stroke');
    circle.setAttribute('visibility', 'hidden');
    overlay.appendChild(circle);
    parent.appendChild(overlay);
    cursorOverlayRef.current = overlay;
    cursorCircleRef.current = circle;

    return () => {
      if (cursorOverlayRef.current === overlay) cursorOverlayRef.current = undefined;
      if (cursorCircleRef.current === circle) cursorCircleRef.current = undefined;
      overlay.remove();
      if (adjustedParentPosition) parent.style.position = previousInlinePosition;
    };
  }, [gl.domElement]);

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
      const paintResolution =
        target === 'uv-image'
          ? UV_TEXTURE_RESOLUTION[textureResolutionSetting]
          : target === 'projected-mask'
            ? UV_MASK_PAINT_RESOLUTION
            : UV_PAINT_RESOLUTION;
      if (
        layerRef.current?.objectId === model.objectId &&
        layerRef.current.layerId === layerId &&
        layerRef.current.target === target &&
        layerRef.current.paintDefaultResolution === paintResolution
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
      const projectionTexture = new THREE.CanvasTexture(projection.canvas);
      projectionTexture.colorSpace = THREE.NoColorSpace;
      projectionTexture.flipY = false;
      projectionTexture.wrapS = THREE.ClampToEdgeWrapping;
      projectionTexture.wrapT = THREE.ClampToEdgeWrapping;
      projectionTexture.minFilter = THREE.LinearFilter;
      projectionTexture.magFilter = THREE.LinearFilter;
      projectionTexture.generateMipmaps = false;
      projectionTexture.needsUpdate = true;
      const paintPreview = createPaintCanvas(UV_STROKE_PREVIEW_RESOLUTION, false);
      const paintPreviewMaterial = createProjectedPaintPreviewMaterial(projectionTexture);
      const liveResult = createPaintCanvas(1, false);
      const liveResultUrl = registerLiveProjectedCanvasTexture(
        `surface-edit-preview:${target}:${layerId}`,
        liveResult.canvas,
        colorSpace,
        { flipY },
      );
      const liveResultTexture = getLiveProjectedCanvasTexture(liveResultUrl, colorSpace, {
        flipY,
      });
      if (!liveResultTexture) throw new Error('Could not create live eraser preview texture.');
      const mask = createPaintCanvas();
      const maskTexture = new THREE.CanvasTexture(mask.canvas);
      configureCanvasTexture(maskTexture, THREE.NoColorSpace);

      const maskMaterial = createInpaintMaskMaterial(projectionTexture);

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
        paintPreviewMaterial,
        liveResultCanvas: liveResult.canvas,
        liveResultContext: liveResult.context,
        liveResultTexture,
        liveResultUrl,
        liveEraserPreviewActive: false,
        paintOverlayTargets: new Set(),
        paintPreviewOverlays: [],
        projectionCanvas: projection.canvas,
        projectionContext: projection.context,
        projectionTexture,
        maskCanvas: mask.canvas,
        maskContext: mask.context,
        maskTexture,
        maskMaterial,
        maskProjectorMatrix: new THREE.Matrix4(),
        maskProjectionReady: false,
        overlayMeshes: [],
        overlayTargets: new Set(),
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
    [paintTool, textureResolutionSetting],
  );

  useEffect(() => {
    if ((paintTool !== 'brush' && paintTool !== 'eraser') || !canUseSurfacePaint) return;
    const model = getTargetModel();
    if (model) getUvPaintLayer(model);
  }, [canUseSurfacePaint, getTargetModel, getUvPaintLayer, paintTool]);

  const ensureOverlayForMesh = useCallback(
    (layer: UvPaintLayer, mesh: THREE.Mesh) => {
      if (layer.overlayTargets.has(mesh)) return;
      layer.overlayTargets.add(mesh);

      const maskOverlay = new THREE.Mesh(mesh.geometry, layer.maskMaterial);
      maskOverlay.name = 'Liclick Projected Inpaint Mask Overlay';
      maskOverlay.userData.liclickPaintOverlay = true;
      maskOverlay.userData.liclickInpaintMaskOverlay = true;
      maskOverlay.userData.liclickInpaintMaskTexture = layer.projectionTexture;
      maskOverlay.visible = shouldShowInpaintMask;
      maskOverlay.renderOrder = INPAINT_MASK_OVERLAY_RENDER_ORDER;
      mesh.add(maskOverlay);
      layer.overlayMeshes.push(maskOverlay);
    },
    [shouldShowInpaintMask],
  );

  const ensureInpaintMaskOverlaysForModel = useCallback(
    (layer: UvPaintLayer, model: SurfacePaintTarget) => {
      // The selection texture lives in screen space and may span several
      // disconnected submeshes even when the pointer itself only raycasts one
      // of them. Include real geometry even when it has no UVs; UV availability
      // is relevant to texture baking, but must not make a visible fitting punch
      // a hole through this screen-space editor overlay.
      const meshes: THREE.Mesh[] = [];
      model.group.traverse((child) => {
        if (!(child instanceof THREE.Mesh)) return;
        if (
          child.userData.liclickPaintOverlay ||
          child.userData.liclickViewportHelper ||
          child.userData.liclickSelectionGlow ||
          child.userData.liclickWireframeOverlay
        )
          return;
        if (!child.geometry.getAttribute('position')) return;
        meshes.push(child);
      });
      meshes.forEach((mesh) => ensureOverlayForMesh(layer, mesh));
    },
    [ensureOverlayForMesh],
  );

  const ensurePaintPreviewOverlayForMesh = useCallback((layer: UvPaintLayer, mesh: THREE.Mesh) => {
    if (layer.paintOverlayTargets.has(mesh)) return;
    layer.paintOverlayTargets.add(mesh);

    const paintOverlay = new THREE.Mesh(mesh.geometry, layer.paintPreviewMaterial);
    paintOverlay.name = 'Liclick UV Paint Stroke Preview';
    paintOverlay.userData.liclickPaintOverlay = true;
    paintOverlay.userData.liclickPaintStrokePreview = true;
    paintOverlay.renderOrder = PAINT_STROKE_PREVIEW_RENDER_ORDER;
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

  const scheduleProjectionTextureUpdate = useCallback(
    (texture: THREE.CanvasTexture, immediate = false, maxFps = 30) => {
      const now = performance.now();
      const minimumIntervalMs = 1000 / Math.max(1, maxFps);
      const remainingMs = minimumIntervalMs - (now - projectionTextureLastUpdateAtRef.current);

      if (immediate || remainingMs <= 0) {
        if (projectionTextureUpdateTimerRef.current !== undefined) {
          window.clearTimeout(projectionTextureUpdateTimerRef.current);
          projectionTextureUpdateTimerRef.current = undefined;
        }
        projectionTextureLastUpdateAtRef.current = now;
        scheduleTextureUpdate(texture);
        return;
      }
      if (projectionTextureUpdateTimerRef.current !== undefined) return;
      projectionTextureUpdateTimerRef.current = window.setTimeout(() => {
        projectionTextureUpdateTimerRef.current = undefined;
        projectionTextureLastUpdateAtRef.current = performance.now();
        scheduleTextureUpdate(texture);
      }, remainingMs);
    },
    [scheduleTextureUpdate],
  );

  const syncInpaintMaskProjection = useCallback(
    (model: SurfacePaintTarget) => {
      const layer = getUvPaintLayer(model);
      if (!hasInpaintProjectionCameraChanged(layer, camera)) return layer;

      const hadMaskContent = maskHasContentRef.current || paintMaskHasContent;
      const rect = gl.domElement.getBoundingClientRect();
      paintMaskCommitRevisionRef.current += 1;
      resizeProjectionCanvas(layer, rect.width / Math.max(rect.height, 1), true);
      layer.maskContext.clearRect(0, 0, layer.maskCanvas.width, layer.maskCanvas.height);
      updateInpaintProjectionCamera(layer, camera);
      layer.paintPreviewMaterial.uniforms.projectionReady.value = 0;
      layer.paintPreviewOverlays.forEach((overlay) => {
        overlay.visible = false;
      });
      layer.overlayMeshes.forEach((mesh) => {
        if (mesh.userData.liclickInpaintMaskOverlay) mesh.visible = true;
      });
      maskDirtyRef.current = false;
      maskHasContentRef.current = false;
      if (hadMaskContent) setPaintMaskDataUrl(undefined, false);
      scheduleTextureUpdate(layer.maskTexture);
      scheduleProjectionTextureUpdate(layer.projectionTexture, true);
      return layer;
    },
    [
      camera,
      getUvPaintLayer,
      gl.domElement,
      paintMaskHasContent,
      scheduleProjectionTextureUpdate,
      scheduleTextureUpdate,
      setPaintMaskDataUrl,
    ],
  );

  // The repaint selection is a 2D mask tied to one capture camera. Keep its
  // projector synchronized while navigating. If the camera changes after the
  // user has painted, discard that stale view mask before accepting strokes in
  // the new view; mixing two camera spaces is what caused the visible offset.
  useFrame(() => {
    if (!isInpaintMode || isPaintingRef.current) return;
    const model = getTargetModel();
    if (model) syncInpaintMaskProjection(model);
  });

  const waitForPaintCommitIdle = useCallback(
    () =>
      new Promise<void>((resolve) => {
        const minimumIdleMs = LOCAL_REPAINT_HIGH_RES_IDLE_MS;
        const tryCommit = () => {
          const idleFor = performance.now() - lastPaintActivityAtRef.current;
          if (isPaintingRef.current || idleFor < minimumIdleMs) {
            window.setTimeout(tryCommit, Math.max(16, Math.min(50, minimumIdleMs - idleFor)));
            return;
          }
          const requestIdle = window.requestIdleCallback;
          if (requestIdle) {
            requestIdle(
              (deadline) => {
                if (
                  isPaintingRef.current ||
                  performance.now() - lastPaintActivityAtRef.current < minimumIdleMs
                ) {
                  tryCommit();
                  return;
                }
                if (!deadline.didTimeout && deadline.timeRemaining() < 12) {
                  tryCommit();
                  return;
                }
                resolve();
              },
              { timeout: 5000 },
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

  useEffect(
    () => () => {
      if (textureUpdateFrameRef.current !== undefined)
        window.cancelAnimationFrame(textureUpdateFrameRef.current);
      textureUpdateFrameRef.current = undefined;
      dirtyTexturesRef.current.clear();
      if (projectionTextureUpdateTimerRef.current !== undefined)
        window.clearTimeout(projectionTextureUpdateTimerRef.current);
      projectionTextureUpdateTimerRef.current = undefined;
      if (localRepaintHandoffFrameRef.current !== undefined)
        window.cancelAnimationFrame(localRepaintHandoffFrameRef.current);
      localRepaintHandoffFrameRef.current = undefined;
      if (localRepaintUvScheduleFrameRef.current !== undefined)
        window.cancelAnimationFrame(localRepaintUvScheduleFrameRef.current);
      localRepaintUvScheduleFrameRef.current = undefined;
      localRepaintUvCommitRevisionRef.current += 1;
      useSceneStore.getState().setLocalRepaintPreviewLayer(undefined);
    },
    [],
  );

  useEffect(() => {
    localRepaintUvCommitRevisionRef.current += 1;
    if (localRepaintHandoffFrameRef.current !== undefined)
      window.cancelAnimationFrame(localRepaintHandoffFrameRef.current);
    localRepaintHandoffFrameRef.current = undefined;
    if (localRepaintUvScheduleFrameRef.current !== undefined)
      window.cancelAnimationFrame(localRepaintUvScheduleFrameRef.current);
    localRepaintUvScheduleFrameRef.current = undefined;
    useSceneStore.getState().setLocalRepaintPreviewLayer(undefined);
    const source = localRepaintProjectionSource;
    localRepaintSourceImageRef.current = undefined;
    localRepaintCompositeRef.current = undefined;
    setLocalRepaintAssetsRevision(0);
    if (!source) {
      return undefined;
    }

    // The former delayed-UV-bake path created an empty merge layer before the
    // first valid stroke. Live projected masks are now authoritative, so remove
    // those obsolete placeholders and migrate their target once during setup.
    const layerState = useLayerStore.getState();
    const obsoleteMergeLayers = layerState.layers.filter(
      (layer) => isLocalRepaintUvMergeLayer(layer, source.objectId) && !layer.imageUrl,
    );
    if (obsoleteMergeLayers.length > 0) {
      const obsoleteIds = new Set(obsoleteMergeLayers.map((layer) => layer.id));
      const nextLayers = layerState.layers.filter((layer) => !obsoleteIds.has(layer.id));
      layerState.setLayers(nextLayers);
      useProjectStore.getState().setProjectLayers(useLayerStore.getState().layers);
      if (source.targetLayerId && obsoleteIds.has(source.targetLayerId)) {
        const belongsToSourceModel = (layer: Layer) =>
          !source.objectId || !layer.objectId || layer.objectId === source.objectId;
        const fallbackTarget = nextLayers.find(
          (layer) =>
            (layer.type === 'uv' || layer.type === 'projected') &&
            Boolean(layer.imageUrl) &&
            belongsToSourceModel(layer) &&
            !isLocalRepaintProjectionLayer(layer),
        );
        useSceneStore.getState().setLocalRepaintProjectionSource({
          ...source,
          targetLayerId: fallbackTarget?.id,
          targetLayerType: fallbackTarget
            ? fallbackTarget.type === 'uv'
              ? 'uv'
              : 'projected'
            : undefined,
          targetLayerName: fallbackTarget?.name,
        });
        return undefined;
      }
    }

    let cancelled = false;
    void Promise.all([
      loadImageElement(source.imageUrl),
      loadImageElement(source.allowedMaskUrl).catch((error) => {
        console.warn(
          '[Liclick 3D Texture] Could not prepare local repaint falloff mask; using unrestricted apply opacity.',
          error,
        );
        return undefined;
      }),
    ])
      .then(([sourceImage, allowedMaskImage]) => {
        if (cancelled) return;
        // Retain the original ComfyUI result for the background UV bake. Do not
        // prime its 4K GPU texture while entering the brush; only the 512px proxy
        // belongs to the interactive material.
        const previewCanvas = createLocalRepaintPreviewCanvas(sourceImage);
        if (cancelled) return;
        const previewImageUrl = previewCanvas
          ? registerLiveProjectedCanvasTexture(
              localRepaintPreviewTextureIdRef.current,
              previewCanvas,
              THREE.SRGBColorSpace,
            )
          : source.imageUrl;
        localRepaintSourceImageRef.current = {
          url: source.imageUrl,
          image: sourceImage,
          previewImageUrl,
          allowedMaskImage,
        };
        localRepaintCompositeRef.current = undefined;
        setLocalRepaintAssetsRevision((revision) => revision + 1);
      })
      .catch((error) => {
        console.warn(
          '[Liclick 3D Texture] Could not prepare local repaint projection source:',
          error,
        );
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
    layer.maskMaterial.uniforms.projectionReady.value = 0;
    scheduleTextureUpdate(layer.maskTexture);
    scheduleTextureUpdate(layer.projectionTexture);
    maskDirtyRef.current = false;
    maskHasContentRef.current = false;
  }, [paintMaskResetRevision, scheduleTextureUpdate]);

  useEffect(() => {
    const layer = layerRef.current;
    if (!layer) return;
    layer.overlayMeshes.forEach((mesh) => {
      if (mesh.userData.liclickInpaintMaskOverlay) mesh.visible = shouldShowInpaintMask;
    });
  }, [paintTool, shouldShowInpaintMask]);

  useEffect(() => {
    if (!isInpaintMode) return;
    const model = getTargetModel();
    if (!model) return;
    const layer = syncInpaintMaskProjection(model);
    ensureInpaintMaskOverlaysForModel(layer, model);

    // Local repaint uses a different capture camera and a dedicated live mask.
    // Rebind the ordinary selection projector as soon as the user switches back.
    layer.paintPreviewMaterial.uniforms.projectionReady.value = 0;
    layer.paintPreviewOverlays.forEach((overlay) => {
      overlay.visible = false;
    });
    layer.overlayMeshes.forEach((mesh) => {
      if (mesh.userData.liclickInpaintMaskOverlay) mesh.visible = true;
    });
  }, [ensureInpaintMaskOverlaysForModel, getTargetModel, isInpaintMode, syncInpaintMaskProjection]);

  const getBrushWorldRadius = useCallback(
    (
      model: SurfacePaintTarget,
      hitPoint?: THREE.Vector3,
      viewportHeight = 1,
      screenRadiusPx = 1,
    ) => {
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
      if (isMaskBrush) {
        const sizeRatio = normalizePaintMaskBrushSize(setting);
        return (
          maxDimension *
          THREE.MathUtils.lerp(
            INPAINT_BRUSH_MIN_WORLD_RADIUS_RATIO,
            INPAINT_BRUSH_MAX_WORLD_RADIUS_RATIO,
            sizeRatio,
          )
        );
      }
      if (hitPoint && camera instanceof THREE.PerspectiveCamera) {
        camera.updateMatrixWorld(true);
        const viewDepth = Math.abs(
          surfaceBrushScratch.projected.copy(hitPoint).applyMatrix4(camera.matrixWorldInverse).z,
        );
        const visibleWorldHeight =
          2 * Math.max(viewDepth, camera.near) * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
        return THREE.MathUtils.clamp(
          (visibleWorldHeight * screenRadiusPx) / Math.max(viewportHeight, 1),
          maxDimension * 0.00005,
          maxDimension * 0.24,
        );
      }
      if (camera instanceof THREE.OrthographicCamera) {
        const visibleWorldHeight = (camera.top - camera.bottom) / Math.max(camera.zoom, 0.0001);
        return THREE.MathUtils.clamp(
          (visibleWorldHeight * screenRadiusPx) / Math.max(viewportHeight, 1),
          maxDimension * 0.00005,
          maxDimension * 0.24,
        );
      }
      return THREE.MathUtils.clamp(
        (maxDimension * setting * 0.5) / 700,
        maxDimension * 0.00005,
        maxDimension * 0.24,
      );
    },
    [
      camera,
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
    if (isMaskBrush) {
      return THREE.MathUtils.lerp(
        INPAINT_BRUSH_MIN_TEXTURE_RADIUS,
        INPAINT_BRUSH_MAX_TEXTURE_RADIUS,
        normalizePaintMaskBrushSize(setting),
      );
    }
    return THREE.MathUtils.clamp(setting * 0.5, 0.5, 128);
  }, [
    paintMaskSettings.brushSize,
    paintTool,
    paintToolSettings.brushSize,
    paintToolSettings.eraserSize,
  ]);

  const raycastModel = useCallback(
    (
      event: Pick<globalThis.PointerEvent, 'clientX' | 'clientY'>,
      cachedRect?: DOMRect,
    ): UvPaintHit | undefined => {
      const model = getTargetModel();
      if (!model) return undefined;
      const rect = cachedRect ?? gl.domElement.getBoundingClientRect();
      const normalizedX = (event.clientX - rect.left) / Math.max(rect.width, 1);
      const normalizedY = (event.clientY - rect.top) / Math.max(rect.height, 1);
      // Pointer capture keeps delivering events after a pen/mouse leaves the
      // canvas. Clamping those coordinates to the viewport edge turns the final
      // sample into a valid surface hit and creates a long diagonal stroke.
      if (normalizedX < 0 || normalizedX > 1 || normalizedY < 0 || normalizedY > 1) {
        return undefined;
      }
      const screenUv = new THREE.Vector2(normalizedX, normalizedY);
      pointerRef.current.set(screenUv.x * 2 - 1, -(screenUv.y * 2 - 1));
      raycasterRef.current.setFromCamera(pointerRef.current, camera);
      const hit = raycasterRef.current.intersectObjects(getPaintableMeshes(model), false)[0];
      if (!hit || !(hit.object instanceof THREE.Mesh) || !hit.face || !hit.uv) return undefined;
      const fallbackTextureRadius = getBrushTextureRadius();
      const isSurfaceMaskBrush = isInpaintMode || isLocalRepaintApplyMode;
      const requestedScreenRadiusPx = isSurfaceMaskBrush
        ? fallbackTextureRadius
        : THREE.MathUtils.clamp(fallbackTextureRadius, 0.5, 128);
      const worldRadius = getBrushWorldRadius(
        model,
        hit.point,
        rect.height,
        requestedScreenRadiusPx,
      );
      const brushTransforms = {
        uvBrush: isSurfaceMaskBrush
          ? createCircularBrushTransform(fallbackTextureRadius)
          : computeUvBrushTransform(hit.object, hit.face, worldRadius, fallbackTextureRadius),
        screenBrush: computeScreenBrushTransform(
          hit.object,
          hit.face,
          hit.point,
          camera,
          worldRadius,
          fallbackTextureRadius,
        ),
      };
      const textureRadius = isSurfaceMaskBrush
        ? fallbackTextureRadius
        : Math.max(brushTransforms.uvBrush.axisX.length(), brushTransforms.uvBrush.axisY.length()) *
          UV_PAINT_RESOLUTION;
      const screenAxisXRadius = Math.hypot(
        brushTransforms.screenBrush.axisX.x * rect.width,
        brushTransforms.screenBrush.axisX.y * rect.height,
      );
      const screenAxisYRadius = Math.hypot(
        brushTransforms.screenBrush.axisY.x * rect.width,
        brushTransforms.screenBrush.axisY.y * rect.height,
      );
      return {
        model,
        hit,
        uv: hit.uv,
        screenUv,
        worldRadius,
        textureRadius,
        ...brushTransforms,
        screenBrushRadiusPx: Math.max(1, Math.min(screenAxisXRadius, screenAxisYRadius)),
      };
    },
    [
      camera,
      getBrushTextureRadius,
      getBrushWorldRadius,
      getPaintableMeshes,
      getTargetModel,
      gl.domElement,
      isInpaintMode,
      isLocalRepaintApplyMode,
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
      const cursor = cursorCircleRef.current;
      if (!cursor) return result;
      if (!result) {
        cursor.setAttribute('visibility', 'hidden');
        gl.domElement.style.cursor = enabled ? 'default' : '';
        return undefined;
      }
      const canvasRect = gl.domElement.getBoundingClientRect();
      const overlayRect = cursorOverlayRef.current?.getBoundingClientRect() ?? canvasRect;
      const centerX = canvasRect.left - overlayRect.left + result.screenUv.x * canvasRect.width;
      const centerY = canvasRect.top - overlayRect.top + result.screenUv.y * canvasRect.height;
      const axisX = result.screenBrush.axisX;
      const axisY = result.screenBrush.axisY;
      cursor.setAttribute(
        'transform',
        `matrix(${axisX.x * canvasRect.width} ${axisX.y * canvasRect.height} ${axisY.x * canvasRect.width} ${axisY.y * canvasRect.height} ${centerX} ${centerY})`,
      );
      cursor.setAttribute('stroke', getCursorColor());
      cursor.setAttribute('visibility', 'visible');
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

  const drawSurfaceBrushSegment = useCallback(
    (
      context: CanvasRenderingContext2D,
      texture: THREE.CanvasTexture | undefined,
      from: THREE.Vector2 | undefined,
      to: THREE.Vector2,
      brush: BrushStampTransform,
      color: string,
      compositeOperation: GlobalCompositeOperation,
      coordinateSpace: 'uv' | 'screen',
      automaticFadeValue?: number,
      paintHardness?: number,
    ) => {
      const width = context.canvas.width;
      const height = context.canvas.height;
      const normalizeX =
        coordinateSpace === 'uv'
          ? (value: number) => THREE.MathUtils.euclideanModulo(value, 1)
          : (value: number) => THREE.MathUtils.clamp(value, 0, 1);
      const normalizeY = normalizeX;
      const toNormalizedX = normalizeX(to.x);
      const toNormalizedY = normalizeY(to.y);
      const fromNormalizedX = from ? normalizeX(from.x) : toNormalizedX;
      const fromNormalizedY = from ? normalizeY(from.y) : toNormalizedY;
      const toX = toNormalizedX * width;
      const toY = (coordinateSpace === 'uv' ? 1 - toNormalizedY : toNormalizedY) * height;
      const fromX = fromNormalizedX * width;
      const fromY = (coordinateSpace === 'uv' ? 1 - fromNormalizedY : fromNormalizedY) * height;
      const yDirection = coordinateSpace === 'uv' ? -1 : 1;
      const transformA = brush.axisX.x * width;
      const transformB = brush.axisX.y * height * yDirection;
      const transformC = brush.axisY.x * width;
      const transformD = brush.axisY.y * height * yDirection;
      const axisXRadius = Math.hypot(transformA, transformB);
      const axisYRadius = Math.hypot(transformC, transformD);
      if (
        !Number.isFinite(axisXRadius) ||
        !Number.isFinite(axisYRadius) ||
        axisXRadius < 0.05 ||
        axisYRadius < 0.05
      ) {
        return createDirtyRect(fromX, fromY, toX, toY, 1, width, height);
      }
      const extentX = Math.hypot(transformA, transformC);
      const extentY = Math.hypot(transformB, transformD);
      const distance = Math.hypot(toX - fromX, toY - fromY);
      const stampSpacing = Math.max(1, Math.min(axisXRadius, axisYRadius) * 0.45);
      const segmentCount =
        distance <= 0.01 ? 0 : Math.min(64, Math.max(1, Math.ceil(distance / stampSpacing)));
      const automaticFadeStamp =
        automaticFadeValue === undefined
          ? undefined
          : getAutomaticFadeBrushStamp(automaticFadeValue);
      const paintStamp =
        automaticFadeStamp || paintHardness === undefined
          ? undefined
          : getPaintBrushStamp(color, paintHardness);
      const brushStamp = automaticFadeStamp ?? paintStamp;

      context.save();
      context.globalCompositeOperation = compositeOperation;
      context.fillStyle = color;
      for (let index = 0; index <= segmentCount; index += 1) {
        const ratio = segmentCount === 0 ? 1 : index / segmentCount;
        const centerX = THREE.MathUtils.lerp(fromX, toX, ratio);
        const centerY = THREE.MathUtils.lerp(fromY, toY, ratio);
        context.setTransform(transformA, transformB, transformC, transformD, centerX, centerY);
        if (brushStamp) {
          context.drawImage(brushStamp, -1, -1, 2, 2);
        } else {
          context.beginPath();
          context.arc(0, 0, 1, 0, Math.PI * 2);
          context.fill();
        }
      }
      context.restore();
      if (texture) scheduleTextureUpdate(texture);
      return createDirtyRect(fromX, fromY, toX, toY, Math.max(extentX, extentY), width, height);
    },
    [scheduleTextureUpdate],
  );

  const getStrokeSourceUv = useCallback((result: UvPaintHit) => {
    const previous = lastSampleRef.current;
    if (!previous || !(result.hit.object instanceof THREE.Mesh)) return undefined;
    const sameMesh = previous.meshUuid === result.hit.object.uuid;
    const sameFace =
      sameMesh && previous.faceIndex !== undefined && previous.faceIndex === result.hit.faceIndex;
    // Screen-space input is densely raycast below. Connect samples only while
    // they remain on the same projected triangle; crossing a triangle/UV seam
    // is represented by overlapping stamps instead of a line through the UV
    // atlas. This is the same projection rule used by the live preview.
    return sameFace ? previous.uv : undefined;
  }, []);

  const ensureLiveLocalRepaintComposite = useCallback(
    (model: SurfacePaintTarget, sourceOverride?: LocalRepaintProjectionSource) => {
      const localRepaintSource = sourceOverride ?? localRepaintProjectionSource;
      const sourceImage = localRepaintSourceImageRef.current?.image;
      if (!localRepaintSource || !sourceImage) return undefined;
      const sourceWidth = sourceImage.naturalWidth || sourceImage.width;
      const sourceHeight = sourceImage.naturalHeight || sourceImage.height;
      if (sourceWidth <= 0 || sourceHeight <= 0) return undefined;
      // The pointer path is rasterized at PROJECTION_PAINT_MAX_SIZE, so keeping a
      // source-resolution mask adds no detail and forces a multi-megabyte canvas
      // upload after every stroke. Keep the live mask at the same screen-space
      // resolution and let the shader sample it linearly. The final UV result is
      // baked separately from the untouched high-resolution source; this smaller
      // canvas controls only interactive feedback and avoids dense uploads while
      // the pointer is moving.
      const sourceAspect = sourceWidth / Math.max(sourceHeight, 1);
      const width =
        sourceAspect >= 1
          ? LOCAL_REPAINT_LIVE_MASK_MAX_SIZE
          : Math.max(1, Math.round(LOCAL_REPAINT_LIVE_MASK_MAX_SIZE * sourceAspect));
      const height =
        sourceAspect >= 1
          ? Math.max(1, Math.round(LOCAL_REPAINT_LIVE_MASK_MAX_SIZE / sourceAspect))
          : LOCAL_REPAINT_LIVE_MASK_MAX_SIZE;

      model.group.updateMatrixWorld(true);
      const sourceKey = createLocalRepaintSourceKey(localRepaintSource, model.objectId);
      const currentLayers = useLayerStore.getState().layers;
      const existingLayer = currentLayers.find((item) =>
        isMatchingLocalRepaintProjectionLayer(item, localRepaintSource, model.objectId),
      );
      let composite = localRepaintCompositeRef.current;
      const layerId =
        existingLayer?.id ??
        (composite?.sourceKey === sourceKey
          ? composite.layerId
          : createId(LOCAL_REPAINT_PROJECTION_LAYER_ID_PREFIX));
      if (
        !composite ||
        composite.sourceKey !== sourceKey ||
        composite.layerId !== layerId ||
        composite.maskCanvas.width !== width ||
        composite.maskCanvas.height !== height
      ) {
        composite = createLocalRepaintComposite(
          sourceKey,
          layerId,
          width,
          height,
          localRepaintSourceImageRef.current?.allowedMaskImage,
        );
        localRepaintCompositeRef.current = composite;
        const savedMaskUrl = existingLayer?.maskUrl;
        if (composite && savedMaskUrl && savedMaskUrl !== composite.maskUrl) {
          composite.restoredMaskUrl = savedMaskUrl;
          const restoreSavedMask = (image: CanvasImageSource) => {
            if (
              localRepaintCompositeRef.current !== composite ||
              composite?.restoredMaskUrl !== savedMaskUrl
            )
              return;
            composite.maskContext.save();
            composite.maskContext.globalCompositeOperation = 'lighten';
            composite.maskContext.drawImage(
              image,
              0,
              0,
              composite.maskCanvas.width,
              composite.maskCanvas.height,
            );
            composite.maskContext.restore();
            markLiveProjectedCanvasTextureUpdated(composite.maskUrl);
          };
          const savedLiveCanvas = getLiveProjectedCanvasState(savedMaskUrl)?.canvas;
          if (savedLiveCanvas) restoreSavedMask(savedLiveCanvas);
          else {
            void loadImageElement(savedMaskUrl)
              .then(restoreSavedMask)
              .catch((error) => {
                console.warn('[Liclick 3D Texture] Could not restore local repaint mask:', error);
              });
          }
        }
      }
      if (!composite) return undefined;
      updateLocalRepaintProjectionMatrix(composite, model, localRepaintSource);

      const projectedLayer: Layer = {
        ...existingLayer,
        id: layerId,
        name: localRepaintSource.targetLayerName
          ? `${localRepaintSource.targetLayerName} · 局部替换`
          : (localRepaintSource.name ?? 'Local repaint brush'),
        type: 'projected',
        imageUrl:
          localRepaintSourceImageRef.current?.previewImageUrl ?? localRepaintSource.imageUrl,
        maskUrl: composite.maskUrl,
        depthUrl: localRepaintSource.depthUrl,
        objectId: localRepaintSource.objectId ?? model.objectId,
        objectMatrixWorld:
          localRepaintSource.objectMatrixWorld ?? model.group.matrixWorld.toArray(),
        camera: localRepaintSource.camera,
        generationId: localRepaintSource.generationId,
        captureId: localRepaintSource.captureId,
        replacementTargetLayerId: localRepaintSource.targetLayerId,
        renderedColor: true,
        minimumProjectionFacing: LOCAL_REPAINT_MINIMUM_FACE_ON,
        isBaked: false,
        needsRebake: true,
        visible: true,
        opacity: 1,
        strength: 1,
        blendMode: 'overlay',
        adjustments: { hue: 0, saturation: 0, lightness: 0 },
        order: 0,
        createdAt: existingLayer?.createdAt ?? new Date().toISOString(),
      };
      // Keep the interactive projection out of the persisted layer stack. It is
      // renderer-only state, so pointer-down no longer creates a temporary row or
      // forces the UV layer compositor to rebuild.
      const sceneState = useSceneStore.getState();
      const currentPreviewLayer = sceneState.localRepaintPreviewLayer;
      const previewAlreadyPublished =
        currentPreviewLayer?.id === projectedLayer.id &&
        currentPreviewLayer.imageUrl === projectedLayer.imageUrl &&
        currentPreviewLayer.maskUrl === projectedLayer.maskUrl &&
        currentPreviewLayer.depthUrl === projectedLayer.depthUrl &&
        currentPreviewLayer.objectId === projectedLayer.objectId &&
        currentPreviewLayer.generationId === projectedLayer.generationId &&
        currentPreviewLayer.captureId === projectedLayer.captureId &&
        currentPreviewLayer.opacity === projectedLayer.opacity &&
        currentPreviewLayer.minimumProjectionFacing === projectedLayer.minimumProjectionFacing &&
        currentPreviewLayer.replacementTargetLayerId === projectedLayer.replacementTargetLayerId;
      // Re-publishing an equivalent object makes SceneRoot rebuild the projected
      // layer inputs and can compile/rebind materials at pointer-down. The live
      // canvas texture is mutable, so one published layer is enough for every
      // subsequent stamp in the same repaint session.
      if (!previewAlreadyPublished) sceneState.setLocalRepaintPreviewLayer(projectedLayer);
      return composite;
    },
    [localRepaintProjectionSource],
  );

  // The target layer is bound when the user enters apply mode. Never mutate it
  // from a pointer event: doing so resets decoded assets and rebuilds materials
  // in the middle of the first stroke, which makes feedback arrive seconds late.
  const resolveLocalRepaintStrokeSource = useCallback(
    () => localRepaintProjectionSource,
    [localRepaintProjectionSource],
  );

  useEffect(() => {
    if (!localRepaintProjectionSource || localRepaintAssetsRevision <= 0) return undefined;
    let cancelled = false;
    let timeoutId: number | undefined;
    const prepare = () => {
      if (cancelled) return;
      if (isPaintingRef.current) {
        timeoutId = window.setTimeout(prepare, 80);
        return;
      }
      const model = getTargetModel();
      if (!model || !localRepaintSourceImageRef.current) return;
      const source = resolveLocalRepaintStrokeSource();
      if (source) ensureLiveLocalRepaintComposite(model, source);
    };
    // Publish the empty lightweight projection on the very next frame. Waiting
    // for requestIdleCallback left shader/material creation until the first
    // brush gesture on busy scenes, so a valid stroke could remain invisible
    // for several frames while the projected material was being prepared.
    const frameId = window.requestAnimationFrame(prepare);
    return () => {
      cancelled = true;
      if (frameId !== undefined) window.cancelAnimationFrame(frameId);
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
    };
  }, [
    ensureLiveLocalRepaintComposite,
    getTargetModel,
    localRepaintAssetsRevision,
    localRepaintProjectionSource,
    resolveLocalRepaintStrokeSource,
  ]);

  const hasLocalRepaintSourceContent = useCallback(
    (_screenUv: THREE.Vector2) => Boolean(localRepaintSourceImageRef.current),
    [],
  );

  const canConnectLocalRepaintStroke = useCallback(
    (from: THREE.Vector2 | undefined, to: THREE.Vector2) => {
      if (!from) return false;
      if (!localRepaintSourceImageRef.current) return false;
      // Both points have already been projected inside the generated view. The
      // complete ComfyUI frame is the editable source, so no per-frame pixel
      // probes or full-image readback are needed here.
      return Number.isFinite(to.x) && Number.isFinite(to.y);
    },
    [],
  );

  const paintAt = useCallback(
    (result: UvPaintHit, pressure = 1, strokePaintTool = paintTool) => {
      const pressureSizeScale = getPressureSizeScale(pressure);
      // Surface masks consume the projected footprint; ordinary paint consumes
      // the UV-density-aware footprint computed for the current triangle. The
      // visible brush/eraser feedback still uses the screen projection below.
      const usesSurfaceBrush =
        strokePaintTool === 'inpaint-add' ||
        strokePaintTool === 'inpaint-subtract' ||
        strokePaintTool === 'inpaint-apply';
      const screenBrush = scaleBrushTransform(result.screenBrush, pressureSizeScale);
      const uvBrush = usesSurfaceBrush
        ? result.uvBrush
        : scaleBrushTransform(result.uvBrush, pressureSizeScale);
      // Local repaint owns its dedicated 320px live mask and does not need the
      // ordinary UV/mask painting resource bundle. Avoid even looking that
      // bundle up on the high-frequency path.
      const layer = strokePaintTool === 'inpaint-apply' ? undefined : getUvPaintLayer(result.model);
      const previousSample = lastSampleRef.current;
      const usesProjectionStroke = isInpaintMode || isLocalRepaintApplyMode;
      const fromUv = usesProjectionStroke ? undefined : getStrokeSourceUv(result);
      if (!usesProjectionStroke && !fromUv && previousSample && strokeTelemetryRef.current) {
        strokeTelemetryRef.current.continuityBreaks += 1;
      }
      // Selection masks use the current viewport, while local repaint is
      // rasterized below in the generated image's capture-camera coordinates.
      const previousScreenUv = lastSampleRef.current?.screenUv;
      const fromScreenUv = isInpaintMode ? previousScreenUv : fromUv ? previousScreenUv : undefined;
      let localRepaintUv: THREE.Vector2 | undefined;
      if (strokePaintTool === 'brush') {
        if (!layer) return;
        if (result.hit.object instanceof THREE.Mesh) {
          ensurePaintPreviewOverlayForMesh(layer, result.hit.object);
          layer.paintPreviewOverlays.forEach((overlay) => {
            overlay.visible = true;
          });
        }
        drawSurfaceBrushSegment(
          layer.projectionContext,
          undefined,
          fromScreenUv,
          result.screenUv,
          screenBrush,
          '#ffffff',
          'source-over',
          'screen',
          undefined,
          paintToolSettings.brushHardness,
        );
        // Pointer samples are already collapsed to one surface hit per display
        // frame. Upload the live projection on that same frame instead of putting
        // it through the shared 30 fps projection throttle. scheduleTextureUpdate
        // still coalesces every stamp into at most one GPU upload per frame.
        scheduleTextureUpdate(layer.projectionTexture);
        const bounds = drawSurfaceBrushSegment(
          layer.paintPreviewContext,
          undefined,
          fromUv,
          result.uv,
          uvBrush,
          paintToolSettings.color,
          'source-over',
          'uv',
          undefined,
          paintToolSettings.brushHardness,
        );
        if (strokeDraftRef.current?.target === 'paint') {
          strokeDraftRef.current.paintSegments?.push({
            fromUv: fromUv?.clone(),
            toUv: result.uv.clone(),
            brush: {
              axisX: uvBrush.axisX.clone(),
              axisY: uvBrush.axisY.clone(),
            },
            color: paintToolSettings.color,
            hardness: paintToolSettings.brushHardness,
          });
        }
        if (strokeDraftRef.current?.target === 'paint') {
          strokeDraftRef.current.bounds = unionDirtyRect(strokeDraftRef.current.bounds, bounds);
        }
      } else if (strokePaintTool === 'eraser') {
        if (!layer) return;
        if (result.hit.object instanceof THREE.Mesh) {
          ensurePaintPreviewOverlayForMesh(layer, result.hit.object);
          layer.paintPreviewOverlays.forEach((overlay) => {
            overlay.visible = !layer.liveEraserPreviewActive;
          });
        }
        drawSurfaceBrushSegment(
          layer.projectionContext,
          undefined,
          fromScreenUv,
          result.screenUv,
          screenBrush,
          '#ffffff',
          'source-over',
          'screen',
          undefined,
          paintToolSettings.eraserHardness,
        );
        scheduleTextureUpdate(layer.projectionTexture);
        if (layer.liveEraserPreviewActive) {
          drawSurfaceBrushSegment(
            layer.liveResultContext,
            layer.liveResultTexture,
            fromUv,
            result.uv,
            uvBrush,
            '#ffffff',
            'destination-out',
            'uv',
            undefined,
            paintToolSettings.eraserHardness,
          );
        }
        const bounds = drawSurfaceBrushSegment(
          layer.paintPreviewContext,
          undefined,
          fromUv,
          result.uv,
          uvBrush,
          '#ffffff',
          'source-over',
          'uv',
          undefined,
          paintToolSettings.eraserHardness,
        );
        if (strokeDraftRef.current?.target === 'paint') {
          strokeDraftRef.current.paintSegments?.push({
            fromUv: fromUv?.clone(),
            toUv: result.uv.clone(),
            brush: {
              axisX: uvBrush.axisX.clone(),
              axisY: uvBrush.axisY.clone(),
            },
            color: '#ffffff',
            hardness: paintToolSettings.eraserHardness,
          });
        }
        if (strokeDraftRef.current?.target === 'paint') {
          strokeDraftRef.current.bounds = unionDirtyRect(strokeDraftRef.current.bounds, bounds);
        }
      } else if (strokePaintTool === 'inpaint-add') {
        if (!layer) return;
        if (result.hit.object instanceof THREE.Mesh) ensureOverlayForMesh(layer, result.hit.object);
        const projectionBounds = drawSurfaceBrushSegment(
          layer.projectionContext,
          undefined,
          fromScreenUv,
          result.screenUv,
          screenBrush,
          '#ffffff',
          'source-over',
          'screen',
          255,
        );
        scheduleTextureUpdate(layer.projectionTexture);
        if (strokeDraftRef.current?.target === 'mask') {
          strokeDraftRef.current.bounds = unionDirtyRect(
            strokeDraftRef.current.bounds,
            projectionBounds,
          );
        }
        maskDirtyRef.current = true;
        maskHasContentRef.current = true;
      } else if (strokePaintTool === 'inpaint-subtract') {
        if (!layer) return;
        if (result.hit.object instanceof THREE.Mesh) ensureOverlayForMesh(layer, result.hit.object);
        const projectionBounds = drawSurfaceBrushSegment(
          layer.projectionContext,
          undefined,
          fromScreenUv,
          result.screenUv,
          screenBrush,
          '#ffffff',
          'destination-out',
          'screen',
          255,
        );
        scheduleTextureUpdate(layer.projectionTexture);
        if (strokeDraftRef.current?.target === 'mask') {
          strokeDraftRef.current.bounds = unionDirtyRect(
            strokeDraftRef.current.bounds,
            projectionBounds,
          );
        }
        maskDirtyRef.current = true;
      } else if (strokePaintTool === 'inpaint-apply') {
        const draft = strokeDraftRef.current;
        const composite = draft?.localRepaintComposite;
        const surfaceFacesProjector =
          composite &&
          result.hit.object instanceof THREE.Mesh &&
          result.hit.face &&
          isLocalRepaintSurfaceFacingProjector(
            composite,
            result.hit.object,
            result.hit.face,
            result.hit.point,
          );
        localRepaintUv = composite
          ? projectWorldPointToLocalRepaintUv(result.hit.point, composite.worldToSourceClip)
          : undefined;
        if (
          !draft?.localRepaintSource ||
          !localRepaintSourceImageRef.current ||
          !composite ||
          !surfaceFacesProjector ||
          !localRepaintUv ||
          !hasLocalRepaintSourceContent(localRepaintUv)
        ) {
          lastUvRef.current = undefined;
          lastSampleRef.current = undefined;
          return;
        }
        // Projection masks are sampled as grayscale by both the live material and
        // the UV bake path, so encode brush opacity in RGB instead of canvas alpha.
        const opacityByte = Math.round(
          THREE.MathUtils.clamp(paintMaskSettings.brushOpacity / 100, 0, 1) * 255,
        );
        const previousLocalRepaintUv = lastSampleRef.current?.localRepaintUv;
        const fromLocalRepaintUv = canConnectLocalRepaintStroke(
          previousLocalRepaintUv,
          localRepaintUv,
        )
          ? previousLocalRepaintUv
          : undefined;
        const localRepaintBrush =
          result.hit.object instanceof THREE.Mesh && result.hit.face
            ? computeLocalRepaintBrushTransform(
                result.hit.object,
                result.hit.face,
                result.hit.point,
                composite.worldToSourceClip,
                result.worldRadius,
                result.textureRadius,
              )
            : screenBrush;
        const projectionBounds = drawSurfaceBrushSegment(
          composite.scratchContext,
          undefined,
          fromLocalRepaintUv,
          localRepaintUv,
          localRepaintBrush,
          `rgb(${opacityByte}, ${opacityByte}, ${opacityByte})`,
          'lighten',
          'screen',
          opacityByte,
        );
        if (strokeDraftRef.current?.target === 'apply-local-repaint') {
          strokeDraftRef.current.bounds = unionDirtyRect(
            strokeDraftRef.current.bounds,
            projectionBounds,
          );
          // The soft brush stamp is merged directly across the generated view.
          // Its radial alpha keeps the automatic edge fade, while the projected
          // UV and returned image alpha still reject pixels outside valid content.
          mergeLocalRepaintScratchPatch(composite, projectionBounds);
          // This mask is only 288px. Upload it on the same RAF as the stamp so
          // every accepted sample has immediate visual feedback. paintAt already
          // runs at most once per display frame for projected strokes, so setting
          // needsUpdate directly does not add duplicate uploads and avoids
          // scheduling the actual texture change one frame later.
          composite.maskTexture.needsUpdate = true;
        }
      }

      lastUvRef.current?.copy(result.uv);
      if (!lastUvRef.current) lastUvRef.current = result.uv.clone();
      if (result.hit.object instanceof THREE.Mesh) {
        const sample = lastSampleRef.current;
        if (sample) {
          sample.meshUuid = result.hit.object.uuid;
          sample.faceIndex = result.hit.faceIndex ?? undefined;
          sample.uv.copy(result.uv);
          sample.screenUv.copy(result.screenUv);
          sample.localRepaintUv = localRepaintUv?.clone();
          sample.point.copy(result.hit.point);
          sample.screenBrushRadiusPx = result.screenBrushRadiusPx;
        } else {
          lastSampleRef.current = {
            meshUuid: result.hit.object.uuid,
            faceIndex: result.hit.faceIndex ?? undefined,
            uv: result.uv.clone(),
            screenUv: result.screenUv.clone(),
            localRepaintUv: localRepaintUv?.clone(),
            point: result.hit.point.clone(),
            screenBrushRadiusPx: result.screenBrushRadiusPx,
          };
        }
      } else {
        lastSampleRef.current = undefined;
      }
    },
    [
      canConnectLocalRepaintStroke,
      drawSurfaceBrushSegment,
      ensureOverlayForMesh,
      ensurePaintPreviewOverlayForMesh,
      getStrokeSourceUv,
      getUvPaintLayer,
      hasLocalRepaintSourceContent,
      isInpaintMode,
      isLocalRepaintApplyMode,
      paintTool,
      paintMaskSettings.brushOpacity,
      paintToolSettings.brushHardness,
      paintToolSettings.color,
      paintToolSettings.eraserHardness,
      scheduleTextureUpdate,
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
    const hasContent = Boolean(layer && maskHasContentRef.current);
    const revision = paintMaskCommitRevisionRef.current + 1;
    paintMaskCommitRevisionRef.current = revision;
    if (!layer || !hasContent) {
      setPaintMaskDataUrl(undefined, false);
      return;
    }
    void projectionMaskToDataUrl(layer.projectionCanvas)
      .then((maskUrl) => {
        if (paintMaskCommitRevisionRef.current !== revision) return;
        setPaintMaskDataUrl(maskUrl, true);
      })
      .catch((error) => {
        console.warn('[Liclick 3D Texture] Could not encode the painted mask.', error);
      });
  }, [isLocalRepaintApplyMode, setPaintMaskDataUrl]);

  const beginStrokeHistory = useCallback(
    (result: UvPaintHit, strokePaintTool = paintTool) => {
      const target = isInpaintMode
        ? 'mask'
        : isLocalRepaintApplyMode
          ? 'apply-local-repaint'
          : 'paint';
      // Invalidate an older high-resolution handoff as soon as a new gesture
      // begins, rather than waiting for pointer-up. The live 512px proxy remains
      // authoritative until the newest accumulated mask receives its 4K bake.
      if (target === 'apply-local-repaint') {
        localRepaintUvCommitRevisionRef.current += 1;
      }
      const layer = target === 'apply-local-repaint' ? undefined : getUvPaintLayer(result.model);
      const localRepaintSource =
        target === 'apply-local-repaint' ? resolveLocalRepaintStrokeSource() : undefined;
      const preparedLocalRepaintComposite =
        target === 'apply-local-repaint' &&
        localRepaintSource &&
        localRepaintCompositeRef.current?.sourceKey ===
          createLocalRepaintSourceKey(localRepaintSource, result.model.objectId)
          ? localRepaintCompositeRef.current
          : undefined;
      const localRepaintComposite =
        target === 'apply-local-repaint' && localRepaintSource
          ? (preparedLocalRepaintComposite ??
            ensureLiveLocalRepaintComposite(result.model, localRepaintSource))
          : undefined;
      if (target === 'mask') {
        if (!layer) return;
        ensureInpaintMaskOverlaysForModel(layer, result.model);
        layer.overlayMeshes.forEach((mesh) => {
          if (mesh.userData.liclickInpaintMaskOverlay) mesh.visible = true;
        });
      }
      if (target === 'paint') {
        if (!layer) return;
        const usesLiveEraserPreview =
          strokePaintTool === 'eraser' && beginLiveEraserPreview(layer);
        if (strokePaintTool !== 'eraser') endLiveEraserPreview(layer);
        const previewRevision = paintPreviewRevisionRef.current + 1;
        paintPreviewRevisionRef.current = previewRevision;
        layer.paintPreviewContext.clearRect(
          0,
          0,
          layer.paintPreviewCanvas.width,
          layer.paintPreviewCanvas.height,
        );
        const rect = gl.domElement.getBoundingClientRect();
        resizeProjectionCanvas(layer, rect.width / Math.max(rect.height, 1));
        updateInpaintProjectionCamera(layer, camera);
        const previewUniforms = layer.paintPreviewMaterial.uniforms;
        (previewUniforms.previewColor.value as THREE.Color).set(
          strokePaintTool === 'eraser' ? '#ffffff' : paintToolSettings.color,
        );
        previewUniforms.previewOpacity.value =
          strokePaintTool === 'eraser' ? (usesLiveEraserPreview ? 0 : 0.82) : 1;
        previewUniforms.projectionReady.value = 1;
        layer.paintPreviewOverlays.forEach((overlay) => {
          overlay.visible = false;
        });
      } else if (target === 'mask' && !maskHasContentRef.current && layer) {
        const rect = gl.domElement.getBoundingClientRect();
        resizeProjectionCanvas(layer, rect.width / Math.max(rect.height, 1));
        updateInpaintProjectionCamera(layer, camera);
        scheduleTextureUpdate(layer.projectionTexture);
      }
      strokeDraftRef.current = {
        layer,
        target,
        paintOperation:
          target === 'paint' && strokePaintTool === 'eraser'
            ? 'eraser'
            : target === 'paint'
              ? 'brush'
              : undefined,
        previewRevision: target === 'paint' ? paintPreviewRevisionRef.current : undefined,
        paintSegments: target === 'paint' ? [] : undefined,
        localRepaintSource,
        localRepaintComposite,
      };
    },
    [
      getUvPaintLayer,
      camera,
      gl.domElement,
      ensureInpaintMaskOverlaysForModel,
      ensureLiveLocalRepaintComposite,
      isInpaintMode,
      isLocalRepaintApplyMode,
      paintTool,
      paintToolSettings.color,
      resolveLocalRepaintStrokeSource,
      scheduleTextureUpdate,
    ],
  );

  const handoffLocalRepaintPreview = useCallback(
    (composite: LocalRepaintCompositeState, sourceKey: string, commitRevision: number) => {
      if (localRepaintHandoffFrameRef.current !== undefined)
        window.cancelAnimationFrame(localRepaintHandoffFrameRef.current);
      const startedAt = performance.now();
      const finish = () => {
        const currentPreview = useSceneStore.getState().localRepaintPreviewLayer;
        if (currentPreview?.id === composite.layerId) {
          useSceneStore.getState().setLocalRepaintPreviewLayer(undefined);
        }
        if (localRepaintCompositeRef.current === composite) {
          composite.maskContext.clearRect(
            0,
            0,
            composite.maskCanvas.width,
            composite.maskCanvas.height,
          );
          composite.scratchContext.clearRect(
            0,
            0,
            composite.scratchCanvas.width,
            composite.scratchCanvas.height,
          );
        }
        localRepaintHandoffFrameRef.current = undefined;
      };
      const step = (now: number) => {
        const currentPreview = useSceneStore.getState().localRepaintPreviewLayer;
        const superseded =
          localRepaintUvCommitRevisionRef.current !== commitRevision ||
          localRepaintCompositeRef.current?.sourceKey !== sourceKey ||
          isPaintingRef.current;
        if (superseded) {
          if (currentPreview?.id === composite.layerId && currentPreview.opacity !== 1) {
            useSceneStore.getState().setLocalRepaintPreviewLayer({ ...currentPreview, opacity: 1 });
          }
          localRepaintHandoffFrameRef.current = undefined;
          return;
        }
        if (!currentPreview || currentPreview.id !== composite.layerId) {
          finish();
          return;
        }
        const progress = THREE.MathUtils.clamp(
          (now - startedAt) / LOCAL_REPAINT_HANDOFF_DURATION_MS,
          0,
          1,
        );
        if (progress >= 1) {
          finish();
          return;
        }
        useSceneStore
          .getState()
          .setLocalRepaintPreviewLayer({ ...currentPreview, opacity: 1 - progress });
        localRepaintHandoffFrameRef.current = window.requestAnimationFrame(step);
      };
      localRepaintHandoffFrameRef.current = window.requestAnimationFrame(step);
    },
    [],
  );

  const queueLocalRepaintUvCommit = useCallback(
    (
      model: SurfacePaintTarget,
      source: LocalRepaintProjectionSource,
      composite: LocalRepaintCompositeState,
    ) => {
      if (!LOCAL_REPAINT_INTERACTIVE_UV_BAKE_ENABLED) {
        const layerState = useLayerStore.getState();
        const currentLayers = layerState.layers;
        const existingProjectionLayer = currentLayers.find((item) =>
          isMatchingLocalRepaintProjectionLayer(item, source, model.objectId),
        );
        const previewLayer = useSceneStore.getState().localRepaintPreviewLayer;
        const persistedLayer: Layer = {
          ...(previewLayer?.id === composite.layerId ? previewLayer : existingProjectionLayer),
          id: composite.layerId,
          name: source.targetLayerName
            ? `${source.targetLayerName} · 局部替换`
            : (source.name ?? 'Local repaint brush'),
          type: 'projected',
          // The renderer preview uses a downscaled source image, but persistence
          // keeps the original result. Export will sample this image and the
          // lightweight live mask when it performs the final-resolution UV bake.
          imageUrl: source.imageUrl,
          maskUrl: composite.maskUrl,
          depthUrl: source.depthUrl,
          objectId: source.objectId ?? model.objectId,
          objectMatrixWorld: source.objectMatrixWorld ?? model.group.matrixWorld.toArray(),
          camera: source.camera,
          generationId: source.generationId,
          captureId: source.captureId,
          replacementTargetLayerId: source.targetLayerId,
          renderedColor: true,
          minimumProjectionFacing: LOCAL_REPAINT_MINIMUM_FACE_ON,
          isBaked: false,
          needsRebake: true,
          visible: true,
          opacity: 1,
          strength: 1,
          blendMode: 'overlay',
          adjustments: existingProjectionLayer?.adjustments ?? {
            hue: 0,
            saturation: 0,
            lightness: 0,
          },
          order: 0,
          contentRevision: (existingProjectionLayer?.contentRevision ?? 0) + 1,
          createdAt: existingProjectionLayer?.createdAt ?? new Date().toISOString(),
        };
        const retainedLayers = currentLayers.filter(
          (item) =>
            item.id !== persistedLayer.id &&
            !isMatchingLocalRepaintProjectionLayer(item, source, model.objectId) &&
            !isLocalRepaintUvMergeLayer(item, model.objectId),
        );
        layerState.setLayers([persistedLayer, ...retainedLayers]);
        useLayerStore.getState().setActiveLayer(persistedLayer.id);
        useProjectStore.getState().setProjectLayers(useLayerStore.getState().layers);
        return;
      }

      const commitRevision = localRepaintUvCommitRevisionRef.current + 1;
      localRepaintUvCommitRevisionRef.current = commitRevision;
      const sourceKey = composite.sourceKey;
      const previewLayerId = composite.layerId;
      const currentLayers = useLayerStore.getState().layers;
      const currentMergeLayer = currentLayers.find((item) =>
        isLocalRepaintUvMergeLayer(item, model.objectId),
      );
      const mergeLayerId =
        currentMergeLayer?.id ?? createId(LOCAL_REPAINT_UV_MERGE_LAYER_ID_PREFIX);
      // The mask contains only strokes that have not reached UV yet. Freeze it
      // synchronously, then keep drawing into the live canvas while this snapshot
      // is processed in the serialized background queue.
      const maskSnapshot = copyCanvasRect(composite.maskCanvas, {
        x: 0,
        y: 0,
        width: composite.maskCanvas.width,
        height: composite.maskCanvas.height,
      });
      if (!currentMergeLayer) {
        // The live projection is renderer-only for stroke responsiveness, but
        // users still need an immediate, stable layer-stack entry. Publish an
        // image-less UV placeholder on pointer-up; SceneRoot ignores it until
        // the 4K bake replaces imageUrl on this same layer id.
        const pendingLayer: Layer = {
          id: mergeLayerId,
          name: LOCAL_REPAINT_UV_MERGE_LAYER_NAME,
          type: 'uv',
          role: 'local-repaint-overlay',
          imageUrl: '',
          objectId: source.objectId ?? model.objectId,
          generationId: source.generationId,
          captureId: source.captureId,
          replacementTargetLayerId: source.targetLayerId,
          renderedColor: true,
          visible: true,
          opacity: 1,
          strength: 1,
          blendMode: 'normal',
          adjustments: { hue: 0, saturation: 0, lightness: 0 },
          order: 0,
          contentRevision: 0,
          isBaked: false,
          needsRebake: true,
          createdAt: new Date().toISOString(),
        };
        const retainedLayers = currentLayers.filter(
          (item) =>
            !isLocalRepaintUvMergeLayer(item, model.objectId) &&
            !isLocalRepaintProjectionLayer(item),
        );
        const layerState = useLayerStore.getState();
        layerState.setLayers([pendingLayer, ...retainedLayers]);
        useLayerStore.getState().setActiveLayer(mergeLayerId);
        useProjectStore.getState().setProjectLayers(useLayerStore.getState().layers);
      }

      const commitUvStroke = async () => {
        await waitForPaintCommitIdle();
        if (
          localRepaintUvCommitRevisionRef.current !== commitRevision ||
          localRepaintCompositeRef.current?.sourceKey !== sourceKey ||
          isPaintingRef.current
        )
          return;

        const maskSnapshotUrl = registerLiveProjectedCanvasTexture(
          `local-repaint-uv-mask:${previewLayerId}:${commitRevision}`,
          maskSnapshot,
          THREE.NoColorSpace,
        );
        const transientLayer: Layer = {
          id: createId('local-repaint-uv-stroke'),
          name: source.name ?? '局部重绘',
          type: 'projected',
          imageUrl: source.imageUrl,
          maskUrl: maskSnapshotUrl,
          depthUrl: source.depthUrl,
          objectId: source.objectId ?? model.objectId,
          objectMatrixWorld: source.objectMatrixWorld ?? model.group.matrixWorld.toArray(),
          camera: source.camera,
          generationId: source.generationId,
          captureId: source.captureId,
          replacementTargetLayerId: source.targetLayerId,
          renderedColor: true,
          minimumProjectionFacing: LOCAL_REPAINT_MINIMUM_FACE_ON,
          visible: true,
          opacity: 1,
          strength: 1,
          blendMode: 'overlay',
          adjustments: { hue: 0, saturation: 0, lightness: 0 },
          order: 0,
          createdAt: new Date().toISOString(),
        };
        // Keep the screen-space preview lightweight, but persist the completed
        // projection in project texture space. Baking the sparse UV islands at
        // 1K and later enlarging them to 4K magnifies one-texel island edges into
        // visible seams, especially after Blender mipmapping.
        const bakeResolution = Math.min(
          UV_TEXTURE_RESOLUTION[textureResolutionSetting],
          4096,
        ) as UvBakeResolution;
        const bakeResolutionScale = bakeResolution / 1024;
        const { bakeVisibleProjectedLayersToTexture } =
          await import('@/engine/bake/bakeProjectedLayerToTexture');
        const bakeResult = await bakeVisibleProjectedLayersToTexture({
          objectId: model.objectId,
          transientLayers: [transientLayer],
          resolution: bakeResolution,
          enableBackfaceCulling: true,
          // A local repaint is previewed in projection space, but its persisted
          // form is a sparse UV overlay. Repair the topology-backed triangle
          // gaps and geometrically paired UV seams before replacing the live
          // preview; otherwise the opaque base shows through as a jagged crack.
          enableDilation: true,
          dilationPixels: Math.max(2, Math.ceil(bakeResolutionScale * 2)),
          constrainDilationToInteriorHoles: true,
          // GPU seam transfer plus topology-constrained dilation owns the normal
          // path. Keep the matching CPU gutter only as a renderer-failure
          // fallback; skipCpuPostprocess prevents it from running after a
          // successful GPU bake.
          uvIslandGutterPixels: Math.max(2, Math.ceil(bakeResolutionScale * 2)),
          uvCoverageGapPixels: 0,
          repairMissingUvSeams: true,
          uvSeamRepairPixels: Math.max(4, Math.ceil(bakeResolution / 256)),
          outputAlpha: 'transparent',
          gpuCompositeMode: 'coverage-alpha',
          skipGpuValidation: true,
          minimumCoverageRatio: 0,
          commitToProject: false,
          markSourceLayersBaked: false,
          skipImageEncoding: true,
          skipCpuPostprocess: true,
        });
        if (bakeResult.report.coveredPixels <= 0) {
          throw new Error('局部重绘没有生成有效 UV 像素，已保留实时预览，请重新绘制。');
        }

        // If another stroke started while the GPU was baking, keep its live
        // projected preview and let the newest queued snapshot replace this one.
        // The initial idle gate already protected interaction; waiting for a
        // second idle callback here only delayed the projection-to-UV handoff.
        if (
          localRepaintUvCommitRevisionRef.current !== commitRevision ||
          localRepaintCompositeRef.current?.sourceKey !== sourceKey ||
          isPaintingRef.current
        )
          return;

        const layerState = useLayerStore.getState();
        const latestLayers = layerState.layers;
        const existingMergeLayers = latestLayers.filter((item) =>
          isLocalRepaintUvMergeLayer(item, model.objectId),
        );
        const existingMergeLayer =
          existingMergeLayers.find((item) => item.id === mergeLayerId) ?? existingMergeLayers[0];
        const existingLiveCanvas = existingMergeLayer?.imageUrl
          ? getLiveProjectedCanvasState(existingMergeLayer.imageUrl)?.canvas
          : undefined;
        const canReuseLiveMergeCanvas =
          existingMergeLayers.length === 1 &&
          Boolean(
            existingLiveCanvas &&
            existingLiveCanvas.width === bakeResult.canvas.width &&
            existingLiveCanvas.height === bakeResult.canvas.height,
          );
        const existingSources =
          existingMergeLayers.length === 0 || canReuseLiveMergeCanvas
            ? []
            : await Promise.all(
                existingMergeLayers
                  .filter((layer) => Boolean(layer.imageUrl))
                  .map(async (layer) => ({
                    layer,
                    source:
                      getLiveProjectedCanvasState(layer.imageUrl)?.canvas ??
                      (await loadImageElement(layer.imageUrl)),
                  })),
              );
        if (
          localRepaintUvCommitRevisionRef.current !== commitRevision ||
          localRepaintCompositeRef.current?.sourceKey !== sourceKey ||
          isPaintingRef.current
        )
          return;
        const width = Math.max(
          bakeResult.canvas.width,
          ...existingSources.map(({ source: image }) =>
            'naturalWidth' in image ? image.naturalWidth || image.width : image.width,
          ),
        );
        const height = Math.max(
          bakeResult.canvas.height,
          ...existingSources.map(({ source: image }) =>
            'naturalHeight' in image ? image.naturalHeight || image.height : image.height,
          ),
        );
        let nextCanvas: HTMLCanvasElement;
        if (existingMergeLayers.length === 0) {
          // First stroke: use the GPU bake canvas directly instead of allocating
          // and copying a second full-resolution surface.
          nextCanvas = bakeResult.canvas;
        } else if (canReuseLiveMergeCanvas && existingLiveCanvas) {
          // Normal path: keep one stable canvas and texture for the whole session.
          // This removes a full UV copy plus CanvasTexture disposal/recreation.
          nextCanvas = existingLiveCanvas;
          const liveContext = nextCanvas.getContext('2d');
          if (!liveContext) throw new Error('Could not update local repaint UV merge canvas.');
          liveContext.drawImage(bakeResult.canvas, 0, 0, nextCanvas.width, nextCanvas.height);
        } else {
          nextCanvas = document.createElement('canvas');
          nextCanvas.width = width;
          nextCanvas.height = height;
          const nextContext = nextCanvas.getContext('2d');
          if (!nextContext) throw new Error('无法创建局部重绘 UV 合并画布。');
          existingSources
            .sort((a, b) => b.layer.order - a.layer.order)
            .forEach(({ source: image }) => nextContext.drawImage(image, 0, 0, width, height));
          nextContext.drawImage(bakeResult.canvas, 0, 0, width, height);
        }
        const assetUrl = registerLiveProjectedCanvasTexture(
          `surface-edit:local-repaint:${mergeLayerId}`,
          nextCanvas,
          THREE.SRGBColorSpace,
          { flipY: true },
        );
        markLiveProjectedCanvasTextureUpdated(assetUrl);

        const retainedLayers = latestLayers.filter(
          (item) =>
            !isLocalRepaintUvMergeLayer(item, model.objectId) &&
            !isLocalRepaintProjectionLayer(item),
        );
        const mergedLayer: Layer = {
          ...existingMergeLayer,
          id: mergeLayerId,
          name: LOCAL_REPAINT_UV_MERGE_LAYER_NAME,
          type: 'uv',
          role: 'local-repaint-overlay',
          imageUrl: assetUrl,
          objectId: source.objectId ?? model.objectId,
          generationId: source.generationId,
          captureId: source.captureId,
          replacementTargetLayerId: source.targetLayerId,
          renderedColor: true,
          visible: true,
          opacity: 1,
          strength: 1,
          blendMode: 'normal',
          adjustments: existingMergeLayer?.adjustments ?? {
            hue: 0,
            saturation: 0,
            lightness: 0,
          },
          order: 0,
          contentRevision: (existingMergeLayer?.contentRevision ?? 0) + 1,
          isBaked: false,
          needsRebake: false,
          createdAt: existingMergeLayer?.createdAt ?? new Date().toISOString(),
        };
        // Index 0 is the top row and the top visual layer. Reinsert on every
        // commit so legacy projects cannot leave this layer underneath the base.
        // Publish the UV result before detaching the projected preview. This
        // guarantees an overlap during the handoff instead of a blank frame.
        layerState.setLayers([mergedLayer, ...retainedLayers]);
        useLayerStore.getState().setActiveLayer(mergeLayerId);
        useProjectStore.getState().setProjectLayers(useLayerStore.getState().layers);
        // Keep the lightweight projection briefly above the completed 4K UV
        // result, then fade it away. This makes the resolution handoff visible
        // as a refinement instead of a one-frame texture swap.
        handoffLocalRepaintPreview(composite, sourceKey, commitRevision);
      };

      const queuedCommit = localRepaintUvCommitChainRef.current.then(commitUvStroke);
      localRepaintUvCommitChainRef.current = queuedCommit.catch((error) => {
        if (localRepaintUvCommitRevisionRef.current !== commitRevision) return;
        console.warn('[Liclick 3D Texture] Could not commit local repaint stroke to UV:', error);
        pushToast({
          tone: 'error',
          title: '局部重绘转 UV 失败',
          description: error instanceof Error ? error.message : '请重新绘制这一笔。',
          dedupeKey: `local-repaint-uv-error:${mergeLayerId}`,
        });
      });
    },
    [handoffLocalRepaintPreview, pushToast, textureResolutionSetting, waitForPaintCommitIdle],
  );

  const cancelProjectedEraserBatch = useCallback((layerId: string) => {
    const batch = projectedEraserBatchesRef.current.get(layerId);
    if (!batch) return;
    batch.revision += 1;
    if (batch.timerId !== undefined) window.clearTimeout(batch.timerId);
    if (batch.idleCallbackId !== undefined) window.cancelIdleCallback?.(batch.idleCallbackId);
    projectedEraserBatchesRef.current.delete(layerId);
  }, []);

  const runProjectedEraserRefinement = useCallback(
    async (batch: PendingProjectedEraserBatch, revision: number) => {
      const isCurrent = () =>
        projectedEraserBatchesRef.current.get(batch.layer.layerId) === batch &&
        batch.revision === revision;
      if (!isCurrent() || batch.snapshots.length === 0) return;
      const startedAt = performance.now();
      const snapshots = [...batch.snapshots];
      try {
        const bakeResult = await bakeProjectedEraserStrokesToUv({
          snapshots,
          resolution: getEraserBakeResolution(batch.layer.paintCanvas),
          runtimeKey: `${batch.layer.layerId}:${revision}`,
        });
        const alphaBounds = await getCanvasAlphaBoundsAsync(bakeResult.canvas);
        if (!isCurrent()) return;
        const latestLayer = useLayerStore
          .getState()
          .layers.find((item) => item.id === batch.layer.layerId);
        if (!latestLayer) {
          projectedEraserBatchesRef.current.delete(batch.layer.layerId);
          return;
        }
        if (bakeResult.report.coveredPixels <= 0 || !alphaBounds) {
          projectedEraserBatchesRef.current.delete(batch.layer.layerId);
          return;
        }

        const projectedBounds = scaleDirtyRect(
          alphaBounds,
          bakeResult.canvas.width,
          bakeResult.canvas.height,
          batch.layer.paintCanvas.width,
          batch.layer.paintCanvas.height,
        );
        const touchedTiles = getPaintHistoryTileKeysForBounds(
          batch.layer.paintCanvas,
          projectedBounds,
        );
        const historyTiles = batch.latestHistoryTiles ?? [];
        batch.latestHistoryTiles = historyTiles;
        const historyTilesByKey = new Map(
          historyTiles.map((tile) => [
            `${Math.floor(tile.bounds.x / PAINT_HISTORY_TILE_SIZE)}:${Math.floor(
              tile.bounds.y / PAINT_HISTORY_TILE_SIZE,
            )}`,
            tile,
          ]),
        );
        touchedTiles.forEach((key) => {
          if (historyTilesByKey.has(key)) return;
          const bounds = getPaintHistoryTileBounds(batch.layer.paintCanvas, key);
          if (!bounds) return;
          const tile: PaintHistoryTile = {
            bounds,
            before: copyCanvasRect(batch.layer.paintCanvas, bounds),
            after: copyCanvasRect(batch.layer.paintCanvas, bounds),
          };
          historyTiles.push(tile);
          historyTilesByKey.set(key, tile);
        });

        // The interactive UV stamps have already made the eraser feel instant.
        // This single deferred projection pass only fills missed UV islands and
        // triangle seams after input has been idle.
        batch.layer.paintContext.save();
        batch.layer.paintContext.globalCompositeOperation = 'destination-out';
        batch.layer.paintContext.drawImage(
          bakeResult.canvas,
          0,
          0,
          batch.layer.paintCanvas.width,
          batch.layer.paintCanvas.height,
        );
        batch.layer.paintContext.restore();
        if (batch.layer.target === 'projected-mask') {
          batch.layer.paintContext.save();
          batch.layer.paintContext.globalCompositeOperation = 'destination-over';
          batch.layer.paintContext.fillStyle = '#000000';
          batch.layer.paintContext.fillRect(
            0,
            0,
            batch.layer.paintCanvas.width,
            batch.layer.paintCanvas.height,
          );
          batch.layer.paintContext.restore();
        }
        historyTiles.forEach((tile) => {
          tile.after = copyCanvasRect(batch.layer.paintCanvas, tile.bounds);
        });
        projectedEraserBatchesRef.current.delete(batch.layer.layerId);
        markLiveProjectedCanvasTextureUpdated(batch.layer.assetUrl);
        useLayerStore.getState().updateLayer(batch.layer.layerId, {
          ...(batch.layer.target === 'uv-image'
            ? { imageUrl: batch.layer.assetUrl }
            : { maskUrl: batch.layer.assetUrl, maskSpace: 'uv' as const }),
          contentRevision: (latestLayer.contentRevision ?? 0) + 1,
          isBaked: false,
          needsRebake: batch.layer.target === 'projected-mask',
        });
        useProjectStore.getState().setProjectLayers(useLayerStore.getState().layers);
        if (useSettingsStore.getState().performanceTestModeEnabled) {
          console.info('[Liclick Eraser Refinement]', {
            strokes: snapshots.length,
            resolution: `${bakeResult.canvas.width}x${bakeResult.canvas.height}`,
            historyTiles: historyTiles.length,
            totalMs: performance.now() - startedAt,
          });
        }
      } catch (error) {
        if (!isCurrent()) return;
        projectedEraserBatchesRef.current.delete(batch.layer.layerId);
        // The immediate UV result is already committed, so a failed refinement
        // must never block the editor or replay the same expensive task.
        console.warn(
          '[Liclick 3D Texture] Deferred projected eraser refinement failed:',
          error,
        );
      }
    },
    [],
  );

  const scheduleProjectedEraserRefinement = useCallback(
    (
      layer: UvPaintLayer,
      snapshot: ProjectedEraserSnapshot,
      historyTiles: PaintHistoryTile[],
    ) => {
      let batch = projectedEraserBatchesRef.current.get(layer.layerId);
      if (!batch || batch.layer !== layer) {
        if (batch) cancelProjectedEraserBatch(layer.layerId);
        batch = {
          layer,
          snapshots: [],
          revision: 0,
        };
        projectedEraserBatchesRef.current.set(layer.layerId, batch);
      }
      appendProjectedEraserSnapshot(batch.snapshots, snapshot);
      batch.latestHistoryTiles = historyTiles;
      batch.revision += 1;
      const revision = batch.revision;
      if (batch.timerId !== undefined) window.clearTimeout(batch.timerId);
      if (batch.idleCallbackId !== undefined) window.cancelIdleCallback?.(batch.idleCallbackId);
      batch.timerId = undefined;
      batch.idleCallbackId = undefined;

      const waitUntilIdle = () => {
        if (
          projectedEraserBatchesRef.current.get(layer.layerId) !== batch ||
          batch.revision !== revision
        )
          return;
        const idleFor = performance.now() - lastPaintActivityAtRef.current;
        if (isPaintingRef.current || idleFor < PROJECTED_ERASER_HIGH_RES_IDLE_MS) {
          batch.timerId = window.setTimeout(
            waitUntilIdle,
            Math.max(32, Math.min(160, PROJECTED_ERASER_HIGH_RES_IDLE_MS - idleFor)),
          );
          return;
        }
        const run = () => {
          batch.idleCallbackId = undefined;
          if (
            projectedEraserBatchesRef.current.get(layer.layerId) !== batch ||
            batch.revision !== revision
          )
            return;
          if (isPaintingRef.current) {
            batch.timerId = window.setTimeout(waitUntilIdle, 120);
            return;
          }
          void runProjectedEraserRefinement(batch, revision);
        };
        if (window.requestIdleCallback) {
          batch.idleCallbackId = window.requestIdleCallback(
            (deadline) => {
              if (!deadline.didTimeout && deadline.timeRemaining() < 10) {
                batch.timerId = window.setTimeout(waitUntilIdle, 120);
                return;
              }
              run();
            },
            { timeout: 2500 },
          );
        } else {
          batch.timerId = window.setTimeout(run, 0);
        }
      };
      batch.timerId = window.setTimeout(waitUntilIdle, PROJECTED_ERASER_HIGH_RES_IDLE_MS);
    },
    [cancelProjectedEraserBatch, runProjectedEraserRefinement],
  );

  useEffect(
    () => () => {
      projectedEraserBatchesRef.current.forEach((batch) => {
        batch.revision += 1;
        if (batch.timerId !== undefined) window.clearTimeout(batch.timerId);
        if (batch.idleCallbackId !== undefined) window.cancelIdleCallback?.(batch.idleCallbackId);
      });
      projectedEraserBatchesRef.current.clear();
    },
    [],
  );

  const commitPaintStroke = useCallback(() => {
    const draft = strokeDraftRef.current;
    const layer = draft?.layer;
    const localRepaintSource = draft?.localRepaintSource ?? localRepaintProjectionSource;
    if (!draft?.bounds) {
      if (layer) endLiveEraserPreview(layer);
      return;
    }

    if (draft.target === 'paint') {
      if (!layer) return;
      const projectedEraserCommit = (() => {
        if (draft.paintOperation !== 'eraser') return undefined;
        const model = getTargetModel();
        if (!model) return undefined;
        model.group.updateMatrixWorld(true);
        const viewportRect = gl.domElement.getBoundingClientRect();
        const aspect = viewportRect.width / Math.max(viewportRect.height, 1);
        const target = new THREE.Box3().setFromObject(model.group).getCenter(new THREE.Vector3());
        return {
          model,
          camera: serializeCamera(camera, aspect, target),
          objectMatrixWorld: model.group.matrixWorld.toArray(),
          maskCanvas: copyCanvasRect(layer.projectionCanvas, {
            x: 0,
            y: 0,
            width: layer.projectionCanvas.width,
            height: layer.projectionCanvas.height,
          }),
        };
      })();
      // The live stroke owns a small screen-responsive canvas, exactly like local
      // repaint. Detach it now so another stroke can start while the source UV
      // image is still decoding in the background.
      const previewBounds = draft.bounds;
      const paintPreviewCommit = copyCanvasRect(layer.paintPreviewCanvas, previewBounds);
      layer.paintPreviewContext.clearRect(
        previewBounds.x,
        previewBounds.y,
        previewBounds.width,
        previewBounds.height,
      );

      const finishProjectedPreview = () => {
        const previewRevision = draft.previewRevision;
        window.requestAnimationFrame(() => {
          if (
            previewRevision === undefined ||
            paintPreviewRevisionRef.current !== previewRevision ||
            isPaintingRef.current
          )
            return;
          endLiveEraserPreview(layer);
          layer.projectionContext.clearRect(
            0,
            0,
            layer.projectionCanvas.width,
            layer.projectionCanvas.height,
          );
          layer.paintPreviewMaterial.uniforms.projectionReady.value = 0;
          scheduleProjectionTextureUpdate(layer.projectionTexture, true);
          layer.paintPreviewOverlays.forEach((overlay) => {
            overlay.visible = false;
          });
        });
      };

      const finalizePaintStroke = async () => {
        if (!layer.isReady) {
          finishProjectedPreview();
          return;
        }
        const commitStartedAt = performance.now();
        const backingWasInitialized = layer.paintBackingInitialized;
        ensurePaintBackingCanvasInitialized(layer);
        const backingInitMs = performance.now() - commitStartedAt;
        const currentLayer = useLayerStore
          .getState()
          .layers.find((item) => item.id === layer.layerId);
        if (!currentLayer) {
          finishProjectedPreview();
          return;
        }
        const latestLayer = useLayerStore
          .getState()
          .layers.find((item) => item.id === layer.layerId);
        if (!latestLayer) {
          finishProjectedPreview();
          return;
        }
        const touchedTiles = getPaintHistoryTileKeys(layer, draft.bounds!);
        const beforeTiles = [...touchedTiles]
          .map((key) => getPaintHistoryTileBounds(layer.paintCanvas, key))
          .filter((bounds): bounds is PaintDirtyRect => Boolean(bounds))
          .map((bounds) => ({ bounds, before: copyCanvasRect(layer.paintCanvas, bounds) }));

        const paintBounds = scaleDirtyRect(
          previewBounds,
          layer.paintPreviewCanvas.width,
          layer.paintPreviewCanvas.height,
          layer.paintCanvas.width,
          layer.paintCanvas.height,
        );
        layer.paintContext.save();
        layer.paintContext.globalCompositeOperation =
          draft.paintOperation === 'eraser' ? 'destination-out' : 'source-over';
        layer.paintContext.drawImage(
          paintPreviewCommit,
          0,
          0,
          paintPreviewCommit.width,
          paintPreviewCommit.height,
          paintBounds.x,
          paintBounds.y,
          paintBounds.width,
          paintBounds.height,
        );
        layer.paintContext.restore();
        if (draft.paintOperation === 'eraser' && layer.target === 'projected-mask') {
          // Store projection masks as opaque grayscale instead of transparent
          // white. Transparent mask edges interpolate both RGB and alpha, and
          // the projection shader multiplies the two, producing a dark fringe.
          // Filling black behind the result preserves the exact same coverage
          // while keeping alpha at one, so linear filtering has no seam.
          layer.paintContext.save();
          layer.paintContext.globalCompositeOperation = 'destination-over';
          layer.paintContext.fillStyle = '#000000';
          layer.paintContext.fillRect(0, 0, layer.paintCanvas.width, layer.paintCanvas.height);
          layer.paintContext.restore();
        }

        const historyTiles: PaintHistoryTile[] = beforeTiles.map(({ bounds, before }) => ({
          bounds,
          before,
          after: copyCanvasRect(layer.paintCanvas, bounds),
        }));
        const applyTiles = (side: 'before' | 'after') => {
          cancelProjectedEraserBatch(layer.layerId);
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
          contentRevision: (latestLayer.contentRevision ?? 0) + 1,
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
        if (projectedEraserCommit) {
          scheduleProjectedEraserRefinement(layer, projectedEraserCommit, historyTiles);
        }
        // Let the committed UV texture render for one frame before withdrawing
        // the projected plane. This keeps continuous feedback through the
        // pointer-up handoff instead of flashing back to the old texture.
        finishProjectedPreview();
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

      const queuedCommit = layer.paintCommitChain.then(() => layer.ready).then(finalizePaintStroke);
      layer.paintCommitChain = queuedCommit.catch((error) => {
        finishProjectedPreview();
        console.warn('[Liclick 3D Texture] Could not commit UV paint stroke:', error);
      });
      return;
    }

    if (draft.target === 'apply-local-repaint' && localRepaintSource) {
      const model = getTargetModel();
      if (!model || !localRepaintSourceImageRef.current?.image) return;
      model.group.updateMatrixWorld(true);
      // Pointer-down already resolved and published this composite. Reusing the
      // draft avoids a redundant preview-layer store update/material pass at the
      // exact moment the user releases the brush.
      const composite =
        draft.localRepaintComposite ?? ensureLiveLocalRepaintComposite(model, localRepaintSource);
      if (!composite) return;

      // Keep the projected canvas visible while the completed stroke is
      // persisted. Final-resolution UV conversion is deferred to export.
      markLiveProjectedCanvasTextureUpdated(composite.maskUrl);
      if (localRepaintUvScheduleFrameRef.current !== undefined) {
        window.cancelAnimationFrame(localRepaintUvScheduleFrameRef.current);
      }
      // Let the newly updated live mask complete one browser paint before taking
      // a snapshot or touching layer state. Consecutive strokes replace this
      // pending task and the cumulative live mask is persisted after interaction
      // pauses.
      const scheduleUvCommitAfterPreview = (hasYieldedFrame: boolean) => {
        localRepaintUvScheduleFrameRef.current = window.requestAnimationFrame(() => {
          if (isPaintingRef.current) {
            scheduleUvCommitAfterPreview(false);
            return;
          }
          if (!hasYieldedFrame) {
            scheduleUvCommitAfterPreview(true);
            return;
          }
          localRepaintUvScheduleFrameRef.current = undefined;
          queueLocalRepaintUvCommit(model, localRepaintSource, composite);
        });
      };
      scheduleUvCommitAfterPreview(false);
    }
  }, [
    cancelProjectedEraserBatch,
    ensureLiveLocalRepaintComposite,
    getTargetModel,
    camera,
    gl.domElement,
    localRepaintProjectionSource,
    queueLocalRepaintUvCommit,
    scheduleProjectedEraserRefinement,
    scheduleProjectionTextureUpdate,
  ]);

  const commitStrokeHistory = useCallback(() => {
    const draft = strokeDraftRef.current;
    strokeDraftRef.current = undefined;
    if (!draft?.bounds) return;
    if (draft.target === 'paint') return;
    if (draft.target === 'apply-local-repaint') return;
    if (!draft.layer) return;

    const targetCanvas =
      draft.target === 'mask' ? draft.layer.projectionCanvas : draft.layer.paintCanvas;
    const targetContext =
      draft.target === 'mask' ? draft.layer.projectionContext : draft.layer.paintContext;
    const afterMaskHasContent =
      draft.target === 'mask'
        ? paintTool === 'inpaint-add'
          ? true
          : hasCanvasAlpha(targetCanvas, targetContext)
        : maskHasContentRef.current;

    if (draft.target === 'mask') {
      maskHasContentRef.current = afterMaskHasContent;
    }
  }, [paintTool]);

  useEffect(() => {
    const canvas = gl.domElement;
    const listenerGeneration = pointerListenerGenerationRef.current + 1;
    pointerListenerGenerationRef.current = listenerGeneration;
    const previousTouchAction = canvas.style.touchAction;
    if (enabled) canvas.style.touchAction = 'none';
    const isMaskStroke = isInpaintMode || isLocalRepaintApplyMode;
    // Selection/local-repaint masks can be filled by one projected segment per
    // frame. Texture paint and eraser commits need dense surface raycasts so the
    // UV result follows the projected screen path across every visible triangle.
    const usesProjectedLiveStroke = isMaskStroke;
    const paintClientPath = (targets: ClientPoint[]) => {
      const telemetry = strokeTelemetryRef.current;
      const canvasRect = canvas.getBoundingClientRect();

      if (usesProjectedLiveStroke) {
        // Projected live strokes only need the latest surface hit for each display
        // frame. The screen-space segment rasterizer fills the visible gap, while
        // the same hit updates the offscreen UV commit canvas. This avoids dozens
        // of redundant BVH raycasts on dense meshes.
        const finalTarget = targets[targets.length - 1];
        if (!finalTarget) return undefined;
        const previousTarget = lastPointerClientRef.current;
        if (previousTarget && telemetry) {
          telemetry.maxPointerGapPx = Math.max(
            telemetry.maxPointerGapPx,
            Math.hypot(finalTarget.x - previousTarget.x, finalTarget.y - previousTarget.y),
          );
        }
        if (telemetry) telemetry.raycasts += 1;
        const result = raycastModel({ clientX: finalTarget.x, clientY: finalTarget.y }, canvasRect);
        if (!result) {
          if (telemetry) telemetry.misses += 1;
          lastUvRef.current = undefined;
          lastSampleRef.current = undefined;
        } else {
          if (telemetry) telemetry.hits += 1;
          paintAt(result, finalTarget.pressure, strokePaintToolRef.current ?? paintTool);
        }
        lastPointerClientRef.current = finalTarget;
        return result;
      }

      const maxSamples = 96;
      const spacingPx = THREE.MathUtils.clamp(
        (lastSampleRef.current?.screenBrushRadiusPx ?? 7.5) * 0.4,
        isMaskStroke ? 0.75 : 3,
        14,
      );
      const { samples, maxGapPx } = resampleClientPath(
        lastPointerClientRef.current,
        targets,
        maxSamples,
        spacingPx,
      );
      if (telemetry) telemetry.maxPointerGapPx = Math.max(telemetry.maxPointerGapPx, maxGapPx);
      let latestResult: UvPaintHit | undefined;
      for (const point of samples) {
        if (telemetry) telemetry.raycasts += 1;
        const result = raycastModel(
          {
            clientX: point.x,
            clientY: point.y,
          },
          canvasRect,
        );
        if (!result) {
          if (telemetry) telemetry.misses += 1;
          // Never reconnect a stroke after it crossed the background or an
          // occluded gap. The next valid surface hit begins a fresh stamp chain.
          lastUvRef.current = undefined;
          lastSampleRef.current = undefined;
          continue;
        }
        if (telemetry) telemetry.hits += 1;
        paintAt(result, point.pressure, strokePaintToolRef.current ?? paintTool);
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
        pointerType: telemetry.pointerType,
        durationMs: performance.now() - telemetry.startedAt,
        pointerEvents: telemetry.pointerEvents,
        coalescedEvents: telemetry.coalescedEvents,
        raycasts: telemetry.raycasts,
        hits: telemetry.hits,
        misses: telemetry.misses,
        continuityBreaks: telemetry.continuityBreaks,
        maxPointerGapPx: telemetry.maxPointerGapPx,
        minPressure: telemetry.minPressure,
        maxPressure: telemetry.maxPressure,
      };
      lastStrokeTelemetry = snapshot;
      strokeTelemetryRef.current = undefined;
      if (useSettingsStore.getState().performanceTestModeEnabled) {
        console.info('[Liclick Paint Stroke]', { tool: paintTool, ...snapshot });
      }
    };
    const flushPendingPaintTargets = (extraTargets: ClientPoint[] = []) => {
      if (paintInputFrameRef.current !== undefined) {
        window.cancelAnimationFrame(paintInputFrameRef.current);
        paintInputFrameRef.current = undefined;
      }
      const targets = [...pendingPaintTargetsRef.current, ...extraTargets];
      pendingPaintTargetsRef.current = [];
      if (targets.length === 0) return undefined;
      const paintStartedAt = performance.now();
      lastPaintActivityAtRef.current = paintStartedAt;
      const latestResult = paintClientPath(targets);
      if (latestResult) updateCursorFromHit(latestResult);
      recordSurfacePaintPerf(performance.now() - paintStartedAt);
      return latestResult;
    };
    const schedulePendingPaintTargets = () => {
      if (paintInputFrameRef.current !== undefined) return;
      paintInputFrameRef.current = window.requestAnimationFrame(() => {
        paintInputFrameRef.current = undefined;
        flushPendingPaintTargets();
      });
    };
    const clearPointerCancelRecovery = () => {
      if (pointerCancelRecoveryTimerRef.current === undefined) return;
      window.clearTimeout(pointerCancelRecoveryTimerRef.current);
      pointerCancelRecoveryTimerRef.current = undefined;
    };
    const isPointerContactActive = (event: globalThis.PointerEvent) =>
      event.pointerType === 'pen'
        ? event.pressure > 0 || (event.buttons & 1) !== 0
        : (event.buttons & 1) !== 0;
    const finishPaintStroke = (
      event: globalThis.PointerEvent | undefined,
      endReason: StrokeTelemetrySnapshot['endReason'],
    ) => {
      if (!isPaintingRef.current) return;
      if (
        event &&
        activePointerIdRef.current !== undefined &&
        event.pointerId !== activePointerIdRef.current
      )
        return;
      clearPointerCancelRecovery();
      const previousClient = lastPointerClientRef.current;
      if (event && endReason === 'pointerup' && previousClient) {
        const canvasRect = canvas.getBoundingClientRect();
        const pointerUpInsideCanvas =
          event.clientX >= canvasRect.left &&
          event.clientX <= canvasRect.right &&
          event.clientY >= canvasRect.top &&
          event.clientY <= canvasRect.bottom;
        const pointerUpDistance = Math.hypot(
          event.clientX - previousClient.x,
          event.clientY - previousClient.y,
        );
        const maximumPointerUpDistance = Math.max(
          8,
          (lastSampleRef.current?.screenBrushRadiusPx ?? 8) * 1.5,
        );
        const queuedTarget = pendingPaintTargetsRef.current.at(-1);
        const finalPressure = queuedTarget?.pressure ?? previousClient.pressure;
        const telemetry = strokeTelemetryRef.current;
        if (telemetry) {
          telemetry.pointerEvents += 1;
          telemetry.coalescedEvents += 1;
          telemetry.minPressure = Math.min(telemetry.minPressure, finalPressure);
          telemetry.maxPressure = Math.max(telemetry.maxPressure, finalPressure);
        }
        flushPendingPaintTargets(
          pointerUpInsideCanvas && pointerUpDistance <= maximumPointerUpDistance
            ? [{ x: event.clientX, y: event.clientY, pressure: finalPressure }]
            : [],
        );
      } else {
        flushPendingPaintTargets();
      }
      const localRepaintComposite = localRepaintCompositeRef.current;
      if (isLocalRepaintApplyMode && localRepaintComposite) {
        scheduleTextureUpdate(localRepaintComposite.maskTexture);
      }
      isPaintingRef.current = false;
      lastPaintActivityAtRef.current = performance.now();
      const capturedPointerId = activePointerIdRef.current ?? event?.pointerId;
      if (capturedPointerId !== undefined && canvas.hasPointerCapture(capturedPointerId)) {
        canvas.releasePointerCapture(capturedPointerId);
      }
      activePointerIdRef.current = undefined;
      lastUvRef.current = undefined;
      lastSampleRef.current = undefined;
      lastPointerClientRef.current = undefined;
      strokePaintToolRef.current = undefined;
      setOrbitControlsEnabled(true);
      if (isInpaintMode && layerRef.current)
        scheduleProjectionTextureUpdate(layerRef.current.projectionTexture, true);
      commitPaintStroke();
      commitStrokeHistory();
      commitMaskIfDirty();
      finishStrokeTelemetry(endReason);
    };
    const schedulePointerCancelRecovery = (event: globalThis.PointerEvent) => {
      if (!isPaintingRef.current) return;
      const activePointerId = activePointerIdRef.current;
      if (activePointerId === undefined && pointerCancelRecoveryTimerRef.current !== undefined)
        return;
      if (activePointerId !== undefined && event.pointerId !== activePointerId) return;
      flushPendingPaintTargets();
      activePointerIdRef.current = undefined;
      if (activePointerId !== undefined && canvas.hasPointerCapture(activePointerId)) {
        canvas.releasePointerCapture(activePointerId);
      }
      clearPointerCancelRecovery();
      // Windows Ink and some tablet drivers can briefly cancel capture while the
      // pen is still physically down. Keep the draft alive long enough for the
      // next contact event to rebind it instead of splitting one gesture in two.
      pointerCancelRecoveryTimerRef.current = window.setTimeout(() => {
        pointerCancelRecoveryTimerRef.current = undefined;
        finishPaintStroke(undefined, 'pointercancel');
      }, 650);
    };
    const tryResumeInterruptedStroke = (event: globalThis.PointerEvent) => {
      if (
        !isPaintingRef.current ||
        activePointerIdRef.current !== undefined ||
        pointerCancelRecoveryTimerRef.current === undefined ||
        !isPointerContactActive(event)
      )
        return false;
      clearPointerCancelRecovery();
      activePointerIdRef.current = event.pointerId;
      try {
        canvas.setPointerCapture(event.pointerId);
      } catch {
        // Capture can race with the driver's replacement pointer stream. The
        // window-level pointerup listener still closes the recovered stroke.
      }
      return true;
    };
    const handlePointerMove = (event: globalThis.PointerEvent) => {
      if (isPaintingRef.current) {
        if (activePointerIdRef.current === undefined && !tryResumeInterruptedStroke(event)) return;
        if (activePointerIdRef.current !== event.pointerId) return;
        event.preventDefault();
        // The brush and OrbitControls listen on the same canvas. Fully consume
        // an active stroke so the camera cannot receive a parallel drag.
        event.stopImmediatePropagation();
        const events = event.getCoalescedEvents?.() ?? [event];
        const targets = usesProjectedLiveStroke
          ? [{ x: event.clientX, y: event.clientY, pressure: getPointerPressure(event) }]
          : events.map((sampledEvent) => ({
              x: sampledEvent.clientX,
              y: sampledEvent.clientY,
              pressure: getPointerPressure(sampledEvent),
            }));
        const finalTarget = targets[targets.length - 1];
        if (
          !usesProjectedLiveStroke &&
          (!finalTarget || finalTarget.x !== event.clientX || finalTarget.y !== event.clientY)
        ) {
          targets.push({
            x: event.clientX,
            y: event.clientY,
            pressure: getPointerPressure(event),
          });
        }
        const telemetry = strokeTelemetryRef.current;
        if (telemetry) {
          telemetry.pointerEvents += 1;
          telemetry.coalescedEvents += events.length;
          for (const target of targets) {
            telemetry.minPressure = Math.min(telemetry.minPressure, target.pressure);
            telemetry.maxPressure = Math.max(telemetry.maxPressure, target.pressure);
          }
        }
        if (usesProjectedLiveStroke) pendingPaintTargetsRef.current = targets;
        else pendingPaintTargetsRef.current.push(...targets);
        if (pendingPaintTargetsRef.current.length > 512) {
          pendingPaintTargetsRef.current = pendingPaintTargetsRef.current.slice(-512);
        }
        schedulePendingPaintTargets();
        return;
      }
      updateCursor(event);
    };
    const handlePointerDown = (event: globalThis.PointerEvent) => {
      if (event.pointerType === 'touch') return;
      if (isPaintingRef.current) {
        if (tryResumeInterruptedStroke(event)) handlePointerMove(event);
        return;
      }
      if (!enabled) return;
      const penEraserContact =
        event.pointerType === 'pen' &&
        (event.button === 2 || event.button === 5) &&
        event.pressure > 0;
      const isPaintButton = event.button === 0 || penEraserContact;
      const result = raycastModel(event);

      // Navigation buttons must reach the camera controls even when the drag
      // starts on the model. Only the primary/pen-eraser paint gesture belongs
      // exclusively to the brush input layer.
      if (!isPaintButton) return;

      // In paint modes the model surface belongs exclusively to the brush.
      // OrbitControls remains available only when the drag begins on the
      // background. stopImmediatePropagation is necessary because both input
      // systems have native listeners on this same canvas element.
      if (!result) return;
      if (isInpaintMode) syncInpaintMaskProjection(result.model);
      event.preventDefault();
      event.stopImmediatePropagation();

      if (!isInpaintMode && !canUseSurfacePaint) {
        warnMissingPaintLayer();
        return;
      }
      const paintStartedAt = performance.now();
      lastPaintActivityAtRef.current = paintStartedAt;
      updateCursorFromHit(result);
      if (isLocalRepaintApplyMode) {
        const source = resolveLocalRepaintStrokeSource();
        const preparedComposite =
          source &&
          localRepaintCompositeRef.current?.sourceKey ===
            createLocalRepaintSourceKey(source, result.model.objectId)
            ? localRepaintCompositeRef.current
            : undefined;
        const composite = source
          ? (preparedComposite ?? ensureLiveLocalRepaintComposite(result.model, source))
          : undefined;
        const surfaceFacesProjector =
          composite &&
          result.hit.object instanceof THREE.Mesh &&
          result.hit.face &&
          isLocalRepaintSurfaceFacingProjector(
            composite,
            result.hit.object,
            result.hit.face,
            result.hit.point,
          );
        const projectedUv =
          composite && surfaceFacesProjector
            ? projectWorldPointToLocalRepaintUv(
                result.hit.point,
                composite.worldToSourceClip,
                localRepaintProjectionScratch.projectedUv,
              )
            : undefined;
        if (!projectedUv || !hasLocalRepaintSourceContent(projectedUv)) return;
      }
      isPaintingRef.current = true;
      pendingPaintTargetsRef.current = [];
      if (paintInputFrameRef.current !== undefined) {
        window.cancelAnimationFrame(paintInputFrameRef.current);
        paintInputFrameRef.current = undefined;
      }
      activePointerIdRef.current = event.pointerId;
      canvas.setPointerCapture(event.pointerId);
      lastUvRef.current = undefined;
      lastSampleRef.current = undefined;
      const pressure = getPointerPressure(event);
      const strokePaintTool =
        penEraserContact && (paintTool === 'brush' || paintTool === 'eraser')
          ? 'eraser'
          : paintTool;
      strokePaintToolRef.current =
        strokePaintTool === 'brush' || strokePaintTool === 'eraser' ? strokePaintTool : undefined;
      lastPointerClientRef.current = { x: event.clientX, y: event.clientY, pressure };
      strokeTelemetryRef.current = {
        endReason: 'pointerup',
        pointerType: event.pointerType,
        startedAt: paintStartedAt,
        durationMs: 0,
        pointerEvents: 1,
        coalescedEvents: 1,
        raycasts: 1,
        hits: 1,
        misses: 0,
        continuityBreaks: 0,
        maxPointerGapPx: 0,
        minPressure: pressure,
        maxPressure: pressure,
      };
      beginStrokeHistory(result, strokePaintTool);
      setOrbitControlsEnabled(false);
      paintAt(result, pressure, strokePaintTool);
      recordSurfacePaintPerf(performance.now() - paintStartedAt);
    };
    const handlePointerUp = (event: globalThis.PointerEvent) =>
      finishPaintStroke(event, 'pointerup');
    const handlePointerCancel = (event: globalThis.PointerEvent) =>
      schedulePointerCancelRecovery(event);
    const handleLostPointerCapture = (event: globalThis.PointerEvent) =>
      schedulePointerCancelRecovery(event);
    const handlePointerLeave = () => {
      cursorCircleRef.current?.setAttribute('visibility', 'hidden');
      if (!isPaintingRef.current) gl.domElement.style.cursor = '';
    };
    canvas.addEventListener('pointermove', handlePointerMove, true);
    canvas.addEventListener('pointerdown', handlePointerDown, true);
    window.addEventListener('pointerup', handlePointerUp, true);
    window.addEventListener('pointercancel', handlePointerCancel, true);
    canvas.addEventListener('lostpointercapture', handleLostPointerCapture);
    canvas.addEventListener('pointerleave', handlePointerLeave);
    return () => {
      canvas.removeEventListener('pointermove', handlePointerMove, true);
      canvas.removeEventListener('pointerdown', handlePointerDown, true);
      window.removeEventListener('pointerup', handlePointerUp, true);
      window.removeEventListener('pointercancel', handlePointerCancel, true);
      canvas.removeEventListener('lostpointercapture', handleLostPointerCapture);
      canvas.removeEventListener('pointerleave', handlePointerLeave);
      canvas.style.touchAction = previousTouchAction;
      // React tears down and recreates this listener effect whenever one of its
      // callbacks changes. Defer destructive stroke cleanup by one microtask:
      // a replacement effect advances the generation and keeps the live stroke;
      // a real component unmount has no replacement and performs the teardown.
      queueMicrotask(() => {
        if (pointerListenerGenerationRef.current !== listenerGeneration) return;
        if (isPaintingRef.current) flushPendingPaintTargets();
        pendingPaintTargetsRef.current = [];
        if (paintInputFrameRef.current !== undefined) {
          window.cancelAnimationFrame(paintInputFrameRef.current);
          paintInputFrameRef.current = undefined;
        }
        clearPointerCancelRecovery();
        cursorCircleRef.current?.setAttribute('visibility', 'hidden');
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
        strokePaintToolRef.current = undefined;
        gl.domElement.style.cursor = '';
      });
    };
  }, [
    commitMaskIfDirty,
    beginStrokeHistory,
    commitPaintStroke,
    commitStrokeHistory,
    enabled,
    ensureLiveLocalRepaintComposite,
    gl,
    hasLocalRepaintSourceContent,
    isInpaintMode,
    isLocalRepaintApplyMode,
    paintAt,
    scheduleProjectionTextureUpdate,
    scheduleTextureUpdate,
    paintTool,
    raycastModel,
    resolveLocalRepaintStrokeSource,
    setOrbitControlsEnabled,
    syncInpaintMaskProjection,
    canUseSurfacePaint,
    updateCursor,
    updateCursorFromHit,
    warnMissingPaintLayer,
  ]);

  return null;
}

export function ViewportCanvas({
  hasImportedModel,
  onImportModels,
  onImportReferenceImages,
  onOpenImport,
  backgroundColor = '#080914',
  showCaptureFrame = true,
  showViewCube = true,
  sceneOverlay,
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
  const paintTool = useSceneStore((state) => state.paintTool);
  const exposure = useSettingsStore((state) => state.exposure);
  const performanceTestModeEnabled = useSettingsStore((state) => state.performanceTestModeEnabled);
  const t = useT();

  useEffect(() => () => window.clearTimeout(captureFrameTimerRef.current), []);

  function pulseCaptureFrame() {
    if (workspaceMode === 'scene' || paintTool !== 'none') return;
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
      style={{ backgroundColor }}
      onPointerDownCapture={paintTool === 'none' ? pulseCaptureFrame : undefined}
      onPointerMoveCapture={paintTool === 'none' ? handlePointerMove : undefined}
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
        <color attach="background" args={[backgroundColor]} />
        <Suspense fallback={null}>
          <RendererSettings />
          <ViewportPerformanceProbe enabled={performanceTestModeEnabled} />
          <AcceleratedSceneRoot sceneOverlay={sceneOverlay} />
          <SurfacePaintOverlay />
        </Suspense>
        <CameraController />
      </Canvas>
      {performanceTestModeEnabled && <PerformanceTestHud />}
      {showCaptureFrame && (
        <div
          className={`pointer-events-none absolute left-1/2 top-1/2 z-20 h-[82%] w-[72%] max-w-[1280px] -translate-x-1/2 -translate-y-1/2 rounded-[18px] border-[3px] border-dashed border-[#d9795c]/75 shadow-[0_0_0_1px_rgba(217,121,92,0.12)] transition-opacity duration-300 ${
            captureFrameVisible && workspaceMode !== 'scene' ? 'opacity-100' : 'opacity-0'
          }`}
          aria-hidden="true"
        />
      )}
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
      {showViewCube && <ViewCube />}
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
