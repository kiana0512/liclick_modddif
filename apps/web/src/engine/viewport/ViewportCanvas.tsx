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
const LOCAL_REPAINT_LIVE_MASK_MAX_SIZE = 384;
const INPAINT_BRUSH_MIN_WORLD_RADIUS_RATIO = 0.004;
const INPAINT_BRUSH_MAX_WORLD_RADIUS_RATIO = 0.12;
const INPAINT_BRUSH_MIN_TEXTURE_RADIUS = 1;
const INPAINT_BRUSH_MAX_TEXTURE_RADIUS = 72;
const LOCAL_REPAINT_PROJECTION_LAYER_ID_PREFIX = 'local-repaint-projection';
const LEGACY_LOCAL_REPAINT_PROJECTION_LAYER_ID_PREFIX = 'local-repaint-brush-projection';
const LOCAL_REPAINT_UV_MERGE_LAYER_ID_PREFIX = 'local-repaint-uv-merge';
const LOCAL_REPAINT_UV_MERGE_LAYER_NAME = '局部重绘合并层';
// Keep the high-resolution UV bake well outside active drawing bursts. The
// low-resolution projected preview updates immediately, matching GPU paint apps.
const LOCAL_REPAINT_UV_COMMIT_DELAY_MS = 3200;
const surfacePaintPerfSamples: number[] = [];
const gpuFrameTimeSamples: number[] = [];
const automaticFadeBrushStampCache = new Map<number, HTMLCanvasElement>();
let surfacePaintPerfFrame: number | undefined;

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
  projectionTexture: THREE.CanvasTexture;
  maskCanvas: HTMLCanvasElement;
  maskContext: CanvasRenderingContext2D;
  maskTexture: THREE.CanvasTexture;
  maskMaterial: THREE.ShaderMaterial;
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
};

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
  layer: UvPaintLayer;
  target: 'paint' | 'mask' | 'apply-local-repaint';
  bounds?: PaintDirtyRect;
  paintOperation?: 'brush' | 'eraser';
  localRepaintSource?: LocalRepaintProjectionSource;
  localRepaintComposite?: LocalRepaintCompositeState;
  livePreviewUpdated?: boolean;
};

type ClientPoint = { x: number; y: number };

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

function thresholdCanvasAlpha(canvas: HTMLCanvasElement, threshold = 128) {
  const context = canvas.getContext('2d');
  if (!context) return;
  const image = context.getImageData(0, 0, canvas.width, canvas.height);
  for (let index = 3; index < image.data.length; index += 4) {
    image.data[index] = image.data[index] >= threshold ? 255 : 0;
  }
  context.putImageData(image, 0, 0);
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
        if (vProjectedPosition.w <= 0.0001 || vProjectorFacing <= 0.01) discard;
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

        gl_FragColor = vec4(stripeColor, stripeOpacity * stripe * maskAlpha);
      }
    `,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    polygonOffset: true,
    polygonOffsetFactor: -8,
    // The projected mask is only valid on camera-facing surfaces. Avoid shading
    // the hidden back faces as well; dense production meshes otherwise pay for
    // the overlay fragment shader twice while the pointer is moving.
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
  const uniforms = layer.maskMaterial.uniforms;
  (uniforms.projectorMatrix.value as THREE.Matrix4)
    .copy(camera.projectionMatrix)
    .multiply(camera.matrixWorldInverse);
  (uniforms.projectorPosition.value as THREE.Vector3).setFromMatrixPosition(camera.matrixWorld);
  uniforms.projectionReady.value = 1;
}

function disposeUvPaintLayer(layer?: UvPaintLayer) {
  if (!layer) return;
  layer.overlayMeshes.forEach((mesh) => mesh.removeFromParent());
  layer.paintPreviewTexture.dispose();
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

function isLocalRepaintUvMergeLayer(layer: Layer, objectId: string) {
  return (
    layer.type === 'uv' &&
    layer.id.startsWith(LOCAL_REPAINT_UV_MERGE_LAYER_ID_PREFIX) &&
    (!layer.objectId || layer.objectId === objectId)
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
  return {
    sourceKey,
    layerId,
    maskUrl,
    maskCanvas,
    maskContext,
    scratchCanvas,
    scratchContext,
  };
}

function applyAutomaticInnerFeather(
  maskCanvas: HTMLCanvasElement,
  hardMask: ImageData,
) {
  const blurCanvas = document.createElement('canvas');
  blurCanvas.width = maskCanvas.width;
  blurCanvas.height = maskCanvas.height;
  const blurContext = blurCanvas.getContext('2d', { willReadFrequently: true });
  const outputContext = maskCanvas.getContext('2d');
  if (!blurContext || !outputContext) return;
  const featherPx = THREE.MathUtils.clamp(
    Math.round(Math.min(maskCanvas.width, maskCanvas.height) * 0.012),
    4,
    18,
  );
  blurContext.filter = `blur(${featherPx}px)`;
  blurContext.drawImage(maskCanvas, 0, 0);
  blurContext.filter = 'none';
  const blurred = blurContext.getImageData(0, 0, blurCanvas.width, blurCanvas.height);
  const feathered = new ImageData(
    new Uint8ClampedArray(hardMask.data),
    hardMask.width,
    hardMask.height,
  );
  for (let offset = 0; offset < feathered.data.length; offset += 4) {
    const normalized = THREE.MathUtils.clamp((blurred.data[offset + 3] / 255 - 0.5) * 2, 0, 1);
    const smoothCoverage = normalized * normalized * (3 - 2 * normalized);
    feathered.data[offset + 3] = Math.round(hardMask.data[offset + 3] * smoothCoverage);
  }
  outputContext.putImageData(feathered, 0, 0);
}

function drawLocalRepaintStrokeMaskPatch(
  composite: LocalRepaintCompositeState,
  allowedMask: LocalRepaintAllowedMaskState,
  strokeMask: HTMLCanvasElement,
  dirtyRect: PaintDirtyRect,
) {
  const scaleX = composite.maskCanvas.width / Math.max(1, strokeMask.width);
  const scaleY = composite.maskCanvas.height / Math.max(1, strokeMask.height);
  const targetX = Math.max(0, Math.floor(dirtyRect.x * scaleX));
  const targetY = Math.max(0, Math.floor(dirtyRect.y * scaleY));
  const targetRight = Math.min(
    composite.maskCanvas.width,
    Math.ceil((dirtyRect.x + dirtyRect.width) * scaleX),
  );
  const targetBottom = Math.min(
    composite.maskCanvas.height,
    Math.ceil((dirtyRect.y + dirtyRect.height) * scaleY),
  );
  const targetWidth = Math.max(1, targetRight - targetX);
  const targetHeight = Math.max(1, targetBottom - targetY);

  // The source image already carries the generated cutout alpha. During pointer
  // movement only combine the tiny brush rectangle with the pre-feathered allowed
  // mask. Avoiding source-image draws and canvas filters here keeps this path cheap.
  composite.scratchContext.save();
  composite.scratchContext.globalCompositeOperation = 'source-over';
  composite.scratchContext.imageSmoothingEnabled = true;
  composite.scratchContext.imageSmoothingQuality = 'high';
  composite.scratchContext.clearRect(targetX, targetY, targetWidth, targetHeight);
  composite.scratchContext.drawImage(
    strokeMask,
    dirtyRect.x,
    dirtyRect.y,
    dirtyRect.width,
    dirtyRect.height,
    targetX,
    targetY,
    targetWidth,
    targetHeight,
  );
  composite.scratchContext.drawImage(
    allowedMask.canvas,
    (targetX / composite.maskCanvas.width) * allowedMask.canvas.width,
    (targetY / composite.maskCanvas.height) * allowedMask.canvas.height,
    (targetWidth / composite.maskCanvas.width) * allowedMask.canvas.width,
    (targetHeight / composite.maskCanvas.height) * allowedMask.canvas.height,
    targetX,
    targetY,
    targetWidth,
    targetHeight,
  );
  composite.scratchContext.restore();
  // Keep the strongest coverage when strokes overlap. A later low-opacity
  // stroke must not erase a previously painted high-opacity region.
  composite.maskContext.save();
  composite.maskContext.globalCompositeOperation = 'lighten';
  composite.maskContext.drawImage(
    composite.scratchCanvas,
    targetX,
    targetY,
    targetWidth,
    targetHeight,
    targetX,
    targetY,
    targetWidth,
    targetHeight,
  );
  composite.maskContext.restore();
  composite.scratchContext.clearRect(targetX, targetY, targetWidth, targetHeight);
  markLiveProjectedCanvasTextureUpdated(composite.maskUrl);
}

function createLocalRepaintPatchCanvas(
  sourceImage: HTMLImageElement,
  maskCanvas: HTMLCanvasElement,
) {
  const canvas = document.createElement('canvas');
  canvas.width = sourceImage.naturalWidth || sourceImage.width || maskCanvas.width;
  canvas.height = sourceImage.naturalHeight || sourceImage.height || maskCanvas.height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Could not create local repaint patch canvas.');
  context.drawImage(sourceImage, 0, 0, canvas.width, canvas.height);
  const maskContext = maskCanvas.getContext('2d', { willReadFrequently: true });
  if (!maskContext) throw new Error('Could not read local repaint stroke mask.');
  const mask = maskContext.getImageData(0, 0, maskCanvas.width, maskCanvas.height);
  for (let offset = 0; offset < mask.data.length; offset += 4) {
    const coverage = Math.max(mask.data[offset], mask.data[offset + 1], mask.data[offset + 2]);
    mask.data[offset] = 255;
    mask.data[offset + 1] = 255;
    mask.data[offset + 2] = 255;
    mask.data[offset + 3] = Math.round((coverage * mask.data[offset + 3]) / 255);
  }
  const alphaMask = document.createElement('canvas');
  alphaMask.width = maskCanvas.width;
  alphaMask.height = maskCanvas.height;
  const alphaContext = alphaMask.getContext('2d');
  if (!alphaContext) throw new Error('Could not create local repaint alpha mask.');
  alphaContext.putImageData(mask, 0, 0);
  context.globalCompositeOperation = 'destination-in';
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(alphaMask, 0, 0, canvas.width, canvas.height);
  context.globalCompositeOperation = 'source-over';
  return canvas;
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
  const lastPointerClientRef = useRef<{ x: number; y: number }>();
  const pendingPaintTargetsRef = useRef<ClientPoint[]>([]);
  const paintInputFrameRef = useRef<number>();
  const activePointerIdRef = useRef<number>();
  const lastPaintActivityAtRef = useRef(0);
  const strokeTelemetryRef = useRef<StrokeTelemetrySnapshot & { startedAt: number }>();
  const strokeDraftRef = useRef<PaintStrokeDraft>();
  const dirtyTexturesRef = useRef(new Set<THREE.CanvasTexture>());
  const textureUpdateFrameRef = useRef<number>();
  const projectionTextureUpdateTimerRef = useRef<number>();
  const projectionTextureLastUpdateAtRef = useRef(0);
  const maskDirtyRef = useRef(false);
  const maskHasContentRef = useRef(false);
  const paintMaskCommitRevisionRef = useRef(0);
  const localRepaintAllowedMaskRef = useRef<LocalRepaintAllowedMaskState>();
  const localRepaintSourceImageRef = useRef<{
    url: string;
    image: HTMLImageElement;
    data?: ImageData;
  }>();
  const [localRepaintAssetsRevision, setLocalRepaintAssetsRevision] = useState(0);
  const localRepaintCompositeRef = useRef<LocalRepaintCompositeState>();
  const localRepaintCommitRevisionRef = useRef(0);
  const localRepaintCommitTimerRef = useRef<number>();
  const localRepaintUvCommitRevisionRef = useRef(0);
  const localRepaintUvCommitTimerRef = useRef<number>();
  const localRepaintUvCommitChainRef = useRef(Promise.resolve());
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
      const paintPreviewTexture = new THREE.CanvasTexture(paintPreview.canvas);
      configureCanvasTexture(paintPreviewTexture, THREE.SRGBColorSpace);
      const paintPreviewMaterial = new THREE.MeshBasicMaterial({
        map: paintPreviewTexture,
        transparent: true,
        alphaTest: 0.5,
        depthTest: true,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -10,
        side: THREE.DoubleSide,
        toneMapped: false,
      });
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
        paintPreviewTexture,
        paintPreviewMaterial,
        paintOverlayTargets: new Set(),
        paintPreviewOverlays: [],
        projectionCanvas: projection.canvas,
        projectionContext: projection.context,
        projectionTexture,
        maskCanvas: mask.canvas,
        maskContext: mask.context,
        maskTexture,
        maskMaterial,
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
    [paintTool],
  );

  const ensureOverlayForMesh = useCallback(
    (layer: UvPaintLayer, mesh: THREE.Mesh) => {
      if (layer.overlayTargets.has(mesh)) return;
      layer.overlayTargets.add(mesh);

      const maskOverlay = new THREE.Mesh(mesh.geometry, layer.maskMaterial);
      maskOverlay.name = 'Liclick Projected Inpaint Mask Overlay';
      maskOverlay.userData.liclickPaintOverlay = true;
      maskOverlay.userData.liclickInpaintMaskOverlay = true;
      maskOverlay.userData.liclickInpaintMaskTexture = layer.projectionTexture;
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

  const scheduleProjectionTextureUpdate = useCallback(
    (texture: THREE.CanvasTexture, immediate = false) => {
      const now = performance.now();
      const minimumIntervalMs = 1000 / 30;
      const remainingMs =
        minimumIntervalMs - (now - projectionTextureLastUpdateAtRef.current);

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

  useEffect(
    () => () => {
      if (textureUpdateFrameRef.current !== undefined)
        window.cancelAnimationFrame(textureUpdateFrameRef.current);
      textureUpdateFrameRef.current = undefined;
      dirtyTexturesRef.current.clear();
      if (projectionTextureUpdateTimerRef.current !== undefined)
        window.clearTimeout(projectionTextureUpdateTimerRef.current);
      projectionTextureUpdateTimerRef.current = undefined;
      if (localRepaintCommitTimerRef.current !== undefined)
        window.clearTimeout(localRepaintCommitTimerRef.current);
      localRepaintCommitTimerRef.current = undefined;
      if (localRepaintUvCommitTimerRef.current !== undefined)
        window.clearTimeout(localRepaintUvCommitTimerRef.current);
      localRepaintUvCommitTimerRef.current = undefined;
      localRepaintUvCommitRevisionRef.current += 1;
    },
    [],
  );

  useEffect(() => {
    localRepaintCommitRevisionRef.current += 1;
    localRepaintUvCommitRevisionRef.current += 1;
    if (localRepaintCommitTimerRef.current !== undefined)
      window.clearTimeout(localRepaintCommitTimerRef.current);
    localRepaintCommitTimerRef.current = undefined;
    if (localRepaintUvCommitTimerRef.current !== undefined)
      window.clearTimeout(localRepaintUvCommitTimerRef.current);
    localRepaintUvCommitTimerRef.current = undefined;
    const source = localRepaintProjectionSource;
    localRepaintAllowedMaskRef.current = undefined;
    localRepaintSourceImageRef.current = undefined;
    localRepaintCompositeRef.current = undefined;
    setLocalRepaintAssetsRevision(0);
    if (!source) {
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
        const allowedMaskData = maskContext.getImageData(
          0,
          0,
          maskCanvas.width,
          maskCanvas.height,
        );
        // Canvas destination-in uses alpha, while ComfyUI masks commonly store
        // coverage in RGB on an opaque black background. Convert luminance to
        // alpha once so brush edges and feathering cannot leak outside the mask.
        for (let offset = 0; offset < allowedMaskData.data.length; offset += 4) {
          const coverage = Math.max(
            allowedMaskData.data[offset],
            allowedMaskData.data[offset + 1],
            allowedMaskData.data[offset + 2],
          );
          allowedMaskData.data[offset] = 255;
          allowedMaskData.data[offset + 1] = 255;
          allowedMaskData.data[offset + 2] = 255;
          allowedMaskData.data[offset + 3] = Math.round(
            (coverage * allowedMaskData.data[offset + 3]) / 255,
          );
        }
        maskContext.putImageData(allowedMaskData, 0, 0);
        applyAutomaticInnerFeather(maskCanvas, allowedMaskData);
        const allowedAspect = maskCanvas.width / Math.max(maskCanvas.height, 1);
        const liveMaskCanvas = document.createElement('canvas');
        liveMaskCanvas.width =
          allowedAspect >= 1
            ? LOCAL_REPAINT_LIVE_MASK_MAX_SIZE
            : Math.max(1, Math.round(LOCAL_REPAINT_LIVE_MASK_MAX_SIZE * allowedAspect));
        liveMaskCanvas.height =
          allowedAspect >= 1
            ? Math.max(1, Math.round(LOCAL_REPAINT_LIVE_MASK_MAX_SIZE / allowedAspect))
            : LOCAL_REPAINT_LIVE_MASK_MAX_SIZE;
        const liveMaskContext = liveMaskCanvas.getContext('2d');
        if (!liveMaskContext) return;
        liveMaskContext.imageSmoothingEnabled = true;
        liveMaskContext.imageSmoothingQuality = 'high';
        liveMaskContext.drawImage(maskCanvas, 0, 0, liveMaskCanvas.width, liveMaskCanvas.height);
        localRepaintAllowedMaskRef.current = {
          url: source.allowedMaskUrl,
          canvas: liveMaskCanvas,
          context: liveMaskContext,
          data: allowedMaskData,
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
        setLocalRepaintAssetsRevision((revision) => revision + 1);
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
      return THREE.MathUtils.clamp(
        (maxDimension * setting * 0.45) / 700,
        maxDimension * 0.004,
        maxDimension * 0.18,
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
    if (isMaskBrush) {
      return THREE.MathUtils.lerp(
        INPAINT_BRUSH_MIN_TEXTURE_RADIUS,
        INPAINT_BRUSH_MAX_TEXTURE_RADIUS,
        normalizePaintMaskBrushSize(setting),
      );
    }
    return THREE.MathUtils.clamp(setting * 0.45, 1.5, 96);
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
      const screenUv = new THREE.Vector2(
        THREE.MathUtils.clamp((event.clientX - rect.left) / Math.max(rect.width, 1), 0, 1),
        THREE.MathUtils.clamp((event.clientY - rect.top) / Math.max(rect.height, 1), 0, 1),
      );
      pointerRef.current.set(screenUv.x * 2 - 1, -(screenUv.y * 2 - 1));
      raycasterRef.current.setFromCamera(pointerRef.current, camera);
      const hit = raycasterRef.current.intersectObjects(getPaintableMeshes(model), false)[0];
      if (!hit || !(hit.object instanceof THREE.Mesh) || !hit.face || !hit.uv) return undefined;
      const worldRadius = getBrushWorldRadius(model);
      const textureRadius = getBrushTextureRadius();
      const brushTransforms = isInpaintMode || isLocalRepaintApplyMode
          ? {
              uvBrush: createCircularBrushTransform(textureRadius),
              screenBrush: computeScreenBrushTransform(
                hit.object,
                hit.face,
                hit.point,
                camera,
                worldRadius,
                textureRadius,
              ),
            }
          : {
              uvBrush: createCircularBrushTransform(textureRadius),
              screenBrush: createCircularBrushTransform(textureRadius),
            };
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
        axisXRadius < 0.25 ||
        axisYRadius < 0.25
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

      context.save();
      context.globalCompositeOperation = compositeOperation;
      context.fillStyle = color;
      for (let index = 0; index <= segmentCount; index += 1) {
        const ratio = segmentCount === 0 ? 1 : index / segmentCount;
        const centerX = THREE.MathUtils.lerp(fromX, toX, ratio);
        const centerY = THREE.MathUtils.lerp(fromY, toY, ratio);
        context.setTransform(transformA, transformB, transformC, transformD, centerX, centerY);
        if (automaticFadeStamp) {
          context.drawImage(automaticFadeStamp, -1, -1, 2, 2);
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
      // A mask stroke may cross adjacent triangles whose UVs live on unrelated
      // islands. Interpolating between those UV coordinates paints a line through
      // the atlas and shows up as scattered marks elsewhere on the model. The
      // pointer path is already densely resampled, so stamp each new face without
      // connecting it to the previous face's UV coordinate.
      if (isMaskBrush) return sameFace ? previous.uv : undefined;
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
      // resolution and let the shader sample it linearly. A 384px live mask cuts
      // the per-frame texture upload almost in half compared with 512px.
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
      } else if (!existingLayer && localRepaintSource.targetLayerType === 'uv') {
        // A finished UV bake (or undo) removes the temporary projected preview.
        // Reusing its old mask would resurrect strokes from the previous session.
        composite.maskContext.clearRect(
          0,
          0,
          composite.maskCanvas.width,
          composite.maskCanvas.height,
        );
        markLiveProjectedCanvasTextureUpdated(composite.maskUrl);
      }
      if (!composite) return undefined;

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
        renderedColor: true,
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
      if (
        !existingLayer ||
        existingLayer.imageUrl !== projectedLayer.imageUrl ||
        existingLayer.maskUrl !== projectedLayer.maskUrl ||
        existingLayer.camera !== projectedLayer.camera ||
        existingLayer.objectId !== projectedLayer.objectId ||
        !existingLayer.needsRebake
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

  const resolveLocalRepaintStrokeSource = useCallback(
    (model: SurfacePaintTarget) => {
      const source = localRepaintProjectionSource;
      if (!source) return undefined;

      const layerState = useLayerStore.getState();
      const belongsToModel = (layer: Layer) => !layer.objectId || layer.objectId === model.objectId;
      const activeLayer = layerState.layers.find(
        (layer) => layer.id === layerState.activeProjectedLayerId,
      );
      const activeUvLayer =
        activeLayer?.type === 'uv' && activeLayer.visible && belongsToModel(activeLayer)
          ? activeLayer
          : undefined;
      const boundLayer = source.targetLayerId
        ? layerState.layers.find((layer) => layer.id === source.targetLayerId)
        : undefined;
      const boundUvLayer =
        boundLayer?.type === 'uv' && belongsToModel(boundLayer) ? boundLayer : undefined;
      const mergedUvLayer = layerState.layers.find((layer) =>
        isLocalRepaintUvMergeLayer(layer, model.objectId),
      );
      let targetLayer = activeUvLayer ?? boundUvLayer ?? mergedUvLayer;

      // Keep only a lightweight projected preview while the pointer is down.
      // Every finished burst is baked into this persistent UV layer, so different
      // views and generations accumulate without creating a projected layer per edit.
      if (!targetLayer) {
        targetLayer = {
          id: createId(LOCAL_REPAINT_UV_MERGE_LAYER_ID_PREFIX),
          name: LOCAL_REPAINT_UV_MERGE_LAYER_NAME,
          type: 'uv',
          imageUrl: '',
          objectId: model.objectId,
          renderedColor: true,
          visible: true,
          opacity: 1,
          strength: 1,
          blendMode: 'normal',
          adjustments: { hue: 0, saturation: 0, lightness: 0 },
          order: 0,
          isBaked: false,
          needsRebake: false,
          createdAt: new Date().toISOString(),
        };
        const nextLayers = [targetLayer, ...layerState.layers];
        layerState.setLayers(nextLayers);
        layerState.setActiveLayer(targetLayer.id);
        useProjectStore.getState().setProjectLayers(useLayerStore.getState().layers);
      } else if (!targetLayer.visible) {
        layerState.updateLayer(targetLayer.id, { visible: true });
        targetLayer = useLayerStore
          .getState()
          .layers.find((layer) => layer.id === targetLayer!.id)!;
      }
      if (
        source.targetLayerId === targetLayer.id &&
        source.targetLayerType === 'uv' &&
        source.targetLayerName === targetLayer.name
      ) {
        return source;
      }

      const nextSource: LocalRepaintProjectionSource = {
        ...source,
        targetLayerId: targetLayer.id,
        targetLayerType: 'uv',
        targetLayerName: targetLayer.name,
      };
      useSceneStore.getState().setLocalRepaintProjectionSource(nextSource);
      return nextSource;
    },
    [localRepaintProjectionSource],
  );

  useEffect(() => {
    if (
      !isLocalRepaintApplyMode ||
      !localRepaintProjectionSource ||
      localRepaintAssetsRevision <= 0
    )
      return;
    const model = getTargetModel();
    if (!model || !localRepaintSourceImageRef.current) return;
    const source = resolveLocalRepaintStrokeSource(model);
    if (source) ensureLiveLocalRepaintComposite(model, source);
  }, [
    ensureLiveLocalRepaintComposite,
    getTargetModel,
    isLocalRepaintApplyMode,
    localRepaintAssetsRevision,
    localRepaintProjectionSource,
    resolveLocalRepaintStrokeSource,
  ]);

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
    return allowedMask.data[offset + 3] > 24;
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

  const canConnectLocalRepaintStroke = useCallback(
    (from: THREE.Vector2 | undefined, to: THREE.Vector2) => {
      if (!from) return false;
      const allowedMask = localRepaintAllowedMaskRef.current?.data;
      const sourceData = localRepaintSourceImageRef.current?.data;
      if (!allowedMask || !sourceData) return false;
      const distancePx = Math.hypot(
        (to.x - from.x) * allowedMask.width,
        (to.y - from.y) * allowedMask.height,
      );
      const sampleCount = Math.min(96, Math.max(1, Math.ceil(distancePx / 2)));
      const sample = new THREE.Vector2();
      for (let index = 0; index <= sampleCount; index += 1) {
        sample.lerpVectors(from, to, index / sampleCount);
        if (!isInsideLocalRepaintAllowedMask(sample) || !hasLocalRepaintSourceContent(sample)) {
          return false;
        }
      }
      return true;
    },
    [hasLocalRepaintSourceContent, isInsideLocalRepaintAllowedMask],
  );

  const paintAt = useCallback(
    (result: UvPaintHit) => {
      const layer = getUvPaintLayer(result.model);
      const previousSample = lastSampleRef.current;
      const usesProjectionStroke = isInpaintMode || isLocalRepaintApplyMode;
      const fromUv = usesProjectionStroke ? undefined : getStrokeSourceUv(result);
      if (!usesProjectionStroke && !fromUv && previousSample && strokeTelemetryRef.current) {
        strokeTelemetryRef.current.continuityBreaks += 1;
      }
      // Local repaint paints a screen-space projection mask. It can safely keep
      // screen continuity across adjacent triangles even when their UV islands
      // are unrelated; the allowed mask clips the result on pointer-up.
      const previousScreenUv = lastSampleRef.current?.screenUv;
      const fromScreenUv = isLocalRepaintApplyMode
        ? canConnectLocalRepaintStroke(previousScreenUv, result.screenUv)
          ? previousScreenUv
          : undefined
        : isInpaintMode
          ? previousScreenUv
        : fromUv
          ? previousScreenUv
          : undefined;
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
          100,
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
        if (result.hit.object instanceof THREE.Mesh)
          ensureOverlayForMesh(layer, result.hit.object);
        const projectionBounds = drawSurfaceBrushSegment(
          layer.projectionContext,
          undefined,
          fromScreenUv,
          result.screenUv,
          result.screenBrush,
          '#ffffff',
          'source-over',
          'screen',
          255,
        );
        scheduleProjectionTextureUpdate(layer.projectionTexture);
        if (strokeDraftRef.current?.target === 'mask') {
          strokeDraftRef.current.bounds = unionDirtyRect(strokeDraftRef.current.bounds, projectionBounds);
        }
        maskDirtyRef.current = true;
        maskHasContentRef.current = true;
      } else if (paintTool === 'inpaint-subtract') {
        if (result.hit.object instanceof THREE.Mesh)
          ensureOverlayForMesh(layer, result.hit.object);
        const projectionBounds = drawSurfaceBrushSegment(
          layer.projectionContext,
          undefined,
          fromScreenUv,
          result.screenUv,
          result.screenBrush,
          '#ffffff',
          'destination-out',
          'screen',
          255,
        );
        scheduleProjectionTextureUpdate(layer.projectionTexture);
        if (strokeDraftRef.current?.target === 'mask') {
          strokeDraftRef.current.bounds = unionDirtyRect(strokeDraftRef.current.bounds, projectionBounds);
        }
        maskDirtyRef.current = true;
      } else if (paintTool === 'inpaint-apply') {
        const allowedMask = localRepaintAllowedMaskRef.current;
        const draft = strokeDraftRef.current;
        if (
          !draft?.localRepaintSource ||
          !localRepaintSourceImageRef.current ||
          !allowedMask ||
          !isInsideLocalRepaintAllowedMask(result.screenUv) ||
          !hasLocalRepaintSourceContent(result.screenUv)
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
        const projectionBounds = drawSurfaceBrushSegment(
          layer.projectionContext,
          undefined,
          fromScreenUv,
          result.screenUv,
          result.screenBrush,
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
          const composite = strokeDraftRef.current.localRepaintComposite;
          if (composite) {
            drawLocalRepaintStrokeMaskPatch(
              composite,
              allowedMask,
              layer.projectionCanvas,
              projectionBounds,
            );
            layer.projectionContext.clearRect(
              projectionBounds.x,
              projectionBounds.y,
              projectionBounds.width,
              projectionBounds.height,
            );
            strokeDraftRef.current.livePreviewUpdated = true;
          }
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
          sample.point.copy(result.hit.point);
          sample.screenBrushRadiusPx = result.screenBrushRadiusPx;
        } else {
          lastSampleRef.current = {
            meshUuid: result.hit.object.uuid,
            faceIndex: result.hit.faceIndex ?? undefined,
            uv: result.uv.clone(),
            screenUv: result.screenUv.clone(),
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
      drawBrushSegment,
      drawSurfaceBrushSegment,
      ensureOverlayForMesh,
      ensurePaintPreviewOverlayForMesh,
      getStrokeSourceUv,
      getUvPaintLayer,
      hasLocalRepaintSourceContent,
      isInsideLocalRepaintAllowedMask,
      isInpaintMode,
      isLocalRepaintApplyMode,
      paintTool,
      paintMaskSettings.brushOpacity,
      paintToolSettings.color,
      paintToolSettings.eraserHardness,
      scheduleProjectionTextureUpdate,
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
    (result: UvPaintHit) => {
      const layer = getUvPaintLayer(result.model);
      const target = isInpaintMode
        ? 'mask'
        : isLocalRepaintApplyMode
          ? 'apply-local-repaint'
          : 'paint';
      const localRepaintSource =
        target === 'apply-local-repaint'
          ? resolveLocalRepaintStrokeSource(result.model)
          : undefined;
      const localRepaintComposite =
        target === 'apply-local-repaint' && localRepaintSource
          ? ensureLiveLocalRepaintComposite(result.model, localRepaintSource)
          : undefined;
      if (target === 'mask') {
        // A full-model overlay duplicates every draw call as soon as the first
        // stroke starts. Add overlays lazily for only the meshes the brush
        // actually reaches; paintAt expands this set when a stroke crosses parts.
        if (result.hit.object instanceof THREE.Mesh)
          ensureOverlayForMesh(layer, result.hit.object);
        layer.overlayMeshes.forEach((mesh) => {
          if (mesh.userData.liclickInpaintMaskOverlay) mesh.visible = true;
        });
      }
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
        if (localRepaintSource?.targetLayerType === 'uv') {
          localRepaintUvCommitRevisionRef.current += 1;
          if (localRepaintUvCommitTimerRef.current !== undefined)
            window.clearTimeout(localRepaintUvCommitTimerRef.current);
          localRepaintUvCommitTimerRef.current = undefined;
        }
        // Match the responsive 512px mask-brush path while the pointer is down.
        // The touched rectangle is clipped and merged on pointer-up.
        const rect = gl.domElement.getBoundingClientRect();
        resizeProjectionCanvas(layer, rect.width / Math.max(rect.height, 1));
        layer.projectionContext.clearRect(
          0,
          0,
          layer.projectionCanvas.width,
          layer.projectionCanvas.height,
        );
        // Keep the live mask across strokes until the debounced UV bake finishes.
        // Clearing it here caused an extra GPU upload and dropped earlier strokes
        // whenever several strokes landed inside the same debounce window.
      } else if (target === 'mask' && !maskHasContentRef.current) {
        const rect = gl.domElement.getBoundingClientRect();
        resizeProjectionCanvas(layer, rect.width / Math.max(rect.height, 1));
        updateInpaintProjectionCamera(layer, camera);
        scheduleTextureUpdate(layer.projectionTexture);
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
        localRepaintSource,
        localRepaintComposite,
      };
    },
    [
      getUvPaintLayer,
      camera,
      gl.domElement,
      ensureOverlayForMesh,
      ensureLiveLocalRepaintComposite,
      isInpaintMode,
      isLocalRepaintApplyMode,
      paintTool,
      resolveLocalRepaintStrokeSource,
      scheduleTextureUpdate,
    ],
  );

  const commitPaintStroke = useCallback(() => {
    const draft = strokeDraftRef.current;
    const layer = draft?.layer;
    const localRepaintSource = draft?.localRepaintSource ?? localRepaintProjectionSource;
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
      if (draft.paintOperation === 'brush') thresholdCanvasAlpha(strokeCanvas);
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
        if (draft.paintOperation === 'brush') layer.paintContext.imageSmoothingEnabled = false;
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
      const composite = ensureLiveLocalRepaintComposite(model, localRepaintSource);
      if (!composite) return;

      // Normally each small dirty rectangle is already visible while dragging.
      // Keep this fallback for a stroke that started before its source finished loading.
      if (!draft.livePreviewUpdated) {
        drawLocalRepaintStrokeMaskPatch(
          composite,
          allowedMask,
          layer.projectionCanvas,
          draft.bounds,
        );
      }
      layer.projectionContext.clearRect(
        0,
        0,
        layer.projectionCanvas.width,
        layer.projectionCanvas.height,
      );

      if (localRepaintSource.targetLayerType === 'uv' && localRepaintSource.targetLayerId) {
        const targetLayerId = localRepaintSource.targetLayerId;
        const previewLayerId = composite.layerId;
        const commitRevision = localRepaintUvCommitRevisionRef.current + 1;
        localRepaintUvCommitRevisionRef.current = commitRevision;
        if (localRepaintUvCommitTimerRef.current !== undefined)
          window.clearTimeout(localRepaintUvCommitTimerRef.current);
        localRepaintUvCommitTimerRef.current = window.setTimeout(() => {
          localRepaintUvCommitTimerRef.current = undefined;

          const commitUvReplacement = async () => {
            if (localRepaintUvCommitRevisionRef.current !== commitRevision || isPaintingRef.current)
              return;
            const currentLayers = useLayerStore.getState().layers;
            const currentLayer = currentLayers.find((item) => item.id === targetLayerId);
            const previewLayer = currentLayers.find((item) => item.id === previewLayerId);
            if (!previewLayer) return;
            if (!currentLayer || currentLayer.type !== 'uv') {
              throw new Error('目标 UV 图层已不存在，请重新选择图层。');
            }

            // Freeze the accumulated mask only when the user has stopped painting.
            // Multiple quick strokes therefore share one expensive UV bake.
            const maskSnapshot = copyCanvasRect(composite.maskCanvas, {
              x: 0,
              y: 0,
              width: composite.maskCanvas.width,
              height: composite.maskCanvas.height,
            });
            // Bake an alpha-clipped image patch instead of passing the generated
            // image and brush mask as separate optional inputs. This makes the
            // painted stroke the only available source pixels, so a GPU fallback
            // or a failed optional-mask load can never reveal the whole generation.
            const patchSnapshot = createLocalRepaintPatchCanvas(sourceImage, maskSnapshot);
            const patchAssetUrl = registerLiveProjectedCanvasTexture(
              createId('local-repaint-uv-patch-image'),
              patchSnapshot,
              THREE.SRGBColorSpace,
            );
            const transientLayer: Layer = {
              ...previewLayer,
              id: createId('local-repaint-uv-patch'),
              imageUrl: patchAssetUrl,
              maskUrl: undefined,
              blendMode: 'overlay',
            };
            const priorLocalRepaintLayers = currentLayers.filter(
              (item) =>
                item.id !== previewLayerId &&
                item.visible &&
                isLocalRepaintProjectionLayer(item) &&
                (!item.objectId || item.objectId === model.objectId),
            );
            const layersToMerge = [
              ...priorLocalRepaintLayers.map((item) => ({
                ...item,
                blendMode: 'overlay' as const,
              })),
              transientLayer,
            ];
            const existingLiveCanvas = getLiveProjectedCanvasState(currentLayer.imageUrl)?.canvas;
            const layerIsRenderedColor = currentLayer.renderedColor || !currentLayer.imageUrl;
            const baseImage =
              !existingLiveCanvas && currentLayer.imageUrl
                ? await loadImageElement(currentLayer.imageUrl)
                : undefined;
            const fallbackResolution =
              UV_TEXTURE_RESOLUTION[useSettingsStore.getState().resolution];
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
              transientLayers: layersToMerge,
              resolution: bakeResolution,
              enableBackfaceCulling: true,
              enableDilation: false,
              dilationPixels: 0,
              outputAlpha: 'transparent',
              skipGpuValidation: true,
              minimumCoverageRatio: 0,
              commitToProject: false,
              markSourceLayersBaked: false,
              preferBlobOutput: false,
            });
            if (localRepaintUvCommitRevisionRef.current !== commitRevision) return;

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

            const assetUrl = registerLiveProjectedCanvasTexture(
              createId(`surface-edit:local-repaint:${targetLayerId}`),
              nextCanvas,
              THREE.SRGBColorSpace,
              { flipY: true },
            );
            markLiveProjectedCanvasTextureUpdated(assetUrl);
            const latestLayers = useLayerStore.getState().layers;
            const latestLayer = latestLayers.find((item) => item.id === targetLayerId);
            if (!latestLayer || !latestLayers.some((item) => item.id === previewLayerId)) return;
            const localRepaintLayerIds = new Set(
              latestLayers
                .filter(
                  (item) =>
                    isLocalRepaintProjectionLayer(item) &&
                    (!item.objectId || item.objectId === model.objectId),
                )
                .map((item) => item.id),
            );
            const nextLayers = latestLayers
              .filter((item) => !localRepaintLayerIds.has(item.id))
              .map((item) =>
                item.id === targetLayerId
                  ? {
                      ...item,
                      imageUrl: assetUrl,
                      renderedColor: layerIsRenderedColor,
                      contentRevision: (latestLayer.contentRevision ?? 0) + 1,
                      isBaked: false,
                      needsRebake: false,
                    }
                  : item,
              );
            useLayerStore.getState().setLayers(nextLayers);
            useLayerStore.getState().setActiveLayer(targetLayerId);
            useProjectStore.getState().setProjectLayers(nextLayers);
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
            if (localRepaintUvCommitRevisionRef.current !== commitRevision) return;
            const message = error instanceof Error ? error.message : '写入 UV 图层失败。';
            console.warn('[Liclick 3D Texture] Could not commit local repaint to UV layer:', error);
            pushToast({
              tone: 'error',
              title: 'UV 局部替换失败',
              description: message,
              dedupeKey: `local-repaint-uv-error:${targetLayerId}`,
            });
          });
        }, LOCAL_REPAINT_UV_COMMIT_DELAY_MS);
        return;
      }

      const commitRevision = localRepaintCommitRevisionRef.current + 1;
      localRepaintCommitRevisionRef.current = commitRevision;
      if (localRepaintCommitTimerRef.current !== undefined)
        window.clearTimeout(localRepaintCommitTimerRef.current);
      localRepaintCommitTimerRef.current = window.setTimeout(() => {
        localRepaintCommitTimerRef.current = undefined;
        const encodeAndPersist = () => {
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
                renderedColor: true,
                contentRevision: (existingLayer?.contentRevision ?? 0) + 1,
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
        };
        const requestIdle = window.requestIdleCallback;
        if (requestIdle) requestIdle(encodeAndPersist, { timeout: 400 });
        else encodeAndPersist();
      }, 160);
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
    const previousTouchAction = canvas.style.touchAction;
    if (enabled) canvas.style.touchAction = 'none';
    const isMaskStroke = isInpaintMode || isLocalRepaintApplyMode;
    const paintClientPath = (targets: ClientPoint[]) => {
      const telemetry = strokeTelemetryRef.current;
      const canvasRect = canvas.getBoundingClientRect();

      if (isMaskStroke) {
        // Projection-space masks only need the latest surface hit for each display
        // frame. The screen-space segment rasterizer fills the gap from the previous
        // hit, avoiding dozens of redundant BVH raycasts on dense meshes.
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
          paintAt(result);
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
          if (isMaskStroke) {
            lastUvRef.current = undefined;
            lastSampleRef.current = undefined;
          }
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
    const handlePointerMove = (event: globalThis.PointerEvent) => {
      if (isPaintingRef.current) {
        event.preventDefault();
        event.stopPropagation();
        const events = event.getCoalescedEvents?.() ?? [event];
        const targets = isMaskStroke
          ? [{ x: event.clientX, y: event.clientY }]
          : events.map((sampledEvent) => ({
              x: sampledEvent.clientX,
              y: sampledEvent.clientY,
            }));
        const finalTarget = targets[targets.length - 1];
        if (
          !isMaskStroke &&
          (!finalTarget || finalTarget.x !== event.clientX || finalTarget.y !== event.clientY)
        ) {
          targets.push({ x: event.clientX, y: event.clientY });
        }
        const telemetry = strokeTelemetryRef.current;
        if (telemetry) {
          telemetry.pointerEvents += 1;
          telemetry.coalescedEvents += events.length;
        }
        if (isMaskStroke) pendingPaintTargetsRef.current = targets;
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
      if (
        isLocalRepaintApplyMode &&
        (!isInsideLocalRepaintAllowedMask(result.screenUv) ||
          !hasLocalRepaintSourceContent(result.screenUv))
      )
        return;
      event.preventDefault();
      event.stopPropagation();
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
        const telemetry = strokeTelemetryRef.current;
        if (telemetry) {
          telemetry.pointerEvents += 1;
          telemetry.coalescedEvents += 1;
        }
        flushPendingPaintTargets([{ x: event.clientX, y: event.clientY }]);
      }
      isPaintingRef.current = false;
      lastPaintActivityAtRef.current = performance.now();
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
      activePointerIdRef.current = undefined;
      lastUvRef.current = undefined;
      lastSampleRef.current = undefined;
      lastPointerClientRef.current = undefined;
      setOrbitControlsEnabled(true);
      if (isInpaintMode && layerRef.current)
        scheduleProjectionTextureUpdate(layerRef.current.projectionTexture, true);
      commitPaintStroke();
      commitStrokeHistory();
      commitMaskIfDirty();
      finishStrokeTelemetry(event.type === 'pointercancel' ? 'pointercancel' : 'pointerup');
    };
    const handlePointerLeave = () => {
      cursorCircleRef.current?.setAttribute('visibility', 'hidden');
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
      if (isPaintingRef.current) flushPendingPaintTargets();
      pendingPaintTargetsRef.current = [];
      if (paintInputFrameRef.current !== undefined) {
        window.cancelAnimationFrame(paintInputFrameRef.current);
        paintInputFrameRef.current = undefined;
      }
      canvas.style.touchAction = previousTouchAction;
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
      gl.domElement.style.cursor = '';
    };
  }, [
    commitMaskIfDirty,
    beginStrokeHistory,
    commitPaintStroke,
    commitStrokeHistory,
    enabled,
    gl,
    hasLocalRepaintSourceContent,
    isInpaintMode,
    isInsideLocalRepaintAllowedMask,
    isLocalRepaintApplyMode,
    paintAt,
    scheduleProjectionTextureUpdate,
    paintTool,
    raycastModel,
    setOrbitControlsEnabled,
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
