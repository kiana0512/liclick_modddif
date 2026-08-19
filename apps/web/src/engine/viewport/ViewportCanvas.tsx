import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Bvh } from '@react-three/drei';
import {
  memo,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
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
  type PaintToolMode,
} from '@/stores/sceneStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useToastStore } from '@/stores/toastStore';
import { useT } from '@/stores/i18nStore';
import { useWorkspaceLayoutStore } from '@/components/workspace/workspaceLayoutStore';
import {
  getLiveProjectedCanvasState,
  getLiveProjectedCanvasTexture,
  getLiveProjectedTexture,
  markLiveProjectedCanvasTextureUpdated,
  registerLiveProjectedCanvasTexture,
  registerLiveProjectedImageTexture,
} from '@/engine/projection/liveProjectedCanvasTextureRegistry';
import { buildProjectionMatrixBundle } from '@/engine/projection/projectionMath';
import { createRuntimeProjectionDepth } from '@/engine/projection/createRuntimeProjectionDepth';
import {
  createProjectedLayerMaterial,
  disposeGeneratedMaterialTree,
  PROJECTED_LAYER_MATERIAL_USER_DATA_KEY,
  syncProjectedLayerLiveEraserPreviewInObject,
  syncProjectedLayerMaterialProjection,
} from '@/engine/projection/ProjectedLayerMaterial';
import {
  clearLiveSurfacePaintPreview,
  publishLiveSurfacePaintPreview,
} from '@/engine/paint/liveSurfacePaintPreviewRegistry';
import { serializeCamera } from '@/engine/projection/ProjectionCamera';
import { SceneRoot } from './SceneRoot';
import { getPreviewLighting } from './previewLighting';
import { CameraController } from './CameraController';
import { ViewCube } from './ViewCube';
import {
  isLocalRepaintOverlayVisible,
  syncLocalRepaintGpuOverlayBinding,
  syncLocalRepaintGpuOverlayLighting,
} from './localRepaintGpuOverlaySync';
import type { UvBakeResolution } from '@/engine/bake/uvBakeTypes';
import type { Layer } from '@/types/layer';
import type { SerializedCamera } from '@/types/capture';
import { createId } from '@/utils/id';
import { waitForBrowserPaint } from '@/utils/browserScheduling';
import { encodeProjectionMaskInWorker } from '@/engine/localRepaint/projectionMaskEncodeWorker';
import { getCanvasAlphaBoundsAsync } from '@/utils/getCanvasAlphaBounds';
import {
  applyTargetOnlyMaterial,
  cloneCameraForCaptureAspect,
  renderScenePassesToPngUrl,
} from '@/engine/capture/renderTargetUtils';
import {
  clearPerformanceTimelineEvents,
  getPerformanceTimelineEvents,
  markPerformanceEvent,
  setPerformanceTimelineEnabled,
  startPerformanceSpan,
  type PerformanceTimelineEvent,
} from '@/engine/performance/performanceTimeline';
import {
  sumDurationSamples,
  summarizeDurationSamples,
} from '@/engine/performance/performanceLabMetrics';
import {
  prepareGpuComputeBackend,
  type GpuComputeBackendCapability,
} from '@/engine/performance/gpuComputeBackend';
import {
  getNativePerformanceSnapshot,
  type NativePerformanceSnapshot,
} from '@/services/nativePerformanceClient';
import { registerPreviewTextureRenderer } from './previewTextureCache';
import { createLocalRepaintFalloffInWorker } from '@/engine/localRepaint/falloffWorker';
import { removeEdgeConnectedNeutralBackground } from '@/engine/localRepaint/resultPreviewUtils';
import {
  isViewportInteractionBusy,
  markViewportInteractionEnd,
} from './viewportInteractionState';
import {
  markEraserPerformanceEvent,
  measureEraserNextFrame,
  measureEraserPerformanceEvent,
} from '@/engine/performance/eraserPerformanceMonitor';

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
  importDisabled?: boolean;
  isActive?: boolean;
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

  useEffect(() => {
    registerPreviewTextureRenderer(gl);
    return () => registerPreviewTextureRenderer(undefined);
  }, [gl]);

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
// The generated source is sampled at its native resolution. Only the brush
// coverage is dynamic; a 1024px mask keeps soft edges crisp without uploading
// the multi-megapixel color source again on every pointer frame.
const LOCAL_REPAINT_LIVE_MASK_MAX_SIZE = 1024;
// The durable generated image may be 4K-16K. Painting only needs a responsive
// screen-space source; the original URL remains authoritative for persistence,
// export and final baking. Uploading a 16K texture in one gl.initTexture call
// produced 200-900ms presentation stalls on button 3.
// Interactive paint preview is intentionally capped at 1K. The original
// generated image remains untouched for durable projection/export; only the
// resident brush feedback texture is resized asynchronously. This keeps a
// first-time upload below one presentation budget instead of asking WebGL to
// synchronously upload a multi-megapixel/16K source on the main thread.
const LOCAL_REPAINT_LIVE_SOURCE_MAX_SIZE = 1024;
// Keep brush interaction on the lightweight projected preview, then promote the
// accumulated result to the selected UV resolution once the editor is idle.
// New paint input invalidates the queued commit, so the expensive pass never
// competes with an active stroke.
// Keep local repaint non-destructive while the user is interacting. The full
// resolution source plus its live mask are persisted as a projected layer and
// are rasterized into UV space by the existing export/explicit-merge path.
// Performing that 4K conversion after every brush burst rebuilt the whole
// projected stack and uploaded a new 4K viewport texture, producing 200-400ms
// presentation stalls even though the brush itself remained inside budget.
const LOCAL_REPAINT_INTERACTIVE_UV_BAKE_ENABLED = false;
const LOCAL_REPAINT_HIGH_RES_IDLE_MS = 3000;
const LOCAL_REPAINT_HANDOFF_DURATION_MS = 160;
const PROJECTED_ERASER_HIGH_RES_IDLE_MS = 3000;
// Depth is authoritative for generated local repaint sources. Keep only a
// near-grazing fallback guard for legacy sources without capture depth; a high
// face-on threshold creates permanent brush dead zones on curved/hard-edge
// geometry even though those pixels are visibly present in the generated view.
// Keep the editable footprint slightly inside the captured silhouette. The
// smooth shader feather runs from 0.08 to 0.16, so grazing side faces fade to
// the underlying UV instead of receiving a stretched repaint or a black seam.
const LOCAL_REPAINT_MINIMUM_FACE_ON = 0.08;
const INPAINT_BRUSH_MIN_WORLD_RADIUS_RATIO = 0.004;
const INPAINT_BRUSH_MAX_WORLD_RADIUS_RATIO = 0.12;
const INPAINT_BRUSH_MIN_TEXTURE_RADIUS = 1;
const INPAINT_BRUSH_MAX_TEXTURE_RADIUS = 72;
const LOCAL_REPAINT_PROJECTION_LAYER_ID_PREFIX = 'local-repaint-projection';
const LEGACY_LOCAL_REPAINT_PROJECTION_LAYER_ID_PREFIX = 'local-repaint-brush-projection';
const LOCAL_REPAINT_UV_MERGE_LAYER_ID_PREFIX = 'local-repaint-uv-merge';
const LOCAL_REPAINT_UV_MERGE_LAYER_NAME = '局部重绘合并层';

function isRendererOwnedLocalRepaintLayer(layer: Layer) {
  return Boolean(
    layer.id.startsWith('local-repaint-') ||
    layer.role === 'local-repaint-overlay' ||
    layer.role === 'local-repaint-draft' ||
    (layer.imageUrl ?? '').includes('surface-edit:local-repaint'),
  );
}

// Selection strokes are authored in projector space. A matching GPU depth
// snapshot prevents the same screen-space stamp from landing on every surface
// along that projector ray. The capture is refreshed only after the camera
// settles (or synchronously before the first stamp), never per pointer sample.
const INPAINT_DEPTH_CAPTURE_DELAY_MS = 80;
const INPAINT_DEPTH_EPSILON = 0.00002;
// Paint feedback is an editor overlay, not part of the texture layer stack.
// Keep it above projected textures, topology wireframes and selection helpers.
// The inpaint selection must be the final model-space overlay so its striped
// feedback cannot be covered by a paint preview or any texture-layer material.
const PAINT_STROKE_PREVIEW_RENDER_ORDER = 1000;
const INPAINT_MASK_OVERLAY_RENDER_ORDER = 1_000_000_000;
const LOCAL_REPAINT_OVERLAY_RENDER_ORDER = INPAINT_MASK_OVERLAY_RENDER_ORDER - 1;
const surfacePaintPerfSamples: number[] = [];
const gpuFrameTimeSamples: number[] = [];
const gpuFramePhaseTimeSamples: Array<{ durationMs: number; phase?: string }> = [];
const featheredBrushStampCache = new Map<number, HTMLCanvasElement>();
const paintBrushStampCache = new Map<string, HTMLCanvasElement>();
let surfacePaintPerfFrame: number | undefined;
let surfacePaintPerfLastPublishAt = 0;

function getFeatheredBrushStamp(featherPercent: number) {
  const key = Math.round(THREE.MathUtils.clamp(featherPercent, 0, 100));
  if (key <= 0) return undefined;
  const cached = featheredBrushStampCache.get(key);
  if (cached) return cached;
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const context = canvas.getContext('2d');
  if (!context) return undefined;
  const center = canvas.width / 2;
  const gradient = context.createRadialGradient(center, center, 0, center, center, center);
  const hardStop = 1 - key / 100;
  const featherStop = (ratio: number) => hardStop + (1 - hardStop) * ratio;
  const white = (alpha: number) => `rgba(255, 255, 255, ${alpha})`;
  gradient.addColorStop(0, white(1));
  if (hardStop > 0.001) gradient.addColorStop(hardStop, white(1));
  gradient.addColorStop(featherStop(0.25), white(0.84));
  gradient.addColorStop(featherStop(0.5), white(0.5));
  gradient.addColorStop(featherStop(0.75), white(0.16));
  gradient.addColorStop(1, white(0));
  context.fillStyle = gradient;
  context.fillRect(0, 0, canvas.width, canvas.height);
  featheredBrushStampCache.set(key, canvas);
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
    const queryPhases = new WeakMap<WebGLQuery, string | undefined>();
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
        const durationMs = elapsedNanoseconds / 1_000_000;
        gpuFrameTimeSamples.push(durationMs);
        gpuFramePhaseTimeSamples.push({ durationMs, phase: queryPhases.get(query) });
        if (gpuFrameTimeSamples.length > 240) gpuFrameTimeSamples.shift();
        if (gpuFramePhaseTimeSamples.length > 240) gpuFramePhaseTimeSamples.shift();
      }
    };
    const wrappedRender: typeof gl.render = (scene, camera) => {
      pollQueries();
      const query = pendingQueries.length < 8 ? context.createQuery() : null;
      let queryStarted = false;
      if (query) {
        try {
          context.beginQuery(extension.TIME_ELAPSED_EXT, query);
          queryPhases.set(
            query,
            document.body.dataset.perfLayerTogglePhase ??
              document.body.dataset.perfUvBakePhase ??
              document.body.dataset.perfContentAwareRepairPhase ??
              document.body.dataset.perfViewportStressPhase ??
              document.body.dataset.perfScenarioPhase,
          );
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
  frameMax: number;
  droppedFrames: number;
  paintP95: number;
  paintMax: number;
  paintSamples: number;
  cpuLongTaskPercent: number;
  gpuP95: number;
  gpuSamples: number;
  heapUsedMb?: number;
  heapLimitMb?: number;
  samplerP95: number;
  samplerMax: number;
  samplerSamples: number;
};

function isPerformanceInstrumentationEnabled() {
  if (useSettingsStore.getState().performanceTestModeEnabled) return true;
  return (
    typeof window !== 'undefined' &&
    new URLSearchParams(window.location.search).get('perfLab') === '1'
  );
}

const performanceAutoOrbitAxis = new THREE.Vector3(0, 1, 0);

function PerformanceAutoOrbit({ enabled }: { enabled: boolean }) {
  const { camera } = useThree();
  useFrame((_state, delta) => {
    if (!enabled && document.body.dataset.perfAutoOrbit !== '1') return;
    camera.position.applyAxisAngle(performanceAutoOrbitAxis, delta * 0.32);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
  });
  return null;
}

type PerformanceFrameSample = { unixMs: number; durationMs: number; phase?: string };
type PerformanceLongTaskSample = { unixMs: number; durationMs: number };
type ProjectedLayerRampResult = {
  protectedFrameP95: number;
  protectedFrameMax: number;
  protectedDroppedFrames: number;
  publishFrameP95: number;
  publishFrameMax: number;
  publishDroppedFrames: number;
};

type LayerToggleScenarioResult = ProjectedLayerRampResult & {
  scenario: 'projected' | 'content-aware' | 'uv-projected';
  operations: number;
  durationMs: number;
};

type ViewportLayerStressResult = {
  operations: number;
  durationMs: number;
  frameP95: number;
  frameMax: number;
  droppedFrames: number;
  projectedBackgroundRebuilds: number;
  modeStateMismatches: number;
  overlayVisibilityMismatches: number;
  phaseFrameMax?: Record<string, number>;
};

type LocalRepaintUvCommitReport = {
  mode: 'interactive-uv' | 'deferred-export';
  revision: number;
  resolution: number;
  maskSnapshotMs: number;
  idleWaitMs: number;
  gpuBakeMs: number;
  mergeAndPublishMs: number;
  totalMs: number;
  coveredPixels: number;
  coverageRatio: number;
  bakePerformanceBreakdown: Record<string, number>;
};

type LocalRepaintSimulationCoreResult = {
  sourceWidth: number;
  sourceHeight: number;
  candidateCount: number;
  maskAddSamples: number;
  maskSubtractSamples: number;
  maskRestoreSamples: number;
  applyStrokes: number;
  applySamples: number;
  maskDurationMs: number;
  button2MaskCaptureMs: number;
  button2MaskProjectionCount: number;
  button2InputTotalMs: number;
  button2InputWorkerMs: number;
  applyDurationMs: number;
  activationReadyMs: number;
  activationToFirstVisibleMs: number;
  liveFeedbackP95: number;
  liveFeedbackMax: number;
  gpuVisiblePixels: number;
  gpuMaxAlpha: number;
  gpuSceneChangedPixels: number;
  gpuSceneMaxDelta: number;
  gpuProbeDurationMs: number;
  projectedBackgroundRebuilds: number;
  firstGeneratedCandidateScanMs: number;
  falloffReadMs: number;
  candidateRaycastMs: number;
  candidateFilterMs: number;
  uvCommit: LocalRepaintUvCommitReport;
  totalDurationMs: number;
};

type LocalRepaintBenchmarkResult = LocalRepaintSimulationCoreResult & {
  protectedFrameP95: number;
  protectedFrameMax: number;
  protectedDroppedFrames: number;
  publishFrameP95: number;
  publishFrameMax: number;
  publishDroppedFrames: number;
  heapDeltaMb: number;
  phaseFrameMax: Record<string, number>;
};

type LocalRepaintPerformanceApi = {
  run: () => Promise<LocalRepaintSimulationCoreResult>;
};

type LocalRepaintSourcePerformanceApi = {
  prepareLatestGeneratedSource: () => Promise<void>;
};

type LocalRepaintButton2PerformanceApi = {
  prepareInput: (
    sourceUrl: string,
    maskUrl: string,
    width: number,
    height: number,
  ) => Promise<{ totalMs: number; workerMs: number }>;
};

type UvMergeBenchmarkResult = {
  resolution: number;
  projectedLayerCount: number;
  uvLayerCount: number;
  gpuBakeDurationMs: number;
  readbackDurationMs: number;
  uvCompositeDurationMs: number;
  pngEncodeDurationMs: number;
  previewPrewarmDurationMs?: number;
  previewPrewarmReady?: boolean;
  totalDurationMs: number;
  outputBytes: number;
  coverageRatio: number;
  bakePerformanceBreakdown: Record<string, number>;
  webGpuComposite?: {
    enabled: boolean;
    abEnabled: boolean;
    dispatches: number;
    fallbackCount: number;
    uploadMs: number;
    computeMs: number;
    readbackMs: number;
    totalMs: number;
    byteMismatches: number;
    maximumByteDelta: number;
    chunkMb: number;
    firstMismatch?: {
      byteOffset: number;
      expectedRgba: number[];
      actualRgba: number[];
    };
  };
  protectedFrameP95: number;
  protectedFrameMax: number;
  protectedDroppedFrames: number;
  fullFrameP95?: number;
  fullFrameMax?: number;
  fullDroppedFrames?: number;
  phaseFrameMax: Record<string, number>;
};

type RefreshRestoreBenchmarkResult = {
  success: boolean;
  totalMs: number;
  hydratedMs: number;
  modelFullMs: number;
  uvReadyMs: number;
  projectedReadyMs: number;
  uvPrewarmMs: number;
  expectedLayers: number;
  expectedUvLayers: number;
  expectedProjectedLayers: number;
  expectedLocalRepaintLayers: number;
  loadedProjectedLayers: number;
  loadedLocalRepaintLayers: number;
  frameP95: number;
  frameMax: number;
  droppedFrames: number;
  longTaskMax: number;
};

type ContentAwareRepairBenchmarkResult = {
  status: 'complete' | 'no-gaps';
  resolution: number;
  projectedLayerCount: number;
  repairedPixels: number;
  outputChecksum: number;
  totalDurationMs: number;
  publishToVisibleMs: number;
  phaseDurationsMs: Record<string, number>;
  bakePerformanceBreakdown: Record<string, number>;
  frameP95: number;
  frameMax: number;
  droppedFrames: number;
  protectedFrameP95: number;
  protectedFrameMax: number;
  protectedDroppedFrames: number;
  phaseFrameMax: Record<string, number>;
  projectedMaterialRebuilds: number;
  underlaySafe: boolean;
  textureReady: boolean;
  eyeVisible: boolean;
  effectiveOpacity: number;
  originalStateRestored: boolean;
};

const REFRESH_RESTORE_BENCHMARK_KEY = 'liclick:perf-refresh-restore';

type PerformanceLabWindowApi = {
  clear: () => void;
  exportReport: () => void;
  copyReport: () => Promise<void>;
  runProjectedLayerRamp: (options?: { intervalMs?: number }) => Promise<{
    added: number;
    durationMs: number;
    restored: boolean;
  }>;
  runLayerToggleScenario: (
    scenario: 'projected' | 'content-aware' | 'uv-projected',
    options?: { intervalMs?: number },
  ) => Promise<LayerToggleScenarioResult>;
  runUvMergeBenchmark: () => Promise<UvMergeBenchmarkResult>;
  runLocalRepaintBenchmark: () => Promise<LocalRepaintBenchmarkResult>;
  runViewportLayerStressScenario: () => Promise<ViewportLayerStressResult>;
  runContentAwareRepairBenchmark: () => Promise<ContentAwareRepairBenchmarkResult>;
  runRefreshRestoreBenchmark: () => void;
  snapshot: () => {
    metrics: PerformanceHudMetrics;
    native?: NativePerformanceSnapshot;
    events: PerformanceTimelineEvent[];
    manualLocalRepaint?: ManualRepaintReport;
  };
};

const Sparkline = memo(function Sparkline({ values, color }: { values: number[]; color: string }) {
  const width = 220;
  const height = 46;
  const maximum = Math.max(1, ...values);
  const points = values
    .map((value, index) => {
      const x = values.length <= 1 ? 0 : (index / (values.length - 1)) * width;
      const y = height - (value / maximum) * (height - 3) - 1.5;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="h-12 w-full" preserveAspectRatio="none">
      <path d={`M0 ${height - 1}H${width}`} stroke="rgba(255,255,255,.10)" />
      <polyline fill="none" stroke={color} strokeWidth="2" points={points} />
    </svg>
  );
});

function buildPerformanceAnalysis(
  metrics: PerformanceHudMetrics,
  nativeSnapshot?: NativePerformanceSnapshot,
) {
  const findings: string[] = [];
  const gpu = nativeSnapshot?.gpu.adapters[0];
  const maximumCore = Math.max(
    0,
    ...(nativeSnapshot?.cpu.cores.map((core) => core.utilizationPercent) ?? []),
  );
  if (metrics.frameP95 > 20 || metrics.frameMax > 50) {
    findings.push(
      `出帧不稳定：P95 ${metrics.frameP95.toFixed(1)}ms，最大 ${metrics.frameMax.toFixed(1)}ms。`,
    );
  }
  if (metrics.cpuLongTaskPercent > 5) {
    findings.push(
      `浏览器主线程长任务占比 ${metrics.cpuLongTaskPercent.toFixed(1)}%，优先排查同步 JS、像素读回和 React 提交。`,
    );
  }
  if (
    nativeSnapshot &&
    nativeSnapshot.cpu.overallUtilizationPercent < 45 &&
    maximumCore > 80 &&
    metrics.cpuLongTaskPercent > 2
  ) {
    findings.push(
      `疑似单核瓶颈：整机 CPU ${nativeSnapshot.cpu.overallUtilizationPercent.toFixed(0)}%，最忙逻辑核 ${maximumCore.toFixed(0)}%。`,
    );
  }
  if ((gpu?.utilizationGpuPercent ?? 0) > 85 && metrics.gpuP95 > 14) {
    findings.push(
      `疑似 GPU 帧预算受限：GPU ${gpu?.utilizationGpuPercent?.toFixed(0)}%，GPU P95 ${metrics.gpuP95.toFixed(1)}ms。`,
    );
  }
  if ((nativeSnapshot?.memory.usedPercent ?? 0) > 85) {
    findings.push(`系统内存压力较高：${nativeSnapshot?.memory.usedPercent.toFixed(0)}%。`);
  }
  if (findings.length === 0) findings.push('当前窗口未检出明确瓶颈；请运行完整场景并导出报告。');
  return findings;
}

function metricTone(value: number, good: number, warning: number, higherIsBetter = false) {
  const goodValue = higherIsBetter ? value >= good : value <= good;
  const warningValue = higherIsBetter ? value >= warning : value <= warning;
  if (goodValue) return 'text-emerald-300';
  if (warningValue) return 'text-amber-300';
  return 'text-rose-300';
}

const PerformanceMetric = memo(function PerformanceMetric({
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
});

function hasFiniteMetricFields(value: unknown, fields: readonly string[]) {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return fields.every(
    (field) => typeof record[field] === 'number' && Number.isFinite(record[field]),
  );
}

function isVerbosePaintLoggingEnabled() {
  return (
    typeof window !== 'undefined' &&
    new URLSearchParams(window.location.search).get('paintVerbose') === '1'
  );
}

type ManualRepaintEvent = {
  type: string;
  unixMs: number;
  elapsedMs: number;
  latencyToFrameMs?: number;
  detail?: Record<string, unknown>;
};

type ManualRepaintReport = {
  startedAtUnixMs: number;
  endedAtUnixMs: number;
  durationMs: number;
  frames: number;
  averageFps: number;
  frameP95: number;
  frameMax: number;
  droppedFrames: number;
  pointerDownP95: number;
  pointerUpP95: number;
  wheelEvents: number;
  strokes: number;
  layerActions: number;
  longTasks: number;
  longTaskMax: number;
  heapDeltaMb: number;
  heapStartMb?: number;
  heapEndMb?: number;
  frameSamples: PerformanceFrameSample[];
  longTaskSamples: PerformanceLongTaskSample[];
  nativeSamples: NativePerformanceSnapshot[];
  timelineEvents: PerformanceTimelineEvent[];
  diagnosticsAtStart: Record<string, string>;
  diagnosticsAtEnd: Record<string, string>;
  eventRetentionLimit: number;
  events: ManualRepaintEvent[];
};

const MAX_MANUAL_REPAINT_EVENTS = 12_000;
const MANUAL_REPAINT_REPORT_STORAGE_KEY = 'liclick:performance:manual-report:v2';

function appendManualRepaintEvent(events: ManualRepaintEvent[], event: ManualRepaintEvent) {
  events.push(event);
  const overflow = events.length - MAX_MANUAL_REPAINT_EVENTS;
  if (overflow > 0) events.splice(0, overflow);
}

function snapshotPerformanceDiagnostics() {
  return Object.fromEntries(
    Object.entries(document.body.dataset).flatMap(([key, value]) =>
      value !== undefined &&
      (key.startsWith('perf') ||
        key.startsWith('localRepaint') ||
        key.startsWith('projected') ||
        key.startsWith('textureRestore') ||
        key.startsWith('webgl'))
        ? [[key, value] as const]
        : [],
    ),
  );
}

function readUsedJsHeapMb() {
  const memory = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
  return memory ? memory.usedJSHeapSize / 1024 / 1024 : undefined;
}

function readStoredManualRepaintReport() {
  try {
    const value = window.sessionStorage.getItem(MANUAL_REPAINT_REPORT_STORAGE_KEY);
    return value ? (JSON.parse(value) as ManualRepaintReport) : undefined;
  } catch {
    return undefined;
  }
}

function LightweightPerformanceHud() {
  const [sample, setSample] = useState({ fps: 0, p95: 0, max: 0 });
  useEffect(() => {
    let frame = 0;
    let previous = performance.now();
    let published = previous;
    const samples: number[] = [];
    const tick = (now: number) => {
      const duration = now - previous;
      previous = now;
      if (duration > 0 && duration < 1_000) {
        samples.push(duration);
        if (samples.length > 180) samples.shift();
      }
      if (now - published >= 500 && samples.length) {
        published = now;
        const recent = samples.slice(-120);
        const total = recent.reduce((sum, value) => sum + value, 0);
        setSample({
          fps: total > 0 ? (recent.length * 1_000) / total : 0,
          p95: percentile(recent, 0.95),
          max: Math.max(...recent),
        });
      }
      frame = window.requestAnimationFrame(tick);
    };
    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, []);
  const severe = sample.p95 > 25 || sample.fps < 45;
  const warning = sample.p95 > 18 || sample.fps < 57;
  return (
    <div
      className={`pointer-events-none absolute right-4 top-4 z-[28] grid grid-cols-[auto_auto_auto_auto] items-center gap-4 rounded-md border px-3 py-2 text-white shadow-xl backdrop-blur-md ${severe ? 'border-red-500/70 bg-red-950/78' : warning ? 'border-amber-400/60 bg-black/82' : 'border-emerald-400/45 bg-black/78'}`}
    >
      <span
        className={`text-xs font-semibold ${severe ? 'text-red-300' : warning ? 'text-amber-300' : 'text-emerald-300'}`}
      >
        ● {severe ? '严重卡顿' : warning ? '卡顿' : '流畅'}
      </span>
      <span className="text-[10px] text-white/50">
        帧率 <b className="ml-1 font-mono text-xs text-white">{sample.fps.toFixed(0)} FPS</b>
      </span>
      <span className="text-[10px] text-white/50">
        延迟 P95 <b className="ml-1 font-mono text-xs text-white">{sample.p95.toFixed(1)} ms</b>
      </span>
      <span className="text-[10px] text-white/50">
        最大帧 <b className="ml-1 font-mono text-xs text-white">{sample.max.toFixed(1)} ms</b>
      </span>
    </div>
  );
}

function PerformanceTestHud() {
  const [collapsed, setCollapsed] = useState(true);
  const [manualRecording, setManualRecording] = useState(false);
  const [manualReport, setManualReport] = useState<ManualRepaintReport | undefined>(
    readStoredManualRepaintReport,
  );
  const manualStartedAtRef = useRef(0);
  const manualStartedUnixMsRef = useRef(0);
  const manualHeapStartMbRef = useRef<number>();
  const manualDiagnosticsStartRef = useRef<Record<string, string>>({});
  const manualEventsRef = useRef<ManualRepaintEvent[]>([]);
  const [nativeSnapshot, setNativeSnapshot] = useState<NativePerformanceSnapshot>();
  const [nativeError, setNativeError] = useState<string>();
  const [computeBackend, setComputeBackend] = useState<GpuComputeBackendCapability>();
  const [recentEvents, setRecentEvents] = useState<PerformanceTimelineEvent[]>([]);
  const [frameHistory, setFrameHistory] = useState<number[]>([]);
  const [cpuHistory, setCpuHistory] = useState<number[]>([]);
  const [gpuHistory, setGpuHistory] = useState<number[]>([]);
  const [projectedLayerRamp, setProjectedLayerRamp] = useState<{
    running: boolean;
    current: number;
    total: number;
  }>({ running: false, current: 0, total: 14 });
  const [projectedLayerRampResult, setProjectedLayerRampResult] =
    useState<ProjectedLayerRampResult>();
  const [layerToggleScenario, setLayerToggleScenario] = useState<{
    running: boolean;
    scenario?: 'projected' | 'content-aware' | 'uv-projected';
  }>({ running: false });
  const [layerToggleScenarioResult, setLayerToggleScenarioResult] =
    useState<LayerToggleScenarioResult>();
  const [uvMergeBenchmarkRunning, setUvMergeBenchmarkRunning] = useState(false);
  const [rawUvMergeBenchmarkResult, setUvMergeBenchmarkResult] = useState<UvMergeBenchmarkResult>();
  const [localRepaintBenchmarkRunning, setLocalRepaintBenchmarkRunning] = useState(false);
  const [rawLocalRepaintBenchmarkResult, setLocalRepaintBenchmarkResult] =
    useState<LocalRepaintBenchmarkResult>();
  // Vite preserves hook state across hot updates. A phase-7 result produced by
  // an older metric schema must never crash the editor while the HUD renders a
  // newly added field. Treat incomplete snapshots as unavailable until a fresh
  // run publishes the complete atomic result.
  const uvMergeBenchmarkResult =
    rawUvMergeBenchmarkResult?.bakePerformanceBreakdown &&
    rawUvMergeBenchmarkResult.phaseFrameMax &&
    hasFiniteMetricFields(rawUvMergeBenchmarkResult, [
      'protectedFrameP95',
      'protectedFrameMax',
      'gpuBakeDurationMs',
      'readbackDurationMs',
      'pngEncodeDurationMs',
      'outputBytes',
      'coverageRatio',
      'uvCompositeDurationMs',
    ])
      ? rawUvMergeBenchmarkResult
      : undefined;
  const localRepaintBenchmarkResult =
    rawLocalRepaintBenchmarkResult?.uvCommit &&
    rawLocalRepaintBenchmarkResult.phaseFrameMax &&
    hasFiniteMetricFields(rawLocalRepaintBenchmarkResult, [
      'protectedFrameP95',
      'protectedFrameMax',
      'publishFrameP95',
      'publishFrameMax',
      'liveFeedbackP95',
      'liveFeedbackMax',
      'activationReadyMs',
      'activationToFirstVisibleMs',
      'button2MaskCaptureMs',
      'button2InputTotalMs',
      'button2InputWorkerMs',
      'heapDeltaMb',
      'firstGeneratedCandidateScanMs',
      'falloffReadMs',
      'candidateRaycastMs',
      'candidateFilterMs',
      'gpuProbeDurationMs',
    ]) &&
    hasFiniteMetricFields(rawLocalRepaintBenchmarkResult.uvCommit, [
      'idleWaitMs',
      'mergeAndPublishMs',
    ])
      ? rawLocalRepaintBenchmarkResult
      : undefined;
  const [viewportLayerStressRunning, setViewportLayerStressRunning] = useState(false);
  const [viewportLayerStressResult, setViewportLayerStressResult] =
    useState<ViewportLayerStressResult>();
  const [refreshRestoreBenchmarkRunning, setRefreshRestoreBenchmarkRunning] = useState(
    () => window.sessionStorage.getItem(REFRESH_RESTORE_BENCHMARK_KEY) === '1',
  );
  const [refreshRestoreBenchmarkResult, setRefreshRestoreBenchmarkResult] =
    useState<RefreshRestoreBenchmarkResult>();
  const [contentAwareRepairBenchmarkRunning, setContentAwareRepairBenchmarkRunning] =
    useState(false);
  const [contentAwareRepairBenchmarkResult, setContentAwareRepairBenchmarkResult] =
    useState<ContentAwareRepairBenchmarkResult>();
  const projectedLayerRampRunningRef = useRef(false);
  const layerToggleScenarioRunningRef = useRef(false);
  const frameSamplesRef = useRef<PerformanceFrameSample[]>([]);
  const longTaskSamplesRef = useRef<PerformanceLongTaskSample[]>([]);
  const longAnimationFrameSamplesRef = useRef<
    Array<{
      durationMs: number;
      blockingDurationMs: number;
      renderDurationMs: number;
      styleAndLayoutDurationMs: number;
      phase?: string;
      scripts: Array<{ durationMs: number; invoker?: string; sourceFunctionName?: string }>;
    }>
  >([]);
  const nativeSamplesRef = useRef<NativePerformanceSnapshot[]>([]);
  const samplerOverheadSamplesRef = useRef<PerformanceLongTaskSample[]>([]);
  const recordingStartedAtRef = useRef(Date.now());
  const [metrics, setMetrics] = useState<PerformanceHudMetrics>({
    fps: 0,
    frameP95: 0,
    frameMax: 0,
    droppedFrames: 0,
    paintP95: 0,
    paintMax: 0,
    paintSamples: 0,
    cpuLongTaskPercent: 0,
    gpuP95: 0,
    gpuSamples: 0,
    samplerP95: 0,
    samplerMax: 0,
    samplerSamples: 0,
  });

  useEffect(() => {
    if (!manualRecording) return;
    const startedAt = manualStartedAtRef.current;
    let wheelFrame = 0;
    let pendingWheel:
      | {
          deltaX: number;
          deltaY: number;
          deltaMode: number;
          rawEventCount: number;
          lastEventTime: number;
        }
      | undefined;
    const record = (type: string, detail?: Record<string, unknown>, eventTime?: number) => {
      const item: ManualRepaintEvent = {
        type,
        unixMs: Date.now(),
        elapsedMs: performance.now() - startedAt,
        detail,
      };
      appendManualRepaintEvent(manualEventsRef.current, item);
      if (eventTime !== undefined) {
        window.requestAnimationFrame((frameAt) => {
          item.latencyToFrameMs = Math.max(0, frameAt - eventTime);
        });
      }
    };
    const onPointerDown = (event: globalThis.PointerEvent) =>
      record(
        'pointerdown',
        { button: event.button, x: event.clientX, y: event.clientY, pressure: event.pressure },
        event.timeStamp,
      );
    const onPointerUp = (event: globalThis.PointerEvent) =>
      record(
        'pointerup',
        { button: event.button, x: event.clientX, y: event.clientY, pressure: event.pressure },
        event.timeStamp,
      );
    const onWheel = (event: globalThis.WheelEvent) => {
      if (pendingWheel) {
        pendingWheel.deltaX += event.deltaX;
        pendingWheel.deltaY += event.deltaY;
        pendingWheel.deltaMode = event.deltaMode;
        pendingWheel.rawEventCount += 1;
        pendingWheel.lastEventTime = event.timeStamp;
      } else {
        pendingWheel = {
          deltaX: event.deltaX,
          deltaY: event.deltaY,
          deltaMode: event.deltaMode,
          rawEventCount: 1,
          lastEventTime: event.timeStamp,
        };
      }
      if (wheelFrame !== 0) return;
      wheelFrame = window.requestAnimationFrame((frameAt) => {
        wheelFrame = 0;
        const sample = pendingWheel;
        pendingWheel = undefined;
        if (!sample) return;
        appendManualRepaintEvent(manualEventsRef.current, {
          type: 'wheel',
          unixMs: Date.now(),
          elapsedMs: performance.now() - startedAt,
          latencyToFrameMs: Math.max(0, frameAt - sample.lastEventTime),
          detail: sample,
        });
      });
    };
    const onClick = (event: MouseEvent) => {
      const target = event.target instanceof HTMLElement ? event.target : undefined;
      if (target?.closest('[data-layer-id], [data-layer-row], [aria-label*="图层"]')) {
        record('layer-action', { text: target.textContent?.trim().slice(0, 80) });
      }
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('pointerup', onPointerUp, true);
    window.addEventListener('wheel', onWheel, true);
    window.addEventListener('click', onClick, true);
    return () => {
      if (wheelFrame !== 0) window.cancelAnimationFrame(wheelFrame);
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('pointerup', onPointerUp, true);
      window.removeEventListener('wheel', onWheel, true);
      window.removeEventListener('click', onClick, true);
    };
  }, [manualRecording]);

  const toggleManualRecording = useCallback(() => {
    if (!manualRecording) {
      manualStartedAtRef.current = performance.now();
      manualStartedUnixMsRef.current = Date.now();
      manualHeapStartMbRef.current = readUsedJsHeapMb();
      manualDiagnosticsStartRef.current = snapshotPerformanceDiagnostics();
      manualEventsRef.current = [];
      setManualReport(undefined);
      document.body.dataset.perfManualLocalRepaintRecording = '1';
      setManualRecording(true);
      return;
    }
    const endedAt = Date.now();
    const startedUnixMs =
      manualStartedUnixMsRef.current || endedAt - (performance.now() - manualStartedAtRef.current);
    const frames = frameSamplesRef.current.filter(
      (sample) => sample.unixMs >= startedUnixMs && sample.unixMs <= endedAt,
    );
    const frameTimes = frames.map((sample) => sample.durationMs);
    const targetMs =
      percentile(
        frameTimes.filter((value) => value < 40),
        0.1,
      ) || 16.67;
    const longTasks = longTaskSamplesRef.current.filter(
      (sample) => sample.unixMs >= startedUnixMs && sample.unixMs <= endedAt,
    );
    const nativeSamples = nativeSamplesRef.current.filter(
      (sample) => sample.sampledAtUnixMs >= startedUnixMs && sample.sampledAtUnixMs <= endedAt,
    );
    const timelineEvents = getPerformanceTimelineEvents().filter(
      (event) => event.unixMs >= startedUnixMs && event.unixMs <= endedAt,
    );
    const heapEndMb = readUsedJsHeapMb();
    const heapStartMb = manualHeapStartMbRef.current;
    const events = manualEventsRef.current.slice();
    const latency = (type: string) =>
      events.filter((event) => event.type === type).map((event) => event.latencyToFrameMs ?? 0);
    const max = (values: number[]) => (values.length ? Math.max(...values) : 0);
    const total = frameTimes.reduce((sum, value) => sum + value, 0);
    const report: ManualRepaintReport = {
      startedAtUnixMs: startedUnixMs,
      endedAtUnixMs: endedAt,
      durationMs: Math.max(0, endedAt - startedUnixMs),
      frames: frameTimes.length,
      averageFps: total > 0 ? (frameTimes.length * 1000) / total : 0,
      frameP95: percentile(frameTimes, 0.95),
      frameMax: max(frameTimes),
      droppedFrames: frameTimes.filter((value) => value > targetMs * 1.5).length,
      pointerDownP95: percentile(latency('pointerdown'), 0.95),
      pointerUpP95: percentile(latency('pointerup'), 0.95),
      wheelEvents: events
        .filter((event) => event.type === 'wheel')
        .reduce(
          (count, event) =>
            count +
            (typeof event.detail?.rawEventCount === 'number' ? event.detail.rawEventCount : 1),
          0,
        ),
      strokes: events.filter((event) => event.type === 'pointerup').length,
      layerActions: events.filter((event) => event.type === 'layer-action').length,
      longTasks: longTasks.length,
      longTaskMax: max(longTasks.map((sample) => sample.durationMs)),
      heapDeltaMb:
        heapStartMb !== undefined && heapEndMb !== undefined ? heapEndMb - heapStartMb : 0,
      heapStartMb,
      heapEndMb,
      frameSamples: frames,
      longTaskSamples: longTasks,
      nativeSamples,
      timelineEvents,
      diagnosticsAtStart: manualDiagnosticsStartRef.current,
      diagnosticsAtEnd: snapshotPerformanceDiagnostics(),
      eventRetentionLimit: MAX_MANUAL_REPAINT_EVENTS,
      events,
    };
    setManualReport(report);
    try {
      window.sessionStorage.setItem(MANUAL_REPAINT_REPORT_STORAGE_KEY, JSON.stringify(report));
    } catch (error) {
      console.warn('[Liclick 3D Texture] Could not retain the manual performance report:', error);
    }
    delete document.body.dataset.perfManualLocalRepaintRecording;
    setManualRecording(false);
  }, [manualRecording]);

  useEffect(() => {
    let cancelled = false;
    void prepareGpuComputeBackend().then((capability) => {
      if (!cancelled) setComputeBackend(capability);
    });
    const handleRuntimeStatus = (event: Event) => {
      if (!cancelled) {
        setComputeBackend((event as CustomEvent<GpuComputeBackendCapability>).detail);
      }
    };
    window.addEventListener('liclick-webgpu-status', handleRuntimeStatus);
    return () => {
      cancelled = true;
      window.removeEventListener('liclick-webgpu-status', handleRuntimeStatus);
    };
  }, []);

  useEffect(() => {
    setPerformanceTimelineEnabled(true);
    let animationFrame = 0;
    let previousFrameAt = performance.now();
    const frameTimes: number[] = [];
    const observer =
      typeof PerformanceObserver !== 'undefined' &&
      PerformanceObserver.supportedEntryTypes.includes('longtask')
        ? new PerformanceObserver((list) => {
            list.getEntries().forEach((entry) => {
              if (entry.duration > 100) {
                document.body.dataset.perfLastLongTask = JSON.stringify({
                  unixMs: Date.now() - Math.max(0, performance.now() - entry.startTime),
                  durationMs: entry.duration,
                  phase:
                    document.body.dataset.perfLocalRepaintPhase ??
                    document.body.dataset.perfLayerTogglePhase ??
                    document.body.dataset.perfUvBakePhase ??
                    document.body.dataset.perfContentAwareRepairPhase ??
                    document.body.dataset.perfViewportStressPhase ??
                    document.body.dataset.perfScenarioPhase,
                });
              }
              longTaskSamplesRef.current.push({
                unixMs: Date.now() - Math.max(0, performance.now() - entry.startTime),
                durationMs: entry.duration,
              });
              if (longTaskSamplesRef.current.length > 2_000) {
                longTaskSamplesRef.current.splice(0, 400);
              }
            });
          })
        : undefined;
    if (observer) {
      try {
        observer.observe({ type: 'longtask', buffered: true });
      } catch {
        observer.observe({ entryTypes: ['longtask'] });
      }
    }
    const longAnimationFrameObserver =
      typeof PerformanceObserver !== 'undefined' &&
      PerformanceObserver.supportedEntryTypes.includes('long-animation-frame')
        ? new PerformanceObserver((list) => {
            for (const rawEntry of list.getEntries()) {
              const entry = rawEntry as PerformanceEntry & {
                blockingDuration?: number;
                renderStart?: number;
                styleAndLayoutStart?: number;
                scripts?: Array<{
                  duration?: number;
                  invoker?: string;
                  sourceFunctionName?: string;
                }>;
              };
              if (entry.duration <= 20) continue;
              longAnimationFrameSamplesRef.current.push({
                durationMs: entry.duration,
                blockingDurationMs: entry.blockingDuration ?? 0,
                renderDurationMs:
                  entry.renderStart !== undefined
                    ? entry.startTime + entry.duration - entry.renderStart
                    : 0,
                styleAndLayoutDurationMs:
                  entry.styleAndLayoutStart !== undefined
                    ? entry.startTime + entry.duration - entry.styleAndLayoutStart
                    : 0,
                phase:
                  document.body.dataset.perfLocalRepaintPhase ??
                  document.body.dataset.perfLayerTogglePhase ??
                  document.body.dataset.perfUvBakePhase ??
                  document.body.dataset.perfContentAwareRepairPhase ??
                  document.body.dataset.perfViewportStressPhase ??
                  document.body.dataset.perfScenarioPhase,
                scripts: (entry.scripts ?? []).slice(0, 8).map((script) => ({
                  durationMs: script.duration ?? 0,
                  invoker: script.invoker,
                  sourceFunctionName: script.sourceFunctionName,
                })),
              });
              if (longAnimationFrameSamplesRef.current.length > 120) {
                longAnimationFrameSamplesRef.current.splice(0, 20);
              }
            }
          })
        : undefined;
    longAnimationFrameObserver?.observe({ type: 'long-animation-frame', buffered: true });

    const sampleFrame = (now: number) => {
      const duration = now - previousFrameAt;
      previousFrameAt = now;
      // Do not hide catastrophic stalls. The old 1000ms ceiling made a 3.2s
      // stop-the-world collection disappear from S4 while a stale 450ms frame
      // was reported as the maximum.
      if (duration > 0 && duration < 30_000) {
        if (duration > 100) {
          document.body.dataset.perfLastLongFrame = JSON.stringify({
            unixMs: Date.now(),
            durationMs: duration,
            phase:
              document.body.dataset.perfLocalRepaintPhase ??
              document.body.dataset.perfLayerTogglePhase ??
              document.body.dataset.perfUvBakePhase ??
              document.body.dataset.perfContentAwareRepairPhase ??
              document.body.dataset.perfViewportStressPhase ??
              document.body.dataset.perfScenarioPhase,
          });
        }
        frameTimes.push(duration);
        if (frameTimes.length > 600) frameTimes.splice(0, 120);
        frameSamplesRef.current.push({
          unixMs: Date.now(),
          durationMs: duration,
          phase:
            document.body.dataset.perfLocalRepaintPhase ??
            document.body.dataset.perfLayerTogglePhase ??
            document.body.dataset.perfUvBakePhase ??
            document.body.dataset.perfContentAwareRepairPhase ??
            document.body.dataset.perfViewportStressPhase ??
            document.body.dataset.perfScenarioPhase,
        });
        if (frameSamplesRef.current.length > 7_200) frameSamplesRef.current.splice(0, 1_200);
      }
      animationFrame = window.requestAnimationFrame(sampleFrame);
    };
    animationFrame = window.requestAnimationFrame(sampleFrame);

    const updateTimer = window.setInterval(() => {
      // Keep the rAF/native collectors running, but do not let the large HUD
      // React tree become the workload during a viewport stress window. The
      // final scenario result is published immediately after measurement.
      if (
        isViewportInteractionBusy(500) ||
        document.body.dataset.perfAutoOrbit === '1' ||
        document.body.dataset.perfSimulatedViewportInteraction === '1' ||
        document.body.dataset.perfScenarioMeasuring === '1' ||
        document.body.dataset.perfViewportStressMeasuring === '1' ||
        document.body.dataset.perfLocalRepaintMeasuring === '1' ||
        document.body.dataset.perfUvMergeMeasuring === '1' ||
        document.body.dataset.perfContentAwareRepairMeasuring === '1'
      )
        return;
      const samplerStartedAt = performance.now();
      const averageFrame =
        frameTimes.reduce((sum, value) => sum + value, 0) / Math.max(1, frameTimes.length);
      const frameSummary = summarizeDurationSamples(frameSamplesRef.current, 20);
      const recordedLongTaskDuration = sumDurationSamples(longTaskSamplesRef.current);
      const recordedDuration = Math.max(1, Date.now() - recordingStartedAtRef.current);
      const paintSamples = surfacePaintPerfSamples.slice(-240);
      const gpuSamples = gpuFrameTimeSamples.slice(-120);
      const samplerSummary = summarizeDurationSamples(samplerOverheadSamplesRef.current, 0.3);
      const memory = (
        performance as Performance & {
          memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number };
        }
      ).memory;
      setMetrics({
        fps: averageFrame > 0 ? 1000 / averageFrame : 0,
        frameP95: frameSummary.p95,
        frameMax: frameSummary.maximum,
        droppedFrames: frameSummary.aboveThresholdPercent,
        paintP95: percentile(paintSamples, 0.95),
        paintMax: paintSamples.length > 0 ? Math.max(...paintSamples) : 0,
        paintSamples: paintSamples.length,
        cpuLongTaskPercent: Math.min(100, (recordedLongTaskDuration / recordedDuration) * 100),
        gpuP95: percentile(gpuSamples, 0.95),
        gpuSamples: gpuSamples.length,
        heapUsedMb: memory ? memory.usedJSHeapSize / 1024 / 1024 : undefined,
        heapLimitMb: memory ? memory.jsHeapSizeLimit / 1024 / 1024 : undefined,
        samplerP95: samplerSummary.p95,
        samplerMax: samplerSummary.maximum,
        samplerSamples: samplerSummary.count,
      });
      setFrameHistory(frameTimes.slice(-120));
      setRecentEvents(getPerformanceTimelineEvents().slice(-12).reverse());
      samplerOverheadSamplesRef.current.push({
        unixMs: Date.now(),
        durationMs: performance.now() - samplerStartedAt,
      });
      if (samplerOverheadSamplesRef.current.length > 240) {
        samplerOverheadSamplesRef.current.splice(0, 48);
      }
    }, 500);

    return () => {
      window.cancelAnimationFrame(animationFrame);
      window.clearInterval(updateTimer);
      observer?.disconnect();
      longAnimationFrameObserver?.disconnect();
      setPerformanceTimelineEnabled(false);
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    let activeController: AbortController | undefined;
    const sampleNative = async () => {
      // Host telemetry is diagnostic-only. Do not even issue/parse its JSON
      // while a viewport gesture or benchmark owns the frame budget: checking
      // only after the request completed let the observer itself create random
      // missed-vsync frames inside otherwise uniform layer-toggle scenarios.
      if (
        isViewportInteractionBusy(500) ||
        document.body.dataset.perfAutoOrbit === '1' ||
        document.body.dataset.perfSimulatedViewportInteraction === '1' ||
        document.body.dataset.perfScenarioMeasuring === '1' ||
        document.body.dataset.perfViewportStressMeasuring === '1' ||
        document.body.dataset.perfLocalRepaintMeasuring === '1' ||
        document.body.dataset.perfUvMergeMeasuring === '1' ||
        document.body.dataset.perfContentAwareRepairMeasuring === '1'
      )
        return;
      activeController?.abort();
      activeController = new AbortController();
      try {
        const snapshot = await getNativePerformanceSnapshot(activeController.signal);
        if (disposed) return;
        nativeSamplesRef.current.push(snapshot);
        if (nativeSamplesRef.current.length > 600) nativeSamplesRef.current.splice(0, 100);
        setNativeSnapshot(snapshot);
        setCpuHistory((values) => [...values.slice(-119), snapshot.cpu.overallUtilizationPercent]);
        setGpuHistory((values) => [
          ...values.slice(-119),
          snapshot.gpu.adapters[0]?.utilizationGpuPercent ?? 0,
        ]);
        setNativeError(undefined);
      } catch (error) {
        if (!disposed && !(error instanceof DOMException && error.name === 'AbortError')) {
          setNativeError(error instanceof Error ? error.message : String(error));
        }
      }
    };
    void sampleNative();
    const timer = window.setInterval(() => void sampleNative(), 1_000);
    return () => {
      disposed = true;
      activeController?.abort();
      window.clearInterval(timer);
    };
  }, []);

  const clearReport = useCallback((collectorOnly = false) => {
    delete document.body.dataset.perfLastLongFrame;
    delete document.body.dataset.perfLastLongTask;
    delete document.body.dataset.perfWebGpuCompositeMain;
    frameSamplesRef.current = [];
    longTaskSamplesRef.current = [];
    longAnimationFrameSamplesRef.current = [];
    gpuFramePhaseTimeSamples.length = 0;
    nativeSamplesRef.current = [];
    samplerOverheadSamplesRef.current = [];
    recordingStartedAtRef.current = Date.now();
    clearPerformanceTimelineEvents();
    if (collectorOnly) return;
    setFrameHistory([]);
    setCpuHistory([]);
    setGpuHistory([]);
    setRecentEvents([]);
    setProjectedLayerRampResult(undefined);
    setLayerToggleScenarioResult(undefined);
    setUvMergeBenchmarkResult(undefined);
    setLocalRepaintBenchmarkResult(undefined);
    setRefreshRestoreBenchmarkResult(undefined);
    setContentAwareRepairBenchmarkResult(undefined);
  }, []);

  const runRefreshRestoreBenchmark = useCallback(() => {
    window.sessionStorage.setItem(REFRESH_RESTORE_BENCHMARK_KEY, '1');
    window.location.reload();
  }, []);

  useEffect(() => {
    if (!refreshRestoreBenchmarkRunning) return undefined;
    let cancelled = false;
    let animationFrame = 0;
    const deadline = performance.now() + 15_000;
    const finish = (success: boolean) => {
      if (cancelled) return;
      const readNumber = (key: string) => Number(document.body.dataset[key] ?? '0');
      const modelFullMs = readNumber('textureRestoreModelFullMs');
      const textureStageStartedAt = performance.timeOrigin + modelFullMs;
      const textureStageSamples = frameSamplesRef.current.filter(
        (sample) => sample.unixMs >= textureStageStartedAt,
      );
      const durations = textureStageSamples.map((sample) => sample.durationMs);
      const phaseFrameMax: Record<string, number> = {};
      textureStageSamples.forEach((sample) => {
        const phase = sample.phase ?? 'unattributed';
        phaseFrameMax[phase] = Math.max(phaseFrameMax[phase] ?? 0, sample.durationMs);
      });
      document.body.dataset.perfRefreshRestorePhaseMax = JSON.stringify(phaseFrameMax);
      const longTasks = longTaskSamplesRef.current
        .filter((sample) => sample.unixMs >= textureStageStartedAt)
        .map((sample) => sample.durationMs);
      const textureLongTasks = longTaskSamplesRef.current.filter(
        (sample) => sample.unixMs >= textureStageStartedAt,
      );
      const longestTextureTask = [...textureLongTasks].sort(
        (left, right) => right.durationMs - left.durationMs,
      )[0];
      if (longestTextureTask) {
        document.body.dataset.perfRefreshRestoreLongTaskContext = JSON.stringify({
          task: longestTextureTask,
          nearbyEvents: getPerformanceTimelineEvents()
            .filter(
              (event) =>
                event.unixMs >= longestTextureTask.unixMs - 250 &&
                event.unixMs <=
                  longestTextureTask.unixMs + longestTextureTask.durationMs + 250,
            )
            .map((event) => ({
              unixMs: event.unixMs,
              category: event.category,
              name: event.name,
              phase: event.phase,
              durationMs: event.durationMs,
              detail: event.detail,
            })),
        });
      }
      const result: RefreshRestoreBenchmarkResult = {
        success,
        totalMs: performance.now(),
        hydratedMs: readNumber('textureRestoreHydratedMs'),
        modelFullMs,
        uvReadyMs: readNumber('textureRestoreUvReadyMs'),
        projectedReadyMs: readNumber('textureRestoreProjectedReadyMs'),
        uvPrewarmMs: readNumber('residentUvTogglePrewarmMs'),
        expectedLayers: readNumber('textureRestoreExpectedLayers'),
        expectedUvLayers: readNumber('textureRestoreExpectedUvLayers'),
        expectedProjectedLayers: readNumber('textureRestoreExpectedProjectedLayers'),
        expectedLocalRepaintLayers: readNumber('textureRestoreExpectedLocalRepaintLayers'),
        loadedProjectedLayers: readNumber('textureRestoreLoadedProjectedLayers'),
        loadedLocalRepaintLayers: readNumber('textureRestoreLoadedLocalRepaintLayers'),
        frameP95: percentile(durations, 0.95),
        frameMax: durations.length > 0 ? Math.max(...durations) : 0,
        droppedFrames:
          durations.length > 0
            ? (durations.filter((duration) => duration > 20).length / durations.length) * 100
            : 0,
        longTaskMax: longTasks.length > 0 ? Math.max(...longTasks) : 0,
      };
      window.sessionStorage.removeItem(REFRESH_RESTORE_BENCHMARK_KEY);
      setRefreshRestoreBenchmarkResult(result);
      setRefreshRestoreBenchmarkRunning(false);
      markPerformanceEvent('system', 's8-refresh-restore-complete', result);
    };
    const poll = () => {
      if (cancelled) return;
      const expectedUv = Number(document.body.dataset.textureRestoreExpectedUvLayers ?? '0');
      const expectedProjected = Number(
        document.body.dataset.textureRestoreExpectedProjectedLayers ?? '0',
      );
      const expectedLocal = Number(
        document.body.dataset.textureRestoreExpectedLocalRepaintLayers ?? '0',
      );
      const loadedLocal = Number(
        document.body.dataset.textureRestoreLoadedLocalRepaintLayers ?? '0',
      );
      const ready = Boolean(
        document.body.dataset.textureRestoreHydrated === '1' &&
        document.body.dataset.textureRestoreModelFull === '1' &&
        (expectedUv === 0 || document.body.dataset.textureRestoreUvReady === '1') &&
        (expectedProjected === 0 || document.body.dataset.textureRestoreProjectedReady === '1') &&
        (expectedLocal === 0 || loadedLocal >= expectedLocal),
      );
      if (ready) {
        // Include the first fully textured presentation frame, not merely the
        // state mutation that scheduled it.
        animationFrame = window.requestAnimationFrame(() => finish(true));
        return;
      }
      if (performance.now() >= deadline) {
        finish(false);
        return;
      }
      animationFrame = window.requestAnimationFrame(poll);
    };
    animationFrame = window.requestAnimationFrame(poll);
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(animationFrame);
    };
  }, [refreshRestoreBenchmarkRunning]);

  const buildExportReport = useCallback(() => {
    return {
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      page: { url: window.location.href, title: document.title },
      browser: {
        userAgent: navigator.userAgent,
        logicalProcessorCount: navigator.hardwareConcurrency,
      },
      currentMetrics: metrics,
      analysis: buildPerformanceAnalysis(metrics, nativeSnapshot),
      frames: frameSamplesRef.current,
      longTasks: longTaskSamplesRef.current,
      nativeSamples: nativeSamplesRef.current,
      events: getPerformanceTimelineEvents(),
      viewport: { ...viewportTelemetry },
      manualLocalRepaint: manualReport,
      scenarios: {
        projectedLayerRamp: projectedLayerRampResult,
        layerToggle: layerToggleScenarioResult,
        uvMerge: uvMergeBenchmarkResult,
        localRepaint: localRepaintBenchmarkResult,
        viewportLayerStress: viewportLayerStressResult,
        refreshRestore: refreshRestoreBenchmarkResult,
        contentAwareRepair: contentAwareRepairBenchmarkResult,
      },
    };
  }, [
    contentAwareRepairBenchmarkResult,
    layerToggleScenarioResult,
    localRepaintBenchmarkResult,
    manualReport,
    metrics,
    nativeSnapshot,
    projectedLayerRampResult,
    refreshRestoreBenchmarkResult,
    uvMergeBenchmarkResult,
    viewportLayerStressResult,
  ]);

  const exportReport = useCallback(() => {
    const report = buildExportReport();
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `liclick-performance-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
  }, [buildExportReport]);

  const copyReport = useCallback(async () => {
    await navigator.clipboard.writeText(JSON.stringify(buildExportReport(), null, 2));
    document.body.dataset.perfReportCopiedAt = new Date().toISOString();
  }, [buildExportReport]);

  const runProjectedLayerRamp = useCallback(
    async (options?: { intervalMs?: number }) => {
      if (projectedLayerRampRunningRef.current) {
        throw new Error('0→14 投影图层压测已经在运行。');
      }
      const initialState = useLayerStore.getState();
      const originalLayers = initialState.layers;
      const originalActiveLayerId = initialState.activeProjectedLayerId;
      const selectedObjectId = useSceneStore.getState().selectedObjectId;
      const projectedLayers = originalLayers
        .filter(
          (layer) =>
            layer.type === 'projected' &&
            Boolean(layer.imageUrl && layer.camera) &&
            (!selectedObjectId || !layer.objectId || layer.objectId === selectedObjectId),
        )
        .slice(0, 14);
      if (projectedLayers.length < 14) {
        throw new Error(`当前对象只有 ${projectedLayers.length} 个可用真实投影图层，需要 14 个。`);
      }

      const projectedIds = new Set(projectedLayers.map((layer) => layer.id));
      const buildStack = (count: number) => {
        const enabledIds = new Set(projectedLayers.slice(0, count).map((layer) => layer.id));
        return originalLayers.filter(
          (layer) => !projectedIds.has(layer.id) || enabledIds.has(layer.id),
        );
      };
      // Keep a small visible stagger, but do not make the benchmark itself add
      // three seconds of artificial latency before the real 14-layer publish.
      const intervalMs = Math.max(50, Math.min(2_000, options?.intervalMs ?? 80));
      const waitForFrame = () =>
        new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
      const wait = (durationMs: number) =>
        new Promise<void>((resolve) => window.setTimeout(resolve, durationMs));
      const startedAt = performance.now();
      let restored = false;
      let previewBatchOpen = false;
      let simulatedInteraction = false;

      const summarizeFrames = (samples: PerformanceFrameSample[]) => {
        const durations = samples.map((sample) => sample.durationMs);
        return {
          p95: percentile(durations, 0.95),
          max: durations.length > 0 ? Math.max(...durations) : 0,
          dropped:
            durations.length > 0
              ? (durations.filter((duration) => duration > 20).length / durations.length) * 100
              : 0,
        };
      };

      projectedLayerRampRunningRef.current = true;
      document.body.dataset.perfScenarioMeasuring = '1';
      setProjectedLayerRamp({ running: true, current: 0, total: projectedLayers.length });
      try {
        document.body.dataset.perfScenarioPhase = 's0-zero-stack';
        useLayerStore.getState().setLayers(buildStack(0));
        await waitForFrame();
        await waitForFrame();
        await wait(900);

        document.body.dataset.perfScenarioPhase = 's0-clear-report';
        clearReport(true);
        document.body.dataset.perfSimulatedViewportInteraction = '1';
        simulatedInteraction = true;
        useLayerStore.getState().beginProjectedPreviewBatch();
        previewBatchOpen = true;
        const endRamp = startPerformanceSpan('projection', 'real-4k-ramp-0-to-14', {
          count: projectedLayers.length,
          intervalMs,
          selectedObjectId,
          viewportWidth: viewportTelemetry.width,
          viewportHeight: viewportTelemetry.height,
        });
        markPerformanceEvent('projection', 'real-4k-ramp-zero-ready', {
          preservedLayerCount: buildStack(0).length,
        });

        for (let index = 0; index < projectedLayers.length; index += 1) {
          document.body.dataset.perfScenarioPhase = `s0-layer-${index + 1}`;
          await waitForFrame();
          const mutationStartedAt = performance.now();
          useLayerStore.getState().setLayers(buildStack(index + 1));
          const mutationDurationMs = performance.now() - mutationStartedAt;
          const layer = projectedLayers[index];
          markPerformanceEvent('projection', 'real-4k-projector-published', {
            index: index + 1,
            total: projectedLayers.length,
            layerId: layer.id,
            layerName: layer.name,
            imageUrlKind: layer.imageUrl.startsWith('data:') ? 'data-url' : 'asset-url',
            mutationDurationMs,
          });
          await wait(intervalMs);
        }
        markPerformanceEvent('projection', 'real-4k-ramp-atomic-preview-publish', {
          count: projectedLayers.length,
        });
        document.body.dataset.perfScenarioPhase = 's0-atomic-publish';
        useLayerStore.getState().endProjectedPreviewBatch();
        previewBatchOpen = false;
        await waitForFrame();
        await waitForFrame();
        // Give worker preparation time to reach the GPU upload gate while the
        // deterministic orbit represents a continuously held viewport gesture.
        document.body.dataset.perfScenarioPhase = 's0-protected-orbit';
        await wait(1_000);
        const protectedSummary = summarizeFrames(frameSamplesRef.current);
        markPerformanceEvent('interaction', 'real-4k-ramp-protected-window', {
          frameP95: protectedSummary.p95,
          frameMax: protectedSummary.max,
          droppedFrames: protectedSummary.dropped,
        });

        const publishFrameStart = frameSamplesRef.current.length;
        delete document.body.dataset.perfSimulatedViewportInteraction;
        simulatedInteraction = false;
        document.body.dataset.perfScenarioPhase = 's0-post-release-publish';
        markPerformanceEvent('interaction', 'real-4k-ramp-simulated-pointer-release');
        await wait(2_400);
        const publishSummary = summarizeFrames(frameSamplesRef.current.slice(publishFrameStart));
        const phaseFrameMax: Record<string, number> = {};
        frameSamplesRef.current.forEach((sample) => {
          const phase = sample.phase ?? 'unattributed';
          phaseFrameMax[phase] = Math.max(phaseFrameMax[phase] ?? 0, sample.durationMs);
        });
        document.body.dataset.perfProjectionRampPhaseMax = JSON.stringify(phaseFrameMax);
        setProjectedLayerRampResult({
          protectedFrameP95: protectedSummary.p95,
          protectedFrameMax: protectedSummary.max,
          protectedDroppedFrames: protectedSummary.dropped,
          publishFrameP95: publishSummary.p95,
          publishFrameMax: publishSummary.max,
          publishDroppedFrames: publishSummary.dropped,
        });
        markPerformanceEvent('projection', 'real-4k-ramp-post-release-publish-window', {
          frameP95: publishSummary.p95,
          frameMax: publishSummary.max,
          droppedFrames: publishSummary.dropped,
        });
        endRamp('end', { added: projectedLayers.length });
        return {
          added: projectedLayers.length,
          durationMs: performance.now() - startedAt,
          restored: true,
        };
      } catch (error) {
        markPerformanceEvent(
          'projection',
          'real-4k-ramp-0-to-14',
          { message: error instanceof Error ? error.message : String(error) },
          'error',
        );
        throw error;
      } finally {
        if (simulatedInteraction) {
          delete document.body.dataset.perfSimulatedViewportInteraction;
        }
        if (previewBatchOpen) useLayerStore.getState().endProjectedPreviewBatch();
        document.body.dataset.perfScenarioPhase = 's0-restore-stack';
        // The last test stack normally equals the original stack. Always restore the
        // exact objects and active layer so interrupted/partial runs cannot edit a project.
        useLayerStore.getState().setLayers(originalLayers);
        if (originalActiveLayerId) useLayerStore.getState().setActiveLayer(originalActiveLayerId);
        restored = true;
        projectedLayerRampRunningRef.current = false;
        delete document.body.dataset.perfScenarioMeasuring;
        delete document.body.dataset.perfScenarioPhase;
        setProjectedLayerRamp({
          running: false,
          current: projectedLayers.length,
          total: projectedLayers.length,
        });
        markPerformanceEvent('projection', 'real-4k-ramp-original-stack-restored', {
          layerCount: originalLayers.length,
          restored,
        });
      }
    },
    [clearReport],
  );

  const runLayerToggleScenario = useCallback(
    async (
      scenario: 'projected' | 'content-aware' | 'uv-projected',
      options?: { intervalMs?: number },
    ): Promise<LayerToggleScenarioResult> => {
      if (layerToggleScenarioRunningRef.current || projectedLayerRampRunningRef.current) {
        throw new Error('已有性能压测正在运行。');
      }
      const initialState = useLayerStore.getState();
      const originalLayers = initialState.layers;
      const originalActiveLayerId = initialState.activeProjectedLayerId;
      const selectedObjectId = useSceneStore.getState().selectedObjectId;
      const targetLayers = originalLayers.filter((layer) => {
        if (selectedObjectId && layer.objectId && layer.objectId !== selectedObjectId) return false;
        return scenario === 'projected' || scenario === 'uv-projected'
          ? layer.type === 'projected' && Boolean(layer.imageUrl && layer.camera)
          : layer.role === 'content-aware-underlay' && Boolean(layer.imageUrl);
      });
      const targets =
        scenario === 'projected' || scenario === 'uv-projected'
          ? targetLayers.slice(0, 14)
          : targetLayers.slice(0, 1);
      const uvTarget =
        scenario === 'uv-projected'
          ? originalLayers.find(
              (layer) =>
                (!selectedObjectId || !layer.objectId || layer.objectId === selectedObjectId) &&
                layer.type === 'uv' &&
                layer.role !== 'content-aware-underlay' &&
                Boolean(layer.imageUrl),
            )
          : undefined;
      const requiredCount = scenario === 'content-aware' ? 1 : 14;
      if (targets.length < requiredCount) {
        throw new Error(
          scenario === 'projected' || scenario === 'uv-projected'
            ? `当前对象只有 ${targets.length} 个可用投影图层，需要 14 个。`
            : '当前对象没有可用的内容识别修补图层。',
        );
      }
      if (scenario === 'uv-projected' && !uvTarget) {
        throw new Error('当前对象没有可用的普通 UV 图层。');
      }

      const intervalMs = Math.max(50, Math.min(1_000, options?.intervalMs ?? 100));
      const waitForFrame = () =>
        new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
      const wait = (durationMs: number) =>
        new Promise<void>((resolve) => window.setTimeout(resolve, durationMs));
      const waitForProjectedResidentReady = async (timeoutMs = 4_000) => {
        const deadline = performance.now() + timeoutMs;
        // React may not have entered the array build on the first frame after
        // the visibility update. Give it two frames, then wait for the real GPU
        // pipeline state instead of folding cold preload into the toggle metric.
        await waitForFrame();
        await waitForFrame();
        while (
          document.body.dataset.projectedArrayPipelineStatus === 'building' &&
          performance.now() < deadline
        ) {
          await waitForFrame();
        }
      };
      const summarizeFrames = (samples: PerformanceFrameSample[]) => {
        const durations = samples.map((sample) => sample.durationMs);
        return {
          p95: percentile(durations, 0.95),
          max: durations.length > 0 ? Math.max(...durations) : 0,
          dropped:
            durations.length > 0
              ? (durations.filter((duration) => duration > 20).length / durations.length) * 100
              : 0,
        };
      };
      const ids = targets.map((layer) => layer.id);
      const iterations = scenario === 'projected' ? 1 : 7;
      const operations = scenario === 'uv-projected' ? iterations * 4 : ids.length * iterations * 2;
      const startedAt = performance.now();
      let simulatedInteraction = false;

      layerToggleScenarioRunningRef.current = true;
      document.body.dataset.perfScenarioMeasuring = '1';
      setLayerToggleScenario({ running: true, scenario });
      try {
        document.body.dataset.perfLayerTogglePhase = `${scenario}-warmup`;
        useLayerStore.getState().setLayerVisibility(ids, false);
        if (uvTarget) useLayerStore.getState().setLayerVisibility([uvTarget.id], true);
        await waitForProjectedResidentReady();
        if (scenario === 'uv-projected' && uvTarget) {
          // Validate both resident display states before recording. This keeps
          // S5 scoped to eye-toggle latency while 0→14/S8 continue to own and
          // expose the full-quality cold preload cost.
          useLayerStore.getState().setLayerVisibility([uvTarget.id], false);
          useLayerStore.getState().setLayerVisibility(ids, true);
          await waitForProjectedResidentReady();
          await wait(200);
          useLayerStore.getState().setLayerVisibility(ids, false);
          useLayerStore.getState().setLayerVisibility([uvTarget.id], true);
          await waitForFrame();
          await waitForFrame();
          await wait(200);
        } else {
          await wait(700);
        }
        clearReport(true);
        document.body.dataset.perfSimulatedViewportInteraction = '1';
        simulatedInteraction = true;
        document.body.dataset.perfLayerTogglePhase = `${scenario}-protected-start`;
        const endScenario = startPerformanceSpan('layers', `real-4k-${scenario}-toggle-scenario`, {
          layerCount: ids.length,
          operations,
          intervalMs,
          viewportWidth: viewportTelemetry.width,
          viewportHeight: viewportTelemetry.height,
        });

        for (let iteration = 0; iteration < iterations; iteration += 1) {
          if (scenario === 'uv-projected' && uvTarget) {
            useLayerStore.getState().setLayerVisibility([uvTarget.id], false);
            useLayerStore.getState().setLayerVisibility(ids, true);
            await wait(intervalMs);
            useLayerStore.getState().setLayerVisibility(ids, false);
            useLayerStore.getState().setLayerVisibility([uvTarget.id], true);
            await wait(intervalMs);
          } else {
            for (const [index, id] of ids.entries()) {
              document.body.dataset.perfLayerTogglePhase = `${scenario}-show-${index + 1}`;
              useLayerStore.getState().setLayerVisibility([id], true);
              await wait(intervalMs);
            }
            for (const [index, id] of [...ids].reverse().entries()) {
              document.body.dataset.perfLayerTogglePhase = `${scenario}-hide-${ids.length - index}`;
              useLayerStore.getState().setLayerVisibility([id], false);
              await wait(intervalMs);
            }
          }
        }
        document.body.dataset.perfLayerTogglePhase = `${scenario}-protected-settle`;
        await waitForFrame();
        await waitForFrame();
        await wait(700);
        const protectedSummary = summarizeFrames(frameSamplesRef.current);
        const phaseFrameMax: Record<string, number> = {};
        frameSamplesRef.current.forEach((sample) => {
          const phase = sample.phase ?? 'unattributed';
          phaseFrameMax[phase] = Math.max(phaseFrameMax[phase] ?? 0, sample.durationMs);
        });
        document.body.dataset.perfLayerTogglePhaseMax = JSON.stringify(phaseFrameMax);
        document.body.dataset.perfLayerToggleLongAnimationFrames = JSON.stringify(
          longAnimationFrameSamplesRef.current,
        );
        const gpuPhaseMax: Record<string, number> = {};
        gpuFramePhaseTimeSamples.forEach((sample) => {
          const phase = sample.phase ?? 'unattributed';
          gpuPhaseMax[phase] = Math.max(gpuPhaseMax[phase] ?? 0, sample.durationMs);
        });
        document.body.dataset.perfLayerToggleGpuPhaseMax = JSON.stringify(gpuPhaseMax);
        markPerformanceEvent('interaction', `real-4k-${scenario}-protected-window`, {
          frameP95: protectedSummary.p95,
          frameMax: protectedSummary.max,
          droppedFrames: protectedSummary.dropped,
          operations,
        });

        const publishFrameStart = frameSamplesRef.current.length;
        delete document.body.dataset.perfSimulatedViewportInteraction;
        simulatedInteraction = false;
        document.body.dataset.perfLayerTogglePhase = `${scenario}-post-release`;
        markPerformanceEvent('interaction', `real-4k-${scenario}-simulated-pointer-release`);
        await wait(2_000);
        const publishSummary = summarizeFrames(frameSamplesRef.current.slice(publishFrameStart));
        const result: LayerToggleScenarioResult = {
          scenario,
          operations,
          durationMs: performance.now() - startedAt,
          protectedFrameP95: protectedSummary.p95,
          protectedFrameMax: protectedSummary.max,
          protectedDroppedFrames: protectedSummary.dropped,
          publishFrameP95: publishSummary.p95,
          publishFrameMax: publishSummary.max,
          publishDroppedFrames: publishSummary.dropped,
        };
        setLayerToggleScenarioResult(result);
        endScenario('end', result);
        return result;
      } catch (error) {
        markPerformanceEvent(
          'layers',
          `real-4k-${scenario}-toggle-scenario`,
          { message: error instanceof Error ? error.message : String(error) },
          'error',
        );
        throw error;
      } finally {
        if (simulatedInteraction) delete document.body.dataset.perfSimulatedViewportInteraction;
        delete document.body.dataset.perfLayerTogglePhase;
        useLayerStore.getState().setLayers(originalLayers);
        if (originalActiveLayerId) useLayerStore.getState().setActiveLayer(originalActiveLayerId);
        layerToggleScenarioRunningRef.current = false;
        delete document.body.dataset.perfScenarioMeasuring;
        setLayerToggleScenario({ running: false });
        markPerformanceEvent('layers', `real-4k-${scenario}-original-stack-restored`, {
          layerCount: originalLayers.length,
        });
      }
    },
    [clearReport],
  );

  const runUvMergeBenchmark = useCallback(async (): Promise<UvMergeBenchmarkResult> => {
    if (
      layerToggleScenarioRunningRef.current ||
      projectedLayerRampRunningRef.current ||
      uvMergeBenchmarkRunning
    ) {
      throw new Error('已有性能压测正在运行。');
    }
    const target = window as typeof window & {
      LiclickPerfUvMerge?: { run: () => Promise<unknown> };
    };
    if (!target.LiclickPerfUvMerge) throw new Error('S4 合成基准尚未就绪。');
    const summarizeFrames = (samples: PerformanceFrameSample[]) => {
      const durations = samples.map((sample) => sample.durationMs);
      return {
        p95: percentile(durations, 0.95),
        max: durations.length > 0 ? Math.max(...durations) : 0,
        dropped:
          durations.length > 0
            ? (durations.filter((duration) => duration > 20).length / durations.length) * 100
            : 0,
      };
    };
    setUvMergeBenchmarkRunning(true);
    clearReport(true);
    document.body.dataset.perfUvMergeMeasuring = '1';
    document.body.dataset.perfSimulatedViewportInteraction = '1';
    document.body.dataset.perfAutoOrbit = '1';
    const finishScenario = startPerformanceSpan('uv-merge', 'real-4k-merge-protected-scenario');
    try {
      // Hold a real continuous-orbit window first. Production baking now
      // pauses at exact state boundaries while interaction is busy, then
      // resumes at full quality/speed after release. Measuring the whole
      // background completion interval as "interaction" made one compositor
      // miss look like input latency even though the user had already stopped.
      document.body.dataset.perfUvBakePhase = 's4-interaction-hold';
      let mergeSettled = false;
      const mergePromise = target.LiclickPerfUvMerge.run().finally(() => {
        mergeSettled = true;
      });
      await new Promise<void>((resolve) => window.setTimeout(resolve, 3_000));
      const protectedFrames = [...frameSamplesRef.current];
      delete document.body.dataset.perfSimulatedViewportInteraction;
      delete document.body.dataset.perfAutoOrbit;
      markViewportInteractionEnd();
      document.body.dataset.perfUvBakePhase = 's4-background-release';
      // Give the full-resolution job time to enter its expensive GPU/readback/
      // upload stages, then interrupt it with a second real orbit window. This
      // catches resume-time contention that a single start-of-job hold misses.
      await Promise.race([
        mergePromise.catch(() => undefined),
        new Promise<void>((resolve) => window.setTimeout(resolve, 8_000)),
      ]);
      if (!mergeSettled) {
        document.body.dataset.perfUvBakePhase = 's4-midflight-interaction-hold';
        document.body.dataset.perfSimulatedViewportInteraction = '1';
        document.body.dataset.perfAutoOrbit = '1';
        const secondWindowStartsAt = frameSamplesRef.current.length;
        const secondWindowEndsAt = performance.now() + 3_000;
        while (performance.now() < secondWindowEndsAt) {
          await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
        }
        protectedFrames.push(...frameSamplesRef.current.slice(secondWindowStartsAt));
        delete document.body.dataset.perfSimulatedViewportInteraction;
        delete document.body.dataset.perfAutoOrbit;
        markViewportInteractionEnd();
        document.body.dataset.perfUvBakePhase = 's4-background-resume';
      }
      const mergeResult = (await mergePromise) as Omit<
        UvMergeBenchmarkResult,
        'protectedFrameP95' | 'protectedFrameMax' | 'protectedDroppedFrames'
      >;
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
      const protectedSummary = summarizeFrames(protectedFrames);
      const fullSummary = summarizeFrames(frameSamplesRef.current);
      const phaseFrameMax: Record<string, number> = {};
      frameSamplesRef.current.forEach((sample) => {
        const phase = sample.phase ?? 'unattributed';
        phaseFrameMax[phase] = Math.max(phaseFrameMax[phase] ?? 0, sample.durationMs);
      });
      const gpuPhaseMax: Record<string, number> = {};
      gpuFramePhaseTimeSamples.forEach((sample) => {
        const phase = sample.phase ?? 'unattributed';
        gpuPhaseMax[phase] = Math.max(gpuPhaseMax[phase] ?? 0, sample.durationMs);
      });
      document.body.dataset.perfUvMergeGpuPhaseMax = JSON.stringify(gpuPhaseMax);
      document.body.dataset.perfUvMergeLongAnimationFrames = JSON.stringify(
        longAnimationFrameSamplesRef.current,
      );
      const result: UvMergeBenchmarkResult = {
        ...mergeResult,
        protectedFrameP95: protectedSummary.p95,
        protectedFrameMax: protectedSummary.max,
        protectedDroppedFrames: protectedSummary.dropped,
        fullFrameP95: fullSummary.p95,
        fullFrameMax: fullSummary.max,
        fullDroppedFrames: fullSummary.dropped,
        phaseFrameMax,
      };
      setUvMergeBenchmarkResult(result);
      finishScenario('end', result);
      return result;
    } catch (error) {
      finishScenario('error', {
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      delete document.body.dataset.perfUvMergeMeasuring;
      delete document.body.dataset.perfSimulatedViewportInteraction;
      delete document.body.dataset.perfAutoOrbit;
      setUvMergeBenchmarkRunning(false);
    }
  }, [clearReport, uvMergeBenchmarkRunning]);

  const runLocalRepaintBenchmark = useCallback(async (): Promise<LocalRepaintBenchmarkResult> => {
    if (
      projectedLayerRampRunningRef.current ||
      layerToggleScenarioRunningRef.current ||
      uvMergeBenchmarkRunning ||
      localRepaintBenchmarkRunning
    ) {
      throw new Error('已有性能压测正在运行。');
    }
    const target = window as typeof window & {
      LiclickPerfLocalRepaint?: LocalRepaintPerformanceApi;
    };
    if (!target.LiclickPerfLocalRepaint) {
      throw new Error('S6 局部重绘模拟器尚未就绪。');
    }
    const summarizeFrames = (samples: PerformanceFrameSample[]) => {
      const durations = samples.map((sample) => sample.durationMs);
      return {
        p95: percentile(durations, 0.95),
        max: durations.length > 0 ? Math.max(...durations) : 0,
        dropped:
          durations.length > 0
            ? (durations.filter((duration) => duration > 20).length / durations.length) * 100
            : 0,
      };
    };
    const memory = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
    const heapStartedBytes = memory?.usedJSHeapSize ?? 0;
    setLocalRepaintBenchmarkRunning(true);
    document.body.dataset.perfLocalRepaintMeasuring = '1';
    clearReport(true);
    document.body.dataset.perfAutoOrbit = '1';
    const finishScenario = startPerformanceSpan('local-repaint', 's6-full-local-repaint-scenario');
    try {
      const coreResult = await target.LiclickPerfLocalRepaint.run();
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
      const protectedFrames = frameSamplesRef.current.filter((sample) =>
        sample.phase?.startsWith('s6-interaction'),
      );
      const publishFrames = frameSamplesRef.current.filter((sample) =>
        sample.phase?.startsWith('s6-publish'),
      );
      const protectedSummary = summarizeFrames(protectedFrames);
      const publishSummary = summarizeFrames(publishFrames);
      const phaseFrameMax: Record<string, number> = {};
      frameSamplesRef.current.forEach((sample) => {
        const phase = sample.phase ?? 'unattributed';
        phaseFrameMax[phase] = Math.max(phaseFrameMax[phase] ?? 0, sample.durationMs);
      });
      const heapFinishedBytes = memory?.usedJSHeapSize ?? heapStartedBytes;
      const result: LocalRepaintBenchmarkResult = {
        ...coreResult,
        protectedFrameP95: protectedSummary.p95,
        protectedFrameMax: protectedSummary.max,
        protectedDroppedFrames: protectedSummary.dropped,
        publishFrameP95: publishSummary.p95,
        publishFrameMax: publishSummary.max,
        publishDroppedFrames: publishSummary.dropped,
        heapDeltaMb: (heapFinishedBytes - heapStartedBytes) / 1024 / 1024,
        phaseFrameMax,
      };
      document.body.dataset.perfLocalRepaintResult = JSON.stringify(result);
      setLocalRepaintBenchmarkResult(result);
      finishScenario('end', result);
      return result;
    } catch (error) {
      document.body.dataset.perfLocalRepaintResult = JSON.stringify({
        error: error instanceof Error ? error.message : String(error),
      });
      finishScenario('error', {
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      delete document.body.dataset.perfLocalRepaintMeasuring;
      delete document.body.dataset.perfAutoOrbit;
      delete document.body.dataset.perfSimulatedViewportInteraction;
      delete document.body.dataset.perfLocalRepaintPhase;
      setLocalRepaintBenchmarkRunning(false);
    }
  }, [clearReport, localRepaintBenchmarkRunning, uvMergeBenchmarkRunning]);

  const runContentAwareRepairBenchmark =
    useCallback(async (): Promise<ContentAwareRepairBenchmarkResult> => {
      if (
        projectedLayerRampRunningRef.current ||
        layerToggleScenarioRunningRef.current ||
        uvMergeBenchmarkRunning ||
        localRepaintBenchmarkRunning ||
        viewportLayerStressRunning ||
        contentAwareRepairBenchmarkRunning
      ) {
        throw new Error('已有性能压测正在运行。');
      }
      const target = window as typeof window & {
        LiclickPerfContentAwareRepair?: {
          run: (objectId?: string) => Promise<{
            terminal: Record<string, unknown>;
            history: Array<Record<string, unknown>>;
          }>;
        };
      };
      if (!target.LiclickPerfContentAwareRepair) {
        throw new Error('S9 内容识别修复基准尚未就绪。');
      }
      const layerState = useLayerStore.getState();
      const originalLayers = layerState.layers;
      const originalActiveLayerId = layerState.activeProjectedLayerId;
      const selectedObjectId =
        useSceneStore.getState().selectedObjectId ??
        useSceneStore.getState().importedModel?.objectId;
      const projectedLayers = originalLayers
        .filter(
          (layer) =>
            layer.type === 'projected' &&
            !isRendererOwnedLocalRepaintLayer(layer) &&
            Boolean(layer.imageUrl && layer.camera) &&
            (!selectedObjectId || !layer.objectId || layer.objectId === selectedObjectId),
        )
        .slice(0, 14);
      if (projectedLayers.length < 14) {
        throw new Error(`当前对象只有 ${projectedLayers.length} 个可用投影图层，需要 14 个。`);
      }
      const projectedIds = new Set(projectedLayers.map((layer) => layer.id));
      const benchmarkLayers = originalLayers.map((layer) => {
        if (projectedIds.has(layer.id)) return layer.visible ? layer : { ...layer, visible: true };
        if (
          layer.role === 'content-aware-underlay' &&
          (!selectedObjectId || !layer.objectId || layer.objectId === selectedObjectId)
        ) {
          return layer.visible ? { ...layer, visible: false } : layer;
        }
        return layer;
      });
      const waitForFrame = () =>
        new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
      const summarizeFrames = (samples: PerformanceFrameSample[]) => {
        const durations = samples.map((sample) => sample.durationMs);
        return {
          p95: percentile(durations, 0.95),
          max: durations.length > 0 ? Math.max(...durations) : 0,
          dropped:
            durations.length > 0
              ? (durations.filter((duration) => duration > 20).length / durations.length) * 100
              : 0,
        };
      };
      let result: ContentAwareRepairBenchmarkResult | undefined;
      const finishScenario = startPerformanceSpan('projection', 's9-real-projection-repair', {
        projectedLayerCount: projectedLayers.length,
      });
      setContentAwareRepairBenchmarkRunning(true);
      clearReport(true);
      document.body.dataset.perfSuppressProjectLayerSync = '1';
      document.body.dataset.perfSimulatedViewportInteraction = '1';
      document.body.dataset.perfAutoOrbit = '1';
      document.body.dataset.perfContentAwareRepairMeasuring = '1';
      try {
        useLayerStore.getState().setLayers(benchmarkLayers);
        await waitForFrame();
        await waitForFrame();
        // Hiding an existing content-repair underlay can retire a 4K preview
        // texture/material asynchronously. Drain that benchmark-only setup
        // before attributing frames to the new repair invocation.
        await new Promise<void>((resolve) => window.setTimeout(resolve, 250));
        await waitForFrame();
        await waitForFrame();
        // Do not charge the benchmark for the HUD reset or for changing the
        // temporary eye state. The measured window starts at the real repair.
        frameSamplesRef.current = [];
        const projectedBuildStart = Number(
          document.body.dataset.projectedMaterialBuildRevision ?? '0',
        );
        // Start the real repair while the model is rotating. Production work is
        // expected to stop at its next safe boundary, leaving the viewport an
        // uncontested 3-second interaction window. Then release the synthetic
        // input and let the exact full-resolution job resume to completion.
        let repairSettled = false;
        const pendingRepair = target.LiclickPerfContentAwareRepair
          .run(selectedObjectId)
          .then(
            (value) => ({ ok: true as const, value }),
            (error: unknown) => ({ ok: false as const, error }),
          )
          .finally(() => {
            repairSettled = true;
          });
        const protectedUntil = performance.now() + 3_000;
        while (performance.now() < protectedUntil) await waitForFrame();
        const protectedFrames = [...frameSamplesRef.current];
        delete document.body.dataset.perfSimulatedViewportInteraction;
        delete document.body.dataset.perfAutoOrbit;
        markViewportInteractionEnd();
        const waitForRepairPhase = async (
          matches: () => boolean,
          maximumWaitMs: number,
        ) => {
          const deadline = performance.now() + maximumWaitMs;
          while (!repairSettled && performance.now() < deadline && !matches()) {
            await waitForFrame();
          }
          return !repairSettled && matches();
        };
        const runMidflightInteractionWindow = async (phase: string) => {
          document.body.dataset.perfContentAwareRepairPhase = phase;
          document.body.dataset.perfSimulatedViewportInteraction = '1';
          document.body.dataset.perfAutoOrbit = '1';
          const windowStartsAt = frameSamplesRef.current.length;
          const windowEndsAt = performance.now() + 2_000;
          while (performance.now() < windowEndsAt) await waitForFrame();
          protectedFrames.push(...frameSamplesRef.current.slice(windowStartsAt));
          delete document.body.dataset.perfSimulatedViewportInteraction;
          delete document.body.dataset.perfAutoOrbit;
          markViewportInteractionEnd();
        };
        if (
          await waitForRepairPhase(
            () => (document.body.dataset.perfUvBakePhase ?? '').startsWith('runtime-depth'),
            10_000,
          )
        ) {
          await runMidflightInteractionWindow('s9-runtime-depth-interaction-hold');
        }
        if (
          await waitForRepairPhase(
            () =>
              (document.body.dataset.perfContentAwareRepairPhase ?? '').startsWith(
                's9-topology-',
              ),
            60_000,
          )
        ) {
          await runMidflightInteractionWindow('s9-topology-interaction-hold');
        }
        const protectedFrameSummary = summarizeFrames(protectedFrames);
        const repairOutcome = await pendingRepair;
        if (!repairOutcome.ok) throw repairOutcome.error;
        const apiResult = repairOutcome.value;
        const terminal = apiResult.terminal;
        const status = terminal.status;
        if (status !== 'complete' && status !== 'no-gaps') {
          throw new Error('内容识别修复没有进入完整终态。');
        }
        let underlayState: Record<string, unknown> = {};
        const publishVisibleStartedAt = performance.now();
        const publishedLayerId =
          typeof terminal.layerId === 'string' ? terminal.layerId : undefined;
        document.body.dataset.perfContentAwareRepairPhase = 's9-publish-visible-wait';
        const publishVisibleDeadline = performance.now() + 5_000;
        while (performance.now() < publishVisibleDeadline) {
          await waitForFrame();
          try {
            underlayState = JSON.parse(
              document.body.dataset.contentAwareUnderlayState ?? '{}',
            ) as Record<string, unknown>;
          } catch {
            underlayState = {};
          }
          const stateLayerIds = Array.isArray(underlayState.layerIds) ? underlayState.layerIds : [];
          if (
            status === 'no-gaps' ||
            (publishedLayerId &&
              stateLayerIds.includes(publishedLayerId) &&
              underlayState.safe === true &&
              underlayState.textureReady === true &&
              underlayState.eyeVisible === true &&
              Number(underlayState.effectiveOpacity ?? 0) > 0)
          ) {
            break;
          }
        }
        const publishToVisibleMs = performance.now() - publishVisibleStartedAt;
        const frameSummary = summarizeFrames(frameSamplesRef.current);
        const phaseFrameMax: Record<string, number> = {};
        frameSamplesRef.current.forEach((sample) => {
          const phase = sample.phase ?? 'unattributed';
          phaseFrameMax[phase] = Math.max(phaseFrameMax[phase] ?? 0, sample.durationMs);
        });
        const phaseDurationsMs: Record<string, number> = {};
        let previousDuration = 0;
        apiResult.history.forEach((entry) => {
          const phase = typeof entry.phase === 'string' ? entry.phase : 'unknown';
          const duration = Number(entry.durationMs ?? previousDuration);
          phaseDurationsMs[phase] = Math.max(0, duration - previousDuration);
          previousDuration = duration;
        });
        const bakeState = apiResult.history.find(
          (entry) => entry.phase === 'projection-bake-ready',
        );
        const bakePerformanceBreakdown =
          bakeState?.bakePerformanceBreakdown &&
          typeof bakeState.bakePerformanceBreakdown === 'object'
            ? (bakeState.bakePerformanceBreakdown as Record<string, number>)
            : {};
        const projectedBuildEnd = Number(
          document.body.dataset.projectedMaterialBuildRevision ?? '0',
        );
        result = {
          status,
          resolution: Number(bakeState?.resolution ?? 0),
          projectedLayerCount: Number(bakeState?.sourceLayerCount ?? projectedLayers.length),
          repairedPixels: Number(terminal.repairedPixels ?? 0),
          outputChecksum: Number(terminal.outputChecksum ?? 0),
          totalDurationMs: Number(terminal.durationMs ?? 0),
          publishToVisibleMs,
          phaseDurationsMs,
          bakePerformanceBreakdown,
          frameP95: frameSummary.p95,
          frameMax: frameSummary.max,
          droppedFrames: frameSummary.dropped,
          protectedFrameP95: protectedFrameSummary.p95,
          protectedFrameMax: protectedFrameSummary.max,
          protectedDroppedFrames: protectedFrameSummary.dropped,
          phaseFrameMax,
          projectedMaterialRebuilds: Math.max(0, projectedBuildEnd - projectedBuildStart),
          underlaySafe: underlayState.safe === true,
          textureReady: underlayState.textureReady === true,
          eyeVisible: underlayState.eyeVisible === true,
          effectiveOpacity: Number(underlayState.effectiveOpacity ?? 0),
          originalStateRestored: false,
        };
        finishScenario(
          result.underlaySafe &&
            (status === 'no-gaps' || (result.textureReady && result.eyeVisible))
            ? 'end'
            : 'error',
          result,
        );
      } catch (error) {
        finishScenario('error', {
          message: error instanceof Error ? error.message : String(error),
        });
        throw error;
      } finally {
        useLayerStore.getState().setLayers(originalLayers);
        if (originalActiveLayerId) {
          useLayerStore.getState().setActiveLayer(originalActiveLayerId);
        }
        delete document.body.dataset.perfSuppressProjectLayerSync;
        delete document.body.dataset.perfSimulatedViewportInteraction;
        delete document.body.dataset.perfAutoOrbit;
        delete document.body.dataset.perfContentAwareRepairMeasuring;
        delete document.body.dataset.perfContentAwareRepairPhase;
        setContentAwareRepairBenchmarkRunning(false);
      }
      if (!result) throw new Error('S9 内容识别修复基准未生成结果。');
      result.originalStateRestored =
        useLayerStore.getState().layers === originalLayers ||
        useLayerStore
          .getState()
          .layers.every(
            (layer, index) =>
              layer.id === originalLayers[index]?.id &&
              layer.visible === originalLayers[index]?.visible,
          );
      document.body.dataset.perfContentAwareRepairResult = JSON.stringify(result);
      setContentAwareRepairBenchmarkResult(result);
      return result;
    }, [
      clearReport,
      contentAwareRepairBenchmarkRunning,
      localRepaintBenchmarkRunning,
      uvMergeBenchmarkRunning,
      viewportLayerStressRunning,
    ]);

  const runViewportLayerStressScenario = useCallback(async () => {
    if (
      projectedLayerRampRunningRef.current ||
      layerToggleScenarioRunningRef.current ||
      uvMergeBenchmarkRunning ||
      localRepaintBenchmarkRunning ||
      viewportLayerStressRunning
    ) {
      throw new Error('已有性能压测正在运行。');
    }
    const target = window as typeof window & {
      LiclickPerfViewportStress?: { run: () => Promise<ViewportLayerStressResult> };
    };
    if (!target.LiclickPerfViewportStress) throw new Error('S7 暴力切换模拟器尚未就绪。');
    const summarizeFrames = (samples: PerformanceFrameSample[]) => {
      const durations = samples.map((sample) => sample.durationMs);
      return {
        p95: percentile(durations, 0.95),
        max: durations.length > 0 ? Math.max(...durations) : 0,
        dropped:
          durations.length > 0
            ? (durations.filter((duration) => duration > 20).length / durations.length) * 100
            : 0,
      };
    };
    setViewportLayerStressRunning(true);
    document.body.dataset.perfViewportStressMeasuring = '1';
    clearReport(true);
    try {
      // Let the diagnostics panel finish its own reset render before measuring.
      // Otherwise the first React/HUD commit is falsely attributed to a viewport
      // mode switch and can dominate the scenario's maximum-frame metric.
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
      frameSamplesRef.current = [];
      // Keep an isolated sampler for S7. Dev/HMR recovery can restart the
      // diagnostics component's long-lived sampler without affecting the
      // renderer; relying only on that shared ref previously produced a false
      // 0ms result even though the scenario ran to completion.
      const scenarioFrameSamples: PerformanceFrameSample[] = [];
      let scenarioPreviousFrameAt = performance.now();
      let scenarioAnimationFrame = 0;
      const sampleScenarioFrame = (now: number) => {
        const durationMs = now - scenarioPreviousFrameAt;
        scenarioPreviousFrameAt = now;
        if (durationMs > 0 && durationMs < 1_000) {
          scenarioFrameSamples.push({
            unixMs: Date.now(),
            durationMs,
            phase: document.body.dataset.perfViewportStressPhase,
          });
        }
        scenarioAnimationFrame = window.requestAnimationFrame(sampleScenarioFrame);
      };
      scenarioAnimationFrame = window.requestAnimationFrame(sampleScenarioFrame);
      let coreResult: ViewportLayerStressResult;
      try {
        coreResult = await target.LiclickPerfViewportStress.run();
      } finally {
        window.cancelAnimationFrame(scenarioAnimationFrame);
      }
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
      // Keep harness-settle samples in the phase map for diagnostics, but do
      // not report a deferred browser/GPU preflight task as a real mode or
      // layer-toggle frame. Every user-facing operation has its own S7 phase.
      const operationFrameSamples = scenarioFrameSamples.filter(
        (sample) => sample.phase !== 's7-harness-settle',
      );
      const summary = summarizeFrames(operationFrameSamples);
      const phaseFrameMax: Record<string, number> = {};
      scenarioFrameSamples.forEach((sample) => {
        const phase = sample.phase ?? 'unattributed';
        phaseFrameMax[phase] = Math.max(phaseFrameMax[phase] ?? 0, sample.durationMs);
      });
      document.body.dataset.perfViewportStressPhaseMax = JSON.stringify(phaseFrameMax);
      const result = {
        ...coreResult,
        frameP95: summary.p95,
        frameMax: summary.max,
        droppedFrames: summary.dropped,
        phaseFrameMax,
      };
      setViewportLayerStressResult(result);
      return result;
    } finally {
      delete document.body.dataset.perfViewportStressMeasuring;
      setViewportLayerStressRunning(false);
    }
  }, [
    clearReport,
    localRepaintBenchmarkRunning,
    uvMergeBenchmarkRunning,
    viewportLayerStressRunning,
  ]);

  useEffect(() => {
    const target = window as typeof window & { LiclickPerfLab?: PerformanceLabWindowApi };
    target.LiclickPerfLab = {
      clear: clearReport,
      exportReport,
      copyReport,
      runProjectedLayerRamp,
      runLayerToggleScenario,
      runUvMergeBenchmark,
      runLocalRepaintBenchmark,
      runViewportLayerStressScenario,
      runContentAwareRepairBenchmark,
      runRefreshRestoreBenchmark,
      snapshot: () => ({
        metrics,
        native: nativeSnapshot,
        events: getPerformanceTimelineEvents(),
        manualLocalRepaint: manualReport,
      }),
    };
    return () => {
      delete target.LiclickPerfLab;
    };
  }, [
    clearReport,
    copyReport,
    exportReport,
    metrics,
    manualReport,
    nativeSnapshot,
    runLayerToggleScenario,
    runProjectedLayerRamp,
    runRefreshRestoreBenchmark,
    runContentAwareRepairBenchmark,
    runLocalRepaintBenchmark,
    runViewportLayerStressScenario,
    runUvMergeBenchmark,
  ]);

  const gpu = nativeSnapshot?.gpu.adapters[0];
  const maximumCore = Math.max(
    0,
    ...(nativeSnapshot?.cpu.cores.map((core) => core.utilizationPercent) ?? []),
  );
  const analysis = buildPerformanceAnalysis(metrics, nativeSnapshot);

  if (collapsed) {
    return (
      <div className="absolute right-4 top-4 z-[28] flex items-center gap-2 rounded-md border border-liclick-pink/55 bg-black/82 p-1.5 text-xs font-semibold text-white shadow-xl backdrop-blur-md">
        <button
          type="button"
          onClick={() => setCollapsed(false)}
          className="rounded px-2 py-1 transition hover:bg-white/10"
        >
          性能 · {metrics.fps.toFixed(0)} FPS · P95 {metrics.frameP95.toFixed(1)}ms
        </button>
        <button
          type="button"
          onClick={toggleManualRecording}
          className={`rounded px-2 py-1 transition ${manualRecording ? 'bg-red-500 text-white' : 'bg-liclick-pink/80 text-white hover:bg-liclick-pink'}`}
        >
          {manualRecording ? '■ 结束并分析' : '● 开始人工录制'}
        </button>
        {manualReport && (
          <span className={manualReport.droppedFrames === 0 ? 'text-emerald-300' : 'text-rose-300'}>
            {manualReport.averageFps.toFixed(1)} FPS / 掉帧 {manualReport.droppedFrames}
          </span>
        )}
      </div>
    );
  }

  return (
    <section className="absolute bottom-16 left-1/2 z-[28] max-h-[72vh] w-[min(96vw,1180px)] -translate-x-1/2 overflow-auto rounded-lg border border-white/16 bg-[#0b0b10]/94 p-2.5 text-white shadow-[0_18px_55px_rgba(0,0,0,0.48)] backdrop-blur-xl">
      <div className="mb-2 flex items-center justify-between gap-3 px-0.5">
        <div className="flex min-w-0 items-center gap-2">
          <span
            className={`h-2 w-2 shrink-0 rounded-full ${viewportTelemetry.contextLost ? 'bg-rose-400' : 'bg-emerald-400'}`}
          />
          <span className="shrink-0 text-xs font-semibold">Li3D 性能实验室</span>
          <span className="truncate text-[10px] text-white/38" title={viewportTelemetry.gpuName}>
            {viewportTelemetry.gpuName}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={toggleManualRecording}
            className={`rounded px-2 py-1 text-[11px] transition ${manualRecording ? 'bg-red-500 text-white' : 'bg-liclick-pink/25 text-pink-100 hover:bg-liclick-pink/40'}`}
          >
            {manualRecording ? '■ 结束并分析' : '● 开始人工录制'}
          </button>
          <button
            type="button"
            disabled={projectedLayerRamp.running || contentAwareRepairBenchmarkRunning}
            onClick={() => void runProjectedLayerRamp()}
            className="rounded bg-cyan-400/20 px-2 py-1 text-[11px] text-cyan-200 transition hover:bg-cyan-400/30 disabled:cursor-wait disabled:opacity-55"
          >
            {projectedLayerRamp.running
              ? `真实上图 ${projectedLayerRamp.current}/${projectedLayerRamp.total}`
              : '0→14 真实上图'}
          </button>
          <button
            type="button"
            disabled={
              projectedLayerRamp.running ||
              layerToggleScenario.running ||
              contentAwareRepairBenchmarkRunning
            }
            onClick={() => void runLayerToggleScenario('uv-projected')}
            className="rounded bg-amber-400/20 px-2 py-1 text-[11px] text-amber-200 transition hover:bg-amber-400/30 disabled:cursor-wait disabled:opacity-55"
          >
            {layerToggleScenario.running && layerToggleScenario.scenario === 'uv-projected'
              ? 'S5 切换中…'
              : 'S5 · UV/投影切换'}
          </button>
          <button
            type="button"
            disabled={
              projectedLayerRamp.running ||
              layerToggleScenario.running ||
              contentAwareRepairBenchmarkRunning
            }
            onClick={() => void runLayerToggleScenario('projected')}
            className="rounded bg-sky-400/20 px-2 py-1 text-[11px] text-sky-200 transition hover:bg-sky-400/30 disabled:cursor-wait disabled:opacity-55"
          >
            {layerToggleScenario.running && layerToggleScenario.scenario === 'projected'
              ? 'S2 开关中…'
              : 'S2 · 14 层开关'}
          </button>
          <button
            type="button"
            disabled={
              projectedLayerRamp.running ||
              layerToggleScenario.running ||
              contentAwareRepairBenchmarkRunning
            }
            onClick={() => void runLayerToggleScenario('content-aware')}
            className="rounded bg-violet-400/20 px-2 py-1 text-[11px] text-violet-200 transition hover:bg-violet-400/30 disabled:cursor-wait disabled:opacity-55"
          >
            {layerToggleScenario.running && layerToggleScenario.scenario === 'content-aware'
              ? 'S3 开关中…'
              : 'S3 · 修补开关'}
          </button>
          <button
            type="button"
            disabled={
              projectedLayerRamp.running ||
              layerToggleScenario.running ||
              uvMergeBenchmarkRunning ||
              localRepaintBenchmarkRunning ||
              contentAwareRepairBenchmarkRunning
            }
            onClick={() => void runUvMergeBenchmark()}
            className="rounded bg-emerald-400/20 px-2 py-1 text-[11px] text-emerald-200 transition hover:bg-emerald-400/30 disabled:cursor-wait disabled:opacity-55"
          >
            {uvMergeBenchmarkRunning ? 'S4 合成中…' : 'S4 · 4K 合成'}
          </button>
          <button
            type="button"
            disabled={
              projectedLayerRamp.running ||
              layerToggleScenario.running ||
              uvMergeBenchmarkRunning ||
              localRepaintBenchmarkRunning ||
              contentAwareRepairBenchmarkRunning
            }
            onClick={() => void runLocalRepaintBenchmark()}
            className="rounded bg-fuchsia-400/20 px-2 py-1 text-[11px] text-fuchsia-200 transition hover:bg-fuchsia-400/30 disabled:cursor-wait disabled:opacity-55"
          >
            {localRepaintBenchmarkRunning ? 'S6 重绘中…' : 'S6 · 完整局部重绘'}
          </button>
          <button
            type="button"
            disabled={
              projectedLayerRamp.running ||
              layerToggleScenario.running ||
              uvMergeBenchmarkRunning ||
              localRepaintBenchmarkRunning ||
              viewportLayerStressRunning ||
              contentAwareRepairBenchmarkRunning
            }
            onClick={() => void runViewportLayerStressScenario()}
            className="rounded bg-orange-400/20 px-2 py-1 text-[11px] text-orange-200 transition hover:bg-orange-400/30 disabled:cursor-wait disabled:opacity-55"
          >
            {viewportLayerStressRunning ? 'S7 暴力切换中…' : 'S7 · 视口/图层暴力切换'}
          </button>
          <button
            type="button"
            disabled={
              refreshRestoreBenchmarkRunning ||
              projectedLayerRamp.running ||
              layerToggleScenario.running ||
              uvMergeBenchmarkRunning ||
              localRepaintBenchmarkRunning ||
              viewportLayerStressRunning ||
              contentAwareRepairBenchmarkRunning
            }
            onClick={runRefreshRestoreBenchmark}
            className="rounded bg-teal-400/20 px-2 py-1 text-[11px] text-teal-200 transition hover:bg-teal-400/30 disabled:cursor-wait disabled:opacity-55"
          >
            {refreshRestoreBenchmarkRunning ? 'S8 刷新恢复中…' : 'S8 · 刷新恢复'}
          </button>
          <button
            type="button"
            disabled={
              refreshRestoreBenchmarkRunning ||
              projectedLayerRamp.running ||
              layerToggleScenario.running ||
              uvMergeBenchmarkRunning ||
              localRepaintBenchmarkRunning ||
              viewportLayerStressRunning ||
              contentAwareRepairBenchmarkRunning
            }
            onClick={() => void runContentAwareRepairBenchmark()}
            className="rounded bg-rose-400/20 px-2 py-1 text-[11px] text-rose-200 transition hover:bg-rose-400/30 disabled:cursor-wait disabled:opacity-55"
          >
            {contentAwareRepairBenchmarkRunning ? 'S9 内容识别中…' : 'S9 · 内容识别修复'}
          </button>
          <button
            type="button"
            onClick={() => clearReport()}
            className="rounded px-2 py-1 text-[11px] text-white/55 transition hover:bg-white/10 hover:text-white"
          >
            清空
          </button>
          <button
            type="button"
            onClick={exportReport}
            className="rounded bg-liclick-pink/25 px-2 py-1 text-[11px] text-liclick-pink transition hover:bg-liclick-pink/35"
          >
            导出 JSON
          </button>
          <button
            type="button"
            onClick={() => void copyReport()}
            className="rounded bg-cyan-400/20 px-2 py-1 text-[11px] text-cyan-200 transition hover:bg-cyan-400/30"
          >
            复制 JSON
          </button>
          <button
            type="button"
            onClick={() => setCollapsed(true)}
            className="rounded px-2 py-1 text-[11px] text-white/55 transition hover:bg-white/10 hover:text-white"
          >
            收起
          </button>
        </div>
      </div>
      <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-6 lg:grid-cols-8">
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
          label="帧耗时最大"
          value={`${metrics.frameMax.toFixed(1)} ms`}
          tone={metricTone(metrics.frameMax, 33, 80)}
        />
        <PerformanceMetric
          label="掉帧率 (>20ms)"
          value={`${metrics.droppedFrames.toFixed(0)}%`}
          tone={metricTone(metrics.droppedFrames, 5, 20)}
        />
        <PerformanceMetric
          label="人工录制 / FPS / 掉帧"
          value={
            manualRecording
              ? '录制中（再次点击结束）'
              : manualReport
                ? `${manualReport.strokes}笔 / ${manualReport.averageFps.toFixed(1)} / ${manualReport.droppedFrames}`
                : '等待开始'
          }
          tone={
            manualRecording
              ? 'text-red-300'
              : manualReport?.droppedFrames === 0
                ? 'text-emerald-300'
                : 'text-white/65'
          }
        />
        <PerformanceMetric
          label="人工 P95 / 最大帧"
          value={
            manualReport
              ? `${manualReport.frameP95.toFixed(1)} / ${manualReport.frameMax.toFixed(1)}ms`
              : '等待结果'
          }
          tone={
            manualReport && (manualReport.frameP95 > 17.5 || manualReport.frameMax > 25)
              ? 'text-rose-300'
              : 'text-emerald-300'
          }
        />
        <PerformanceMetric
          label="落笔/停笔到帧 P95 · 滚轮"
          value={
            manualReport
              ? `${manualReport.pointerDownP95.toFixed(1)} / ${manualReport.pointerUpP95.toFixed(1)}ms · ${manualReport.wheelEvents}`
              : '等待结果'
          }
        />
        <PerformanceMetric
          label="人工长任务 / 最大 / 堆变化"
          value={
            manualReport
              ? `${manualReport.longTasks} / ${manualReport.longTaskMax.toFixed(1)}ms / ${manualReport.heapDeltaMb.toFixed(1)}MB`
              : '等待结果'
          }
          tone={manualReport?.longTasks ? 'text-rose-300' : 'text-emerald-300'}
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
          label="S9 内容识别 / 总耗时 / 投影"
          value={
            contentAwareRepairBenchmarkResult
              ? `${contentAwareRepairBenchmarkResult.status === 'complete' ? '完成' : '无缺口'} / ${contentAwareRepairBenchmarkResult.totalDurationMs.toFixed(0)}ms / ${contentAwareRepairBenchmarkResult.projectedLayerCount} · #${contentAwareRepairBenchmarkResult.outputChecksum.toString(16).padStart(8, '0')}`
              : contentAwareRepairBenchmarkRunning
                ? '真实修复中'
                : '等待压测'
          }
          tone={
            contentAwareRepairBenchmarkResult?.status === 'complete' ||
            contentAwareRepairBenchmarkResult?.status === 'no-gaps'
              ? 'text-emerald-300'
              : 'text-white/65'
          }
        />
        <PerformanceMetric
          label="S9 旋转保护 P95 / 最大帧 / 掉帧"
          value={
            contentAwareRepairBenchmarkResult
              ? `${contentAwareRepairBenchmarkResult.protectedFrameP95.toFixed(1)} / ${contentAwareRepairBenchmarkResult.protectedFrameMax.toFixed(1)}ms / ${contentAwareRepairBenchmarkResult.protectedDroppedFrames.toFixed(0)}%`
              : '等待压测'
          }
          tone={metricTone(contentAwareRepairBenchmarkResult?.protectedFrameMax ?? 0, 20, 33)}
        />
        <PerformanceMetric
          label="S9 全流程 P95 / 最大帧 / 掉帧"
          value={
            contentAwareRepairBenchmarkResult
              ? `${contentAwareRepairBenchmarkResult.frameP95.toFixed(1)} / ${contentAwareRepairBenchmarkResult.frameMax.toFixed(1)}ms / ${contentAwareRepairBenchmarkResult.droppedFrames.toFixed(0)}%`
              : '等待压测'
          }
          tone={metricTone(contentAwareRepairBenchmarkResult?.frameMax ?? 0, 33, 80)}
        />
        <PerformanceMetric
          label="S9 投影烘焙 / 拓扑 / 修补 / 发布"
          value={
            contentAwareRepairBenchmarkResult
              ? `${(contentAwareRepairBenchmarkResult.phaseDurationsMs['projection-bake-ready'] ?? 0).toFixed(0)} / ${(contentAwareRepairBenchmarkResult.phaseDurationsMs['topology-ready'] ?? 0).toFixed(0)} / ${(contentAwareRepairBenchmarkResult.phaseDurationsMs['repair-worker-ready'] ?? 0).toFixed(0)} / ${(contentAwareRepairBenchmarkResult.phaseDurationsMs['atomic-publish'] ?? 0).toFixed(0)}ms`
              : '等待压测'
          }
        />
        <PerformanceMetric
          label="S9 深度 / GPU投影回读 / 质量合成"
          value={
            contentAwareRepairBenchmarkResult
              ? `${(contentAwareRepairBenchmarkResult.bakePerformanceBreakdown.runtimeDepthMs ?? 0).toFixed(0)} / ${(contentAwareRepairBenchmarkResult.bakePerformanceBreakdown.gpuRasterAndReadbackMs ?? 0).toFixed(0)} / ${(contentAwareRepairBenchmarkResult.bakePerformanceBreakdown.qualityWorkerTotalMs ?? 0).toFixed(0)}ms`
              : '等待压测'
          }
        />
        <PerformanceMetric
          label="S9 安全 / 纹理 / 眼睛 / 状态恢复"
          value={
            contentAwareRepairBenchmarkResult
              ? `${contentAwareRepairBenchmarkResult.underlaySafe ? '安全' : '危险'} / ${contentAwareRepairBenchmarkResult.textureReady ? '就绪' : '未就绪'} / ${contentAwareRepairBenchmarkResult.eyeVisible ? '开' : '关'} / ${contentAwareRepairBenchmarkResult.originalStateRestored ? '已恢复' : '未恢复'}`
              : '等待压测'
          }
          tone={
            contentAwareRepairBenchmarkResult?.underlaySafe &&
            contentAwareRepairBenchmarkResult.originalStateRestored &&
            (contentAwareRepairBenchmarkResult.status === 'no-gaps' ||
              (contentAwareRepairBenchmarkResult.textureReady &&
                contentAwareRepairBenchmarkResult.eyeVisible))
              ? 'text-emerald-300'
              : 'text-rose-300'
          }
        />
        <PerformanceMetric
          label="S9 发布→首帧可见 / 材质重建 / 不透明度"
          value={
            contentAwareRepairBenchmarkResult
              ? `${contentAwareRepairBenchmarkResult.publishToVisibleMs.toFixed(1)}ms / ${contentAwareRepairBenchmarkResult.projectedMaterialRebuilds} / ${contentAwareRepairBenchmarkResult.effectiveOpacity.toFixed(2)}`
              : '等待压测'
          }
          tone={
            contentAwareRepairBenchmarkResult &&
            contentAwareRepairBenchmarkResult.publishToVisibleMs <= 250 &&
            contentAwareRepairBenchmarkResult.projectedMaterialRebuilds === 0
              ? 'text-emerald-300'
              : 'text-amber-300'
          }
        />
        <PerformanceMetric
          label="S8 刷新恢复 / 总耗时"
          value={
            refreshRestoreBenchmarkResult
              ? `${refreshRestoreBenchmarkResult.success ? '通过' : '失败'} / ${refreshRestoreBenchmarkResult.totalMs.toFixed(0)}ms`
              : refreshRestoreBenchmarkRunning
                ? '测量中'
                : '等待压测'
          }
          tone={
            refreshRestoreBenchmarkResult?.success
              ? metricTone(refreshRestoreBenchmarkResult.totalMs, 2500, 5000)
              : 'text-rose-300'
          }
        />
        <PerformanceMetric
          label="S8 水合 / 模型 / UV / 投影"
          value={
            refreshRestoreBenchmarkResult
              ? `${refreshRestoreBenchmarkResult.hydratedMs.toFixed(0)} / ${refreshRestoreBenchmarkResult.modelFullMs.toFixed(0)} / ${refreshRestoreBenchmarkResult.uvReadyMs.toFixed(0)} / ${refreshRestoreBenchmarkResult.projectedReadyMs.toFixed(0)}ms`
              : '等待压测'
          }
        />
        <PerformanceMetric
          label="S8 图层 / 投影 / 局部重绘"
          value={
            refreshRestoreBenchmarkResult
              ? `${refreshRestoreBenchmarkResult.expectedLayers} / ${refreshRestoreBenchmarkResult.loadedProjectedLayers}·${refreshRestoreBenchmarkResult.expectedProjectedLayers} / ${refreshRestoreBenchmarkResult.loadedLocalRepaintLayers}·${refreshRestoreBenchmarkResult.expectedLocalRepaintLayers}`
              : '等待压测'
          }
          tone={refreshRestoreBenchmarkResult?.success ? 'text-emerald-300' : 'text-rose-300'}
        />
        <PerformanceMetric
          label="S8 UV 预热 / 最大长任务"
          value={
            refreshRestoreBenchmarkResult
              ? `${refreshRestoreBenchmarkResult.uvPrewarmMs.toFixed(1)} / ${refreshRestoreBenchmarkResult.longTaskMax.toFixed(1)}ms`
              : '等待压测'
          }
          tone={metricTone(refreshRestoreBenchmarkResult?.uvPrewarmMs ?? 0, 500, 1000)}
        />
        <PerformanceMetric
          label="S8 纹理阶段 P95 / 最大帧 / 掉帧"
          value={
            refreshRestoreBenchmarkResult
              ? `${refreshRestoreBenchmarkResult.frameP95.toFixed(1)} / ${refreshRestoreBenchmarkResult.frameMax.toFixed(1)}ms / ${refreshRestoreBenchmarkResult.droppedFrames.toFixed(0)}%`
              : '等待压测'
          }
          tone={metricTone(refreshRestoreBenchmarkResult?.frameMax ?? 0, 33, 80)}
        />
        <PerformanceMetric
          label={`采集计算 P95 / 最大 · ${metrics.samplerSamples}`}
          value={`${metrics.samplerP95.toFixed(2)} / ${metrics.samplerMax.toFixed(2)}ms`}
          tone={metricTone(metrics.samplerP95, 0.3, 1)}
        />
        <PerformanceMetric
          label="S7 P95 / 最大帧"
          value={
            viewportLayerStressResult
              ? `${viewportLayerStressResult.frameP95.toFixed(1)} / ${viewportLayerStressResult.frameMax.toFixed(1)}ms`
              : '等待压测'
          }
          tone={metricTone(viewportLayerStressResult?.frameP95 ?? 0, 20, 33)}
        />
        <PerformanceMetric
          label="S7 重建 / 状态错误 / 覆盖错误"
          value={
            viewportLayerStressResult
              ? `${viewportLayerStressResult.projectedBackgroundRebuilds} / ${viewportLayerStressResult.modeStateMismatches} / ${viewportLayerStressResult.overlayVisibilityMismatches}`
              : '等待压测'
          }
          tone={
            viewportLayerStressResult &&
            (viewportLayerStressResult.projectedBackgroundRebuilds > 0 ||
              viewportLayerStressResult.modeStateMismatches > 0 ||
              viewportLayerStressResult.overlayVisibilityMismatches > 0)
              ? 'text-rose-300'
              : 'text-emerald-300'
          }
        />
        <PerformanceMetric
          label="S6 交互 P95 / 最大"
          value={
            localRepaintBenchmarkResult
              ? `${localRepaintBenchmarkResult.protectedFrameP95.toFixed(1)} / ${localRepaintBenchmarkResult.protectedFrameMax.toFixed(1)}ms`
              : '等待压测'
          }
          tone={metricTone(localRepaintBenchmarkResult?.protectedFrameMax ?? 0, 20, 33)}
        />
        <PerformanceMetric
          label="S6 停笔发布 P95 / 最大"
          value={
            localRepaintBenchmarkResult
              ? `${localRepaintBenchmarkResult.publishFrameP95.toFixed(1)} / ${localRepaintBenchmarkResult.publishFrameMax.toFixed(1)}ms`
              : '等待压测'
          }
          tone={metricTone(localRepaintBenchmarkResult?.publishFrameMax ?? 0, 33, 80)}
        />
        <PerformanceMetric
          label="S6 实时反馈 P95 / 最大"
          value={
            localRepaintBenchmarkResult
              ? `${localRepaintBenchmarkResult.liveFeedbackP95.toFixed(1)} / ${localRepaintBenchmarkResult.liveFeedbackMax.toFixed(1)}ms`
              : '等待压测'
          }
          tone={metricTone(localRepaintBenchmarkResult?.liveFeedbackP95 ?? 0, 20, 33)}
        />
        <PerformanceMetric
          label="S6 按钮3就绪 / 首笔可见"
          value={
            localRepaintBenchmarkResult
              ? `${localRepaintBenchmarkResult.activationReadyMs.toFixed(1)} / ${localRepaintBenchmarkResult.activationToFirstVisibleMs.toFixed(1)}ms`
              : '等待压测'
          }
          tone={metricTone(localRepaintBenchmarkResult?.activationToFirstVisibleMs ?? 0, 100, 250)}
        />
        <PerformanceMetric
          label="S6 持久化 / 空闲等待 / 发布"
          value={
            localRepaintBenchmarkResult
              ? `${localRepaintBenchmarkResult.uvCommit.mode === 'deferred-export' ? '高清源+Alpha' : '即时UV'} / ${localRepaintBenchmarkResult.uvCommit.idleWaitMs.toFixed(0)} / ${localRepaintBenchmarkResult.uvCommit.mergeAndPublishMs.toFixed(0)}ms`
              : '等待压测'
          }
        />
        <PerformanceMetric
          label="S6 蒙版 / 应用样本"
          value={
            localRepaintBenchmarkResult
              ? `${localRepaintBenchmarkResult.maskAddSamples}+${localRepaintBenchmarkResult.maskSubtractSamples}+${localRepaintBenchmarkResult.maskRestoreSamples} / ${localRepaintBenchmarkResult.applySamples}`
              : '等待压测'
          }
        />
        <PerformanceMetric
          label="S6 按钮2 蒙版 / 输入 / Worker"
          value={
            localRepaintBenchmarkResult
              ? `${localRepaintBenchmarkResult.button2MaskCaptureMs.toFixed(1)} / ${localRepaintBenchmarkResult.button2InputTotalMs.toFixed(1)} / ${localRepaintBenchmarkResult.button2InputWorkerMs.toFixed(1)}ms`
              : '等待压测'
          }
          tone={metricTone(
            Math.max(
              localRepaintBenchmarkResult?.button2MaskCaptureMs ?? 0,
              localRepaintBenchmarkResult?.button2InputTotalMs ?? 0,
            ),
            250,
            500,
          )}
        />
        <PerformanceMetric
          label="S6 按钮2 蒙版投影数"
          value={
            localRepaintBenchmarkResult
              ? String(localRepaintBenchmarkResult.button2MaskProjectionCount)
              : '等待压测'
          }
        />
        <PerformanceMetric
          label="S6 源图 / 候选 / 内存"
          value={
            localRepaintBenchmarkResult
              ? `${localRepaintBenchmarkResult.sourceWidth}×${localRepaintBenchmarkResult.sourceHeight} / ${localRepaintBenchmarkResult.candidateCount} / ${localRepaintBenchmarkResult.heapDeltaMb.toFixed(0)}MB`
              : '等待压测'
          }
        />
        <PerformanceMetric
          label="S6 冷扫描 / 蒙版读取"
          value={
            localRepaintBenchmarkResult
              ? `${localRepaintBenchmarkResult.firstGeneratedCandidateScanMs.toFixed(1)} / ${localRepaintBenchmarkResult.falloffReadMs.toFixed(1)}ms`
              : '等待压测'
          }
        />
        <PerformanceMetric
          label="S6 射线 / 候选过滤"
          value={
            localRepaintBenchmarkResult
              ? `${localRepaintBenchmarkResult.candidateRaycastMs.toFixed(1)} / ${localRepaintBenchmarkResult.candidateFilterMs.toFixed(1)}ms`
              : '等待压测'
          }
        />
        <PerformanceMetric
          label="S6 GPU 质量验证 / 最大帧"
          value={
            localRepaintBenchmarkResult
              ? `${localRepaintBenchmarkResult.gpuProbeDurationMs.toFixed(1)} / ${(localRepaintBenchmarkResult.phaseFrameMax['s6-quality-gpu-probe'] ?? 0).toFixed(1)}ms`
              : '等待压测'
          }
        />
        <PerformanceMetric
          label="S6 最慢阶段 / 最大帧"
          value={
            localRepaintBenchmarkResult
              ? (() => {
                  const slowest = Object.entries(localRepaintBenchmarkResult.phaseFrameMax).sort(
                    (left, right) => right[1] - left[1],
                  )[0];
                  return slowest ? `${slowest[0]} / ${slowest[1].toFixed(1)}ms` : '无采样';
                })()
              : '等待压测'
          }
        />
        <PerformanceMetric
          label="S6 发布慢段 / 最大帧"
          value={
            localRepaintBenchmarkResult
              ? (() => {
                  const slowest = Object.entries(localRepaintBenchmarkResult.phaseFrameMax)
                    .filter(([phase]) => phase.startsWith('s6-publish'))
                    .sort((left, right) => right[1] - left[1])[0];
                  return slowest ? `${slowest[0]} / ${slowest[1].toFixed(1)}ms` : '无采样';
                })()
              : '等待压测'
          }
        />
        <PerformanceMetric
          label="0→14 旋转保护 P95 / 最大"
          value={
            projectedLayerRampResult
              ? `${projectedLayerRampResult.protectedFrameP95.toFixed(1)} / ${projectedLayerRampResult.protectedFrameMax.toFixed(1)}ms`
              : '等待压测'
          }
          tone={metricTone(projectedLayerRampResult?.protectedFrameP95 ?? 0, 20, 33)}
        />
        <PerformanceMetric
          label="松手发布 P95 / 最大"
          value={
            projectedLayerRampResult
              ? `${projectedLayerRampResult.publishFrameP95.toFixed(1)} / ${projectedLayerRampResult.publishFrameMax.toFixed(1)}ms`
              : '等待压测'
          }
          tone={metricTone(projectedLayerRampResult?.publishFrameMax ?? 0, 33, 80)}
        />
        <PerformanceMetric
          label={
            layerToggleScenarioResult?.scenario === 'content-aware'
              ? 'S3 修补保护 P95 / 最大'
              : layerToggleScenarioResult?.scenario === 'uv-projected'
                ? 'S5 切换保护 P95 / 最大'
                : 'S2 图层保护 P95 / 最大'
          }
          value={
            layerToggleScenarioResult
              ? `${layerToggleScenarioResult.protectedFrameP95.toFixed(1)} / ${layerToggleScenarioResult.protectedFrameMax.toFixed(1)}ms`
              : '等待压测'
          }
          tone={metricTone(layerToggleScenarioResult?.protectedFrameP95 ?? 0, 20, 33)}
        />
        <PerformanceMetric
          label="S2/S3/S5 松手发布 P95 / 最大"
          value={
            layerToggleScenarioResult
              ? `${layerToggleScenarioResult.publishFrameP95.toFixed(1)} / ${layerToggleScenarioResult.publishFrameMax.toFixed(1)}ms`
              : '等待压测'
          }
          tone={metricTone(layerToggleScenarioResult?.publishFrameMax ?? 0, 33, 80)}
        />
        <PerformanceMetric
          label="S4 合成保护 P95 / 最大"
          value={
            uvMergeBenchmarkResult
              ? `${uvMergeBenchmarkResult.protectedFrameP95.toFixed(1)} / ${uvMergeBenchmarkResult.protectedFrameMax.toFixed(1)}ms`
              : '等待压测'
          }
          tone={metricTone(uvMergeBenchmarkResult?.protectedFrameMax ?? 0, 33, 80)}
        />
        <PerformanceMetric
          label="S4 全流程 P95 / 最大 / 掉帧"
          value={
            uvMergeBenchmarkResult
              ? `${(uvMergeBenchmarkResult.fullFrameP95 ?? uvMergeBenchmarkResult.protectedFrameP95).toFixed(1)} / ${(uvMergeBenchmarkResult.fullFrameMax ?? uvMergeBenchmarkResult.protectedFrameMax).toFixed(1)}ms / ${(uvMergeBenchmarkResult.fullDroppedFrames ?? uvMergeBenchmarkResult.protectedDroppedFrames).toFixed(0)}%`
              : '等待压测'
          }
          tone={metricTone(
            uvMergeBenchmarkResult?.fullFrameMax ??
              uvMergeBenchmarkResult?.protectedFrameMax ??
              0,
            20,
            33,
          )}
        />
        <PerformanceMetric
          label="S4 GPU / 读回 / 编码"
          value={
            uvMergeBenchmarkResult
              ? `${uvMergeBenchmarkResult.gpuBakeDurationMs.toFixed(0)} / ${uvMergeBenchmarkResult.readbackDurationMs.toFixed(0)} / ${uvMergeBenchmarkResult.pngEncodeDurationMs.toFixed(0)}ms`
              : '等待压测'
          }
        />
        <PerformanceMetric
          label="S4 深度 / 光栅读回 / 质量混合"
          value={
            uvMergeBenchmarkResult
              ? `${(uvMergeBenchmarkResult.bakePerformanceBreakdown.runtimeDepthMs ?? 0).toFixed(0)} / ${(uvMergeBenchmarkResult.bakePerformanceBreakdown.gpuRasterAndReadbackMs ?? 0).toFixed(0)} / ${((uvMergeBenchmarkResult.bakePerformanceBreakdown.qualityAccumulateMs ?? 0) + (uvMergeBenchmarkResult.bakePerformanceBreakdown.qualityResolveMs ?? 0)).toFixed(0)}ms`
              : '等待压测'
          }
        />
        <PerformanceMetric
          label="S4 接缝 / 补洞 / Gutter"
          value={
            uvMergeBenchmarkResult
              ? `${(uvMergeBenchmarkResult.bakePerformanceBreakdown.seamReconcileMs ?? 0).toFixed(0)} / ${(uvMergeBenchmarkResult.bakePerformanceBreakdown.coverageRepairMs ?? 0).toFixed(0)} / ${(uvMergeBenchmarkResult.bakePerformanceBreakdown.gutterMs ?? 0).toFixed(0)}ms`
              : '等待压测'
          }
        />
        <PerformanceMetric
          label="S4 WebGPU 拓扑光栅"
          value={
            uvMergeBenchmarkResult
              ? `${uvMergeBenchmarkResult.bakePerformanceBreakdown.uvTopologyGpuAccepted === 1 ? 'GPU' : '兼容'} · ${(uvMergeBenchmarkResult.bakePerformanceBreakdown.uvTopologyWorkerTotalMs ?? 0).toFixed(0)}ms · 校准 ${(uvMergeBenchmarkResult.bakePerformanceBreakdown.uvTopologyGpuCalibrationPixels ?? 0).toFixed(0)} · 最终差异 ${(uvMergeBenchmarkResult.bakePerformanceBreakdown.uvTopologyGpuMismatchedPixels ?? 0).toFixed(0)}`
              : '等待压测'
          }
          tone={
            uvMergeBenchmarkResult?.bakePerformanceBreakdown.uvTopologyGpuAccepted === 1 &&
            (uvMergeBenchmarkResult?.bakePerformanceBreakdown.uvTopologyGpuMismatchedPixels ??
              0) === 0
              ? 'text-emerald-300'
              : 'text-amber-300'
          }
        />
        <PerformanceMetric
          label="S4 最卡阶段 / 最大帧"
          value={
            uvMergeBenchmarkResult
              ? (() => {
                  const slowest = Object.entries(uvMergeBenchmarkResult.phaseFrameMax).sort(
                    (left, right) => right[1] - left[1],
                  )[0];
                  return slowest ? `${slowest[0]} · ${slowest[1].toFixed(1)}ms` : '无样本';
                })()
              : '等待压测'
          }
        />
        <PerformanceMetric
          label="S4 输出 / 覆盖率"
          value={
            uvMergeBenchmarkResult
              ? `${(uvMergeBenchmarkResult.outputBytes / 1024 / 1024).toFixed(2)}MB / ${(uvMergeBenchmarkResult.coverageRatio * 100).toFixed(2)}%`
              : '等待压测'
          }
        />
        <PerformanceMetric
          label="S4 WebGPU RGBA / A-B"
          value={
            uvMergeBenchmarkResult?.webGpuComposite?.enabled
              ? `${uvMergeBenchmarkResult.webGpuComposite.chunkMb.toFixed(0)}MB · ${uvMergeBenchmarkResult.webGpuComposite.totalMs.toFixed(0)}ms · U/C/R ${uvMergeBenchmarkResult.webGpuComposite.uploadMs.toFixed(0)}/${uvMergeBenchmarkResult.webGpuComposite.computeMs.toFixed(0)}/${uvMergeBenchmarkResult.webGpuComposite.readbackMs.toFixed(0)} · 差异 ${uvMergeBenchmarkResult.webGpuComposite.byteMismatches} · Δ${uvMergeBenchmarkResult.webGpuComposite.maximumByteDelta} · 回退 ${uvMergeBenchmarkResult.webGpuComposite.fallbackCount}`
              : '未启用'
          }
          tone={
            (uvMergeBenchmarkResult?.webGpuComposite?.byteMismatches ?? 0) === 0
              ? 'text-emerald-300'
              : 'text-rose-300'
          }
        />
        <PerformanceMetric
          label="S4 UV 合成总耗时"
          value={
            uvMergeBenchmarkResult
              ? `${uvMergeBenchmarkResult.uvCompositeDurationMs.toFixed(0)}ms`
              : '等待压测'
          }
        />
        <PerformanceMetric
          label="S4 WebGPU 阶段最大帧"
          value={
            uvMergeBenchmarkResult
              ? `${(uvMergeBenchmarkResult.phaseFrameMax['uv-underlay-composite'] ?? 0).toFixed(1)}ms`
              : '等待压测'
          }
          tone={metricTone(
            uvMergeBenchmarkResult?.phaseFrameMax['uv-underlay-composite'] ?? 0,
            20,
            33,
          )}
        />
        <PerformanceMetric
          label="S4 WebGPU 首差异"
          value={
            uvMergeBenchmarkResult?.webGpuComposite?.firstMismatch
              ? `@${uvMergeBenchmarkResult.webGpuComposite.firstMismatch.byteOffset} CPU ${uvMergeBenchmarkResult.webGpuComposite.firstMismatch.expectedRgba.join(',')} / GPU ${uvMergeBenchmarkResult.webGpuComposite.firstMismatch.actualRgba.join(',')}`
              : '无差异'
          }
          tone={
            uvMergeBenchmarkResult?.webGpuComposite?.firstMismatch
              ? 'text-rose-300'
              : 'text-emerald-300'
          }
        />
        <PerformanceMetric
          label="整机 CPU / 最忙核"
          value={
            nativeSnapshot
              ? `${nativeSnapshot.cpu.overallUtilizationPercent.toFixed(0)}% / ${maximumCore.toFixed(0)}%`
              : '连接中'
          }
          tone={metricTone(maximumCore, 70, 90)}
        />
        <PerformanceMetric
          label="GPU / 显存"
          value={
            gpu
              ? `${gpu.utilizationGpuPercent?.toFixed(0) ?? 'N/A'}% / ${gpu.memoryUsedMb?.toFixed(0) ?? 'N/A'}MB`
              : '不可用'
          }
        />
        <PerformanceMetric
          label="阶段 4 WebGPU 运行态"
          value={
            computeBackend
              ? `${computeBackend.kind} · ${computeBackend.runtimeStatus} · 验证 ${computeBackend.selfTestDispatches} / 生产 ${computeBackend.productionDispatches}`
              : '探测中'
          }
          tone={
            computeBackend?.kind === 'webgpu' && computeBackend.runtimeStatus === 'ready'
              ? 'text-emerald-300'
              : 'text-amber-300'
          }
        />
        <PerformanceMetric
          label="系统内存"
          value={
            nativeSnapshot
              ? `${nativeSnapshot.memory.usedPercent.toFixed(0)}% · ${nativeSnapshot.memory.usedMb.toFixed(0)}MB`
              : '连接中'
          }
          tone={metricTone(nativeSnapshot?.memory.usedPercent ?? 0, 75, 88)}
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
      <div className="mt-2 grid gap-2 lg:grid-cols-[1.2fr_1fr_1fr]">
        <div className="rounded border border-white/10 bg-white/[0.035] p-2">
          <div className="mb-1 flex justify-between text-[10px] text-white/45">
            <span>帧耗时（最近 120 帧）</span>
            <span>{metrics.frameP95.toFixed(1)}ms P95</span>
          </div>
          <Sparkline values={frameHistory} color="#ef5ad8" />
        </div>
        <div className="rounded border border-white/10 bg-white/[0.035] p-2">
          <div className="mb-1 flex justify-between text-[10px] text-white/45">
            <span>整机 CPU</span>
            <span>{nativeSnapshot?.cpu.overallUtilizationPercent.toFixed(0) ?? 0}%</span>
          </div>
          <Sparkline values={cpuHistory} color="#58d6ff" />
        </div>
        <div className="rounded border border-white/10 bg-white/[0.035] p-2">
          <div className="mb-1 flex justify-between text-[10px] text-white/45">
            <span>GPU</span>
            <span>{gpu?.utilizationGpuPercent?.toFixed(0) ?? 0}%</span>
          </div>
          <Sparkline values={gpuHistory} color="#70e39b" />
        </div>
      </div>
      <div className="mt-2 grid gap-2 lg:grid-cols-[1.05fr_1.2fr_1fr]">
        <div className="rounded border border-white/10 bg-white/[0.035] p-2">
          <div className="mb-2 text-[10px] font-semibold text-white/55">逻辑处理器实时热力图</div>
          <div className="grid grid-cols-8 gap-1">
            {nativeSnapshot?.cpu.cores.map((core) => (
              <div
                key={core.logicalIndex}
                title={`L${core.logicalIndex} · ${core.utilizationPercent.toFixed(1)}% · ${core.speedMHz}MHz`}
                className="rounded px-1 py-1 text-center font-mono text-[9px] text-white"
                style={{
                  backgroundColor: `rgba(239,90,216,${0.08 + core.utilizationPercent / 115})`,
                }}
              >
                L{core.logicalIndex}
                <br />
                {core.utilizationPercent.toFixed(0)}%
              </div>
            )) ?? <span className="text-[10px] text-white/35">等待原生采集器</span>}
          </div>
          <div className="mt-1 text-[9px] text-white/30">
            {nativeSnapshot?.cpu.model ?? nativeError ?? '连接中'} ·{' '}
            {nativeSnapshot?.cpu.efficiencyClassAvailable
              ? '已识别能效等级'
              : '当前系统未提供 P/E 分类，仍按逻辑核精确采样'}
          </div>
        </div>
        <div className="rounded border border-white/10 bg-white/[0.035] p-2">
          <div className="mb-2 text-[10px] font-semibold text-white/55">统一事件时间轴</div>
          <div className="max-h-32 space-y-1 overflow-auto font-mono text-[9px]">
            {recentEvents.map((event) => (
              <div
                key={event.id}
                className="grid grid-cols-[62px_80px_1fr_58px] gap-1 text-white/55"
              >
                <span>{new Date(event.unixMs).toLocaleTimeString([], { hour12: false })}</span>
                <span>{event.category}</span>
                <span className="truncate text-white/75">{event.name}</span>
                <span className={event.phase === 'error' ? 'text-rose-300' : 'text-white/45'}>
                  {event.durationMs === undefined
                    ? event.phase
                    : `${event.durationMs.toFixed(1)}ms`}
                </span>
              </div>
            ))}
            {recentEvents.length === 0 && (
              <div className="text-white/30">等待图层、UV 合成或交互事件</div>
            )}
          </div>
        </div>
        <div className="rounded border border-white/10 bg-white/[0.035] p-2">
          <div className="mb-2 text-[10px] font-semibold text-white/55">自动分析</div>
          <ul className="space-y-1 text-[10px] leading-4 text-white/60">
            {analysis.map((finding) => (
              <li key={finding}>• {finding}</li>
            ))}
          </ul>
          <div className="mt-2 border-t border-white/10 pt-2 text-[9px] text-white/35">
            原生 1Hz · 面板 2Hz · rAF 仅写环形缓冲 ·{' '}
            {nativeSnapshot?.gpu.source ?? nativeError ?? '采集器连接中'}
          </div>
        </div>
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
  liveEraserPreviewInitialized: boolean;
  paintOverlayTargets: Set<THREE.Mesh>;
  paintPreviewOverlays: THREE.Mesh[];
  projectionCanvas: HTMLCanvasElement;
  projectionContext: CanvasRenderingContext2D;
  projectionTexture: THREE.CanvasTexture;
  maskCanvas: HTMLCanvasElement;
  maskContext: CanvasRenderingContext2D;
  maskTexture: THREE.CanvasTexture;
  maskMaterial: THREE.ShaderMaterial;
  accumulatedMaskMaterial: THREE.ShaderMaterial;
  accumulatedMaskTarget: THREE.WebGLRenderTarget;
  accumulatedMaskOverlays: THREE.Mesh[];
  accumulatedMaskReady: boolean;
  accumulatedMaskMeshes: Set<THREE.Mesh>;
  currentProjectionMeshes: Set<THREE.Mesh>;
  maskInverted: boolean;
  inpaintMaterialBindings: Array<{
    mesh: THREE.Mesh;
    original: THREE.Material | THREE.Material[];
    patched: THREE.Material | THREE.Material[];
  }>;
  directMaskReadyMeshes: Set<THREE.Mesh>;
  maskProjectorMatrix: THREE.Matrix4;
  maskProjectorObjectMatrix: THREE.Matrix4;
  maskProjectorPositionLocal: THREE.Vector3;
  maskProjectionReady: boolean;
  maskDepthTarget?: THREE.WebGLRenderTarget;
  maskDepthReady: boolean;
  inpaintSnapshots: InpaintMaskProjectionSnapshot[];
  overlayMeshes: THREE.Mesh[];
  overlayTargets: Set<THREE.Mesh>;
};

type InpaintProjectionSource = {
  texture: THREE.CanvasTexture;
  projectorMatrix: THREE.Matrix4;
  projectorObjectMatrix: THREE.Matrix4;
  projectorPositionLocal: THREE.Vector3;
  depthTarget?: THREE.WebGLRenderTarget;
};

type InpaintMaskProjectionSnapshot = InpaintProjectionSource & {
  material: THREE.ShaderMaterial;
  overlayMeshes: THREE.Mesh[];
};

function shouldRenderInpaintMaskOnMesh(layer: UvPaintLayer, mesh: THREE.Mesh) {
  return (
    layer.maskInverted ||
    layer.accumulatedMaskMeshes.has(mesh) ||
    layer.currentProjectionMeshes.has(mesh)
  );
}

type InpaintSurfaceCache = {
  meshes: THREE.Mesh[];
  triangleCount: number;
};

const inpaintSurfaceCache = new WeakMap<THREE.Object3D, InpaintSurfaceCache>();

function getInpaintSurfaceCache(model: SurfacePaintTarget) {
  const cached = inpaintSurfaceCache.get(model.group);
  if (cached) return cached;
  const meshes: THREE.Mesh[] = [];
  let triangleCount = 0;
  model.group.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    if (
      child.userData.liclickPaintOverlay ||
      child.userData.liclickViewportHelper ||
      child.userData.liclickSelectionGlow ||
      child.userData.liclickWireframeOverlay
    )
      return;
    const position = child.geometry.getAttribute('position');
    if (!position) return;
    meshes.push(child);
    triangleCount += Math.floor((child.geometry.getIndex()?.count ?? position.count) / 3);
  });
  const result = { meshes, triangleCount };
  inpaintSurfaceCache.set(model.group, result);
  return result;
}

const inpaintMaterialPatchBackups = new WeakMap<
  THREE.Material,
  {
    onBeforeCompile: THREE.Material['onBeforeCompile'];
    customProgramCacheKey: THREE.Material['customProgramCacheKey'];
  }
>();

// Extending the already-complex 14-layer projected shader with two more mask
// samplers caused a severe fill-rate/program-pressure cliff as soon as the
// selection tool was enabled. Keep the base material untouched and render the
// selection through the existing shared, depth-tested overlay pass instead.
// The overlay is absent from the render list while empty, so merely entering
// local repaint has zero per-frame geometry or fragment cost.
const USE_DIRECT_INPAINT_MATERIAL_PATCH = false;

function restoreInpaintPatchedMaterial(material: THREE.Material) {
  const backup = inpaintMaterialPatchBackups.get(material);
  if (!backup) return;
  material.onBeforeCompile = backup.onBeforeCompile;
  material.customProgramCacheKey = backup.customProgramCacheKey;
  material.needsUpdate = true;
  inpaintMaterialPatchBackups.delete(material);
}

function createInpaintPatchedMaterial(
  source: THREE.Material,
  layer: UvPaintLayer,
  mesh: THREE.Mesh,
) {
  layer.directMaskReadyMeshes ??= new Set();
  const material = source;
  if (inpaintMaterialPatchBackups.has(material)) return material;
  inpaintMaterialPatchBackups.set(material, {
    onBeforeCompile: material.onBeforeCompile,
    customProgramCacheKey: material.customProgramCacheKey,
  });
  const sharedUniforms = {
    liclickAccumulatedMask: layer.accumulatedMaskMaterial.uniforms.maskMap,
    liclickLiveMask: layer.accumulatedMaskMaterial.uniforms.liveMap,
    liclickMaskReady: layer.accumulatedMaskMaterial.uniforms.projectionReady,
    liclickBaseReady: layer.accumulatedMaskMaterial.uniforms.baseReady,
    liclickLiveOperation: layer.accumulatedMaskMaterial.uniforms.liveOperation,
    liclickLiveProjector: layer.accumulatedMaskMaterial.uniforms.liveProjectorMatrix,
    liclickLiveProjectorPosition: layer.accumulatedMaskMaterial.uniforms.liveProjectorPosition,
    liclickMaskInverted: layer.accumulatedMaskMaterial.uniforms.maskInverted,
  };
  const vertexDeclarations = `
uniform mat4 liclickLiveProjector;
uniform vec3 liclickLiveProjectorPosition;
varying vec2 vLiclickMaskUv;
varying vec4 vLiclickLivePosition;
varying float vLiclickLiveFacing;
`;
  const vertexAssignment = `
vLiclickMaskUv = uv;
vec4 liclickWorldPosition = modelMatrix * vec4(position, 1.0);
vec3 liclickWorldNormal = normalize(mat3(modelMatrix) * normal);
vec3 liclickProjectorDirection = normalize(
  liclickLiveProjectorPosition - liclickWorldPosition.xyz
);
vLiclickLivePosition = liclickLiveProjector * liclickWorldPosition;
vLiclickLiveFacing = dot(liclickWorldNormal, liclickProjectorDirection);
`;
  const fragmentDeclarations = `
uniform sampler2D liclickAccumulatedMask;
uniform sampler2D liclickLiveMask;
uniform float liclickMaskReady;
uniform float liclickBaseReady;
uniform float liclickLiveOperation;
uniform float liclickMaskInverted;
varying vec2 vLiclickMaskUv;
varying vec4 vLiclickLivePosition;
varying float vLiclickLiveFacing;
`;
  const fragmentBlend = `
if (liclickMaskReady > 0.5) {
  float liclickMaskAlpha = 0.0;
  if (liclickBaseReady > 0.5) {
    vec4 liclickBase = texture2D(liclickAccumulatedMask, vLiclickMaskUv);
    liclickMaskAlpha = max(liclickBase.r, max(liclickBase.g, liclickBase.b)) * liclickBase.a;
  }
  if (
    abs(liclickLiveOperation) > 0.5 &&
    vLiclickLivePosition.w > 0.0001 &&
    vLiclickLiveFacing > 0.01
  ) {
    vec3 liclickNdc = vLiclickLivePosition.xyz / vLiclickLivePosition.w;
    if (abs(liclickNdc.x) <= 1.0 && abs(liclickNdc.y) <= 1.0 && abs(liclickNdc.z) <= 1.0) {
      vec2 liclickLiveUv = vec2(liclickNdc.x * 0.5 + 0.5, 1.0 - (liclickNdc.y * 0.5 + 0.5));
      vec4 liclickLive = texture2D(liclickLiveMask, liclickLiveUv);
      float liclickLiveAlpha = max(liclickLive.r, max(liclickLive.g, liclickLive.b)) * liclickLive.a;
      liclickMaskAlpha = liclickLiveOperation > 0.0
        ? max(liclickMaskAlpha, liclickLiveAlpha)
        : liclickMaskAlpha * (1.0 - liclickLiveAlpha);
    }
  }
  if (liclickMaskInverted > 0.5) liclickMaskAlpha = 1.0 - liclickMaskAlpha;
  if (liclickMaskAlpha > 0.01) {
    float liclickStripe = 1.0 - step(7.0, mod(gl_FragCoord.x + gl_FragCoord.y, 14.0));
    float liclickMix = mix(0.16, 0.94, liclickStripe) * liclickMaskAlpha;
    // Match the established selection material exactly. This blend happens
    // before Three's final linear-to-output conversion, so keep the canonical
    // #ac2f0d value sampled from the product reference in linear space instead
    // of mixing an sRGB literal into a
    // linear fragment (which made the live stroke look pink).
    gl_FragColor.rgb = mix(
      gl_FragColor.rgb,
      vec3(0.412542613, 0.028426040, 0.004024717),
      liclickMix
    );
  }
}
`;
  const previousCompile = material.onBeforeCompile;
  const previousCacheKey = material.customProgramCacheKey;
  material.onBeforeCompile = (shader, renderer) => {
    previousCompile.call(material, shader, renderer);
    Object.assign(shader.uniforms, sharedUniforms);
    shader.vertexShader = `${vertexDeclarations}${shader.vertexShader}`.replace(
      /}\s*$/,
      `${vertexAssignment}}`,
    );
    const fragmentSource = `${fragmentDeclarations}${shader.fragmentShader}`;
    const outputConversion = '#include <colorspace_fragment>';
    const outputConversionIndex = fragmentSource.lastIndexOf(outputConversion);
    shader.fragmentShader =
      outputConversionIndex >= 0
        ? `${fragmentSource.slice(0, outputConversionIndex)}${fragmentBlend}${fragmentSource.slice(outputConversionIndex)}`
        : fragmentSource.replace(/}\s*$/, `${fragmentBlend}}`);
  };
  material.customProgramCacheKey = () =>
    `${previousCacheKey.call(material)}:liclick-inpaint-direct-v2`;
  material.needsUpdate = true;
  return material;
}

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

type SurfaceStrokePaintTool = PaintToolMode | 'inpaint-apply-erase';

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
  restoredMaskPromise?: Promise<void>;
  restoredMaskReady: boolean;
  gpuOverlayReady?: boolean;
  benchmarkFalloffPixels?: Uint8ClampedArray;
  hasContent: boolean;
};

type LocalRepaintGpuOverlayState = {
  sourceKey: string;
  layerId: string;
  visibilityLayerId?: string;
  visibilityLayerSeen: boolean;
  material: THREE.ShaderMaterial;
  root: THREE.Group;
  meshes: THREE.Mesh[];
  unsubscribeVisibility: () => void;
  compilePromise?: Promise<THREE.Object3D>;
  disposeRequested?: boolean;
  disposed?: boolean;
};

function finalizeLocalRepaintGpuOverlayDisposal(state: LocalRepaintGpuOverlayState) {
  if (state.disposed) return;
  state.disposed = true;
  disposeGeneratedMaterialTree(state.material);
}

function disposeLocalRepaintGpuOverlay(state: LocalRepaintGpuOverlayState | undefined) {
  if (!state || state.disposeRequested) return;
  state.disposeRequested = true;
  state.unsubscribeVisibility();
  state.root.removeFromParent();
  if (state.compilePromise) {
    // Three's compileAsync poller assumes every captured material keeps its
    // currentProgram until the promise settles. An effect replacement can
    // detach this overlay immediately, but disposing the material mid-poll
    // makes WebGLRenderer dereference an undefined program and leaves the
    // background model on its neutral white fallback after refresh.
    void state.compilePromise.then(
      () => finalizeLocalRepaintGpuOverlayDisposal(state),
      () => finalizeLocalRepaintGpuOverlayDisposal(state),
    );
    return;
  }
  finalizeLocalRepaintGpuOverlayDisposal(state);
}

function setLocalRepaintGpuOverlayVisibility(state: LocalRepaintGpuOverlayState, visible: boolean) {
  let changed = false;
  if (state.root.visible !== visible) {
    state.root.visible = visible;
    changed = true;
  }
  for (const mesh of state.meshes) {
    if (mesh.visible === visible) continue;
    mesh.visible = visible;
    changed = true;
  }
  const opacity = state.material.uniforms.layerOpacity;
  const expectedOpacity = visible ? 1 : 0;
  if (opacity && opacity.value !== expectedOpacity) {
    opacity.value = expectedOpacity;
    changed = true;
  }
  document.body.dataset.localRepaintOverlayVisible = visible ? '1' : '0';
  return changed;
}

function readLocalRepaintGpuOverlayLayerVisibility(
  state: LocalRepaintGpuOverlayState,
  layers = useLayerStore.getState().layers,
) {
  if (!state.visibilityLayerId) return true;
  const layer = layers.find((candidate) => candidate.id === state.visibilityLayerId);
  if (layer) {
    state.visibilityLayerSeen = true;
    return layer.visible;
  }
  // A live preview is created before its first persisted row, so an unseen row
  // must not hide realtime brush feedback. Once that row has existed, however,
  // its removal is authoritative and the renderer-owned twin must stay hidden.
  return !state.visibilityLayerSeen;
}

function createLocalRepaintFalloffCanvas(
  allowedMaskImage: HTMLImageElement | undefined,
  width: number,
  height: number,
) {
  const startedAt = performance.now();
  const reportDuration = () => {
    if (document.body.dataset.perfLocalRepaintMeasuring === '1') {
      document.body.dataset.localRepaintFalloffBuildMs = (performance.now() - startedAt).toFixed(1);
    }
  };
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) {
    reportDuration();
    return canvas;
  }

  // Missing visibility data must fail closed. Treating it as a full-white mask
  // lets a stale source project through unrelated/front-facing geometry.
  context.clearRect(0, 0, width, height);
  if (!allowedMaskImage) {
    reportDuration();
    return canvas;
  }

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
    // A decoded but empty authoritative mask is still empty. Opening it to
    // full white reintroduced projection-through and repaint dead zones.
    context.clearRect(0, 0, width, height);
    reportDuration();
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
  reportDuration();
  return canvas;
}

function getLocalRepaintLiveMaskSize(sourceWidth: number, sourceHeight: number) {
  const sourceAspect = sourceWidth / Math.max(sourceHeight, 1);
  return {
    width:
      sourceAspect >= 1
        ? LOCAL_REPAINT_LIVE_MASK_MAX_SIZE
        : Math.max(1, Math.round(LOCAL_REPAINT_LIVE_MASK_MAX_SIZE * sourceAspect)),
    height:
      sourceAspect >= 1
        ? Math.max(1, Math.round(LOCAL_REPAINT_LIVE_MASK_MAX_SIZE / sourceAspect))
        : LOCAL_REPAINT_LIVE_MASK_MAX_SIZE,
  };
}

async function createLocalRepaintLiveSource(
  sourceImage: HTMLImageElement,
): Promise<HTMLImageElement | ImageBitmap> {
  const sourceWidth = sourceImage.naturalWidth || sourceImage.width;
  const sourceHeight = sourceImage.naturalHeight || sourceImage.height;
  const maximumDimension = Math.max(sourceWidth, sourceHeight);
  if (
    maximumDimension <= LOCAL_REPAINT_LIVE_SOURCE_MAX_SIZE ||
    typeof createImageBitmap !== 'function'
  ) {
    return sourceImage;
  }
  const scale = LOCAL_REPAINT_LIVE_SOURCE_MAX_SIZE / maximumDimension;
  return createImageBitmap(sourceImage, {
    resizeWidth: Math.max(1, Math.round(sourceWidth * scale)),
    resizeHeight: Math.max(1, Math.round(sourceHeight * scale)),
    resizeQuality: 'high',
  });
}

const localRepaintFalloffCanvasCache = new WeakMap<
  HTMLImageElement,
  WeakMap<HTMLImageElement, Map<string, Promise<HTMLCanvasElement>>>
>();

function createLocalRepaintFalloffCanvasAsync(
  allowedMaskImage: HTMLImageElement,
  sourceImage: HTMLImageElement,
  width: number,
  height: number,
) {
  const sizeKey = `${width}x${height}`;
  let maskCache = localRepaintFalloffCanvasCache.get(allowedMaskImage);
  if (!maskCache) {
    maskCache = new WeakMap();
    localRepaintFalloffCanvasCache.set(allowedMaskImage, maskCache);
  }
  let sourceCache = maskCache.get(sourceImage);
  if (!sourceCache) {
    sourceCache = new Map();
    maskCache.set(sourceImage, sourceCache);
  }
  const cached = sourceCache.get(sizeKey);
  if (cached) return cached;
  const pending = (async () => {
    try {
      const { bitmap, processMs } = await createLocalRepaintFalloffInWorker({
        mask: allowedMaskImage,
        source: sourceImage,
        width,
        height,
      });
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) {
        bitmap.close();
        throw new Error('Could not publish local repaint falloff canvas.');
      }
      context.drawImage(bitmap, 0, 0);
      bitmap.close();
      if (document.body.dataset.perfLocalRepaintMeasuring === '1') {
        document.body.dataset.localRepaintFalloffWorkerMs = processMs.toFixed(1);
        document.body.dataset.localRepaintFalloffBuildMs = 'worker';
      }
      return canvas;
    } catch (error) {
      console.warn('[Liclick 3D Texture] Falloff worker unavailable; using main thread.', error);
      return constrainLocalRepaintFalloffToSourceContent(
        createLocalRepaintFalloffCanvas(allowedMaskImage, width, height),
        sourceImage,
      );
    }
  })();
  sourceCache.set(sizeKey, pending);
  void pending.catch(() => {
    if (sourceCache?.get(sizeKey) === pending) sourceCache.delete(sizeKey);
  });
  return pending;
}

function constrainLocalRepaintFalloffToSourceContent(
  falloffCanvas: HTMLCanvasElement,
  sourceImage: HTMLImageElement,
) {
  const width = falloffCanvas.width;
  const height = falloffCanvas.height;
  const sourceMaskCanvas = document.createElement('canvas');
  sourceMaskCanvas.width = width;
  sourceMaskCanvas.height = height;
  const sourceMaskContext = sourceMaskCanvas.getContext('2d', { willReadFrequently: true });
  const outputCanvas = document.createElement('canvas');
  outputCanvas.width = width;
  outputCanvas.height = height;
  const outputContext = outputCanvas.getContext('2d');
  if (!sourceMaskContext || !outputContext) return falloffCanvas;

  // The generation panel previews local-repaint results after removing the
  // edge-connected dark backdrop. Apply the same rule to projection coverage,
  // but at the lightweight live-mask resolution: the original 2K/4K colour
  // image stays untouched and no full-size PNG/base64 copy is needed.
  sourceMaskContext.drawImage(sourceImage, 0, 0, width, height);
  const sourcePixels = sourceMaskContext.getImageData(0, 0, width, height);
  const transparentSource = removeEdgeConnectedNeutralBackground(sourcePixels, 'dark-only');
  const alphaMask = sourceMaskContext.createImageData(width, height);
  for (let offset = 0; offset < alphaMask.data.length; offset += 4) {
    alphaMask.data[offset] = 255;
    alphaMask.data[offset + 1] = 255;
    alphaMask.data[offset + 2] = 255;
    alphaMask.data[offset + 3] = transparentSource.imageData.data[offset + 3];
  }
  sourceMaskContext.putImageData(alphaMask, 0, 0);

  // Keep the cached visibility falloff immutable. A capture mask may be reused
  // by another generation whose transparent subject silhouette is different.
  outputContext.drawImage(falloffCanvas, 0, 0);
  outputContext.globalCompositeOperation = 'destination-in';
  outputContext.drawImage(sourceMaskCanvas, 0, 0);
  outputContext.globalCompositeOperation = 'source-over';
  return outputCanvas;
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
  // The interactive UV stamps already provide the authoritative result. The
  // deferred projection pass only closes missed seams, so a 2K ceiling avoids
  // a 4K GPU readback/canvas upload without reducing brush responsiveness.
  if (size >= 2048) return 2048;
  if (size >= 1024) return 1024;
  return 512;
}

async function yieldProjectedEraserRefinement() {
  // Yield after bounded canvas work so pointer input and the next WebGL frame
  // are presented before background history/refinement work continues.
  await waitForBrowserPaint(40);
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
    enableDilation: true,
    dilationPixels: 2,
    outputAlpha: 'transparent',
    gpuCompositeMode: 'coverage-alpha',
    // A tiny GPU dilation closes the same visible cracks without synchronously
    // rebuilding seam geometry for a dense model on the editor thread.
    uvCoverageGapPixels: 0,
    repairMissingUvSeams: false,
    runtimeVisibilityMaxSize: 512,
    runtimeVisibilityIncludeNormal: false,
    skipGpuValidation: true,
    minimumCoverageRatio: 0,
    commitToProject: false,
    markSourceLayersBaked: false,
    skipImageEncoding: true,
    skipCpuPostprocess: true,
  });
}

function createInpaintDepthTarget(width: number, height: number) {
  const target = new THREE.WebGLRenderTarget(width, height, {
    format: THREE.RGBAFormat,
    type: THREE.UnsignedByteType,
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    depthBuffer: true,
    stencilBuffer: false,
    samples: 0,
  });
  const depthTexture = new THREE.DepthTexture(width, height, THREE.UnsignedIntType);
  depthTexture.format = THREE.DepthFormat;
  depthTexture.minFilter = THREE.NearestFilter;
  depthTexture.magFilter = THREE.NearestFilter;
  depthTexture.generateMipmaps = false;
  target.depthTexture = depthTexture;
  target.texture.generateMipmaps = false;
  return target;
}

function bindInpaintDepthTarget(
  material: THREE.ShaderMaterial,
  target: THREE.WebGLRenderTarget | undefined,
  ready = Boolean(target),
) {
  // Keep HMR-compatible paint layers usable while their material instance is
  // replaced by the new depth-aware overlay generation.
  if (
    !material.uniforms.occlusionDepthMap ||
    !material.uniforms.occlusionDepthTexelSize ||
    !material.uniforms.occlusionDepthReady
  )
    return;
  material.uniforms.occlusionDepthMap.value = target?.depthTexture ?? null;
  (material.uniforms.occlusionDepthTexelSize.value as THREE.Vector2).set(
    target ? 1 / Math.max(1, target.width) : 1,
    target ? 1 / Math.max(1, target.height) : 1,
  );
  material.uniforms.occlusionDepthReady.value = ready && target?.depthTexture ? 1 : 0;
}

const inpaintDepthShader = `
  uniform sampler2D occlusionDepthMap;
  uniform vec2 occlusionDepthTexelSize;
  uniform float occlusionDepthReady;
  uniform float occlusionDepthEpsilon;

  bool isProjectorSurfaceVisible(vec2 projectorUv, float projectedDepth) {
    // A missing depth capture must never turn the screen-space projector into
    // an x-ray brush. Pointer input waits for this capture as well, while this
    // fail-closed branch protects the live preview and all later capture paths.
    if (occlusionDepthReady < 0.5) return false;
    float visibleDepth = texture2D(occlusionDepthMap, projectorUv).r;
    if (visibleDepth >= 0.999999) {
      // At a raster silhouette the centre texel can be clear even though the
      // brush still covers the edge. Fall back only to the nearest valid
      // neighbour. Using the farthest neighbour here admitted surfaces behind
      // thin shells and gaps.
      float nearestDepth = 1.0;
      float validSamples = 0.0;
      vec2 offsets[4];
      offsets[0] = vec2(occlusionDepthTexelSize.x, 0.0);
      offsets[1] = vec2(-occlusionDepthTexelSize.x, 0.0);
      offsets[2] = vec2(0.0, occlusionDepthTexelSize.y);
      offsets[3] = vec2(0.0, -occlusionDepthTexelSize.y);
      for (int index = 0; index < 4; index++) {
        float capturedDepth = texture2D(
          occlusionDepthMap,
          clamp(projectorUv + offsets[index], vec2(0.0), vec2(1.0))
        ).r;
        if (capturedDepth < 0.999999) {
          nearestDepth = min(nearestDepth, capturedDepth);
          validSamples += 1.0;
        }
      }
      if (validSamples < 0.5) return false;
      visibleDepth = nearestDepth;
    }
    return projectedDepth <= visibleDepth + occlusionDepthEpsilon;
  }
`;

function createInpaintMaskMaterial(maskTexture: THREE.CanvasTexture) {
  return new THREE.ShaderMaterial({
    uniforms: {
      maskMap: { value: maskTexture },
      occlusionDepthMap: { value: null },
      occlusionDepthTexelSize: { value: new THREE.Vector2(1, 1) },
      occlusionDepthReady: { value: 0 },
      occlusionDepthEpsilon: { value: INPAINT_DEPTH_EPSILON },
      projectorMatrix: { value: new THREE.Matrix4() },
      projectorPosition: { value: new THREE.Vector3() },
      projectionReady: { value: 0 },
      stripeColor: { value: new THREE.Color('#ac2f0d') },
      stripeOpacity: { value: 0.94 },
      selectionFillOpacity: { value: 0.16 },
      stripePeriod: { value: 14 },
      stripeWidth: { value: 7 },
    },
    vertexShader: `
      uniform mat4 projectorMatrix;
      uniform vec3 projectorPosition;
      varying vec4 vProjectedPosition;
      varying float vProjectorFacing;
      varying float vViewerFacing;

      void main() {
        vec4 worldPosition = modelMatrix * vec4(position, 1.0);
        vec3 worldNormal = normalize(mat3(modelMatrix) * normal);
        vec3 projectorDirection = normalize(projectorPosition - worldPosition.xyz);
        vec3 viewerDirection = normalize(cameraPosition - worldPosition.xyz);
        vProjectedPosition = projectorMatrix * worldPosition;
        vProjectorFacing = dot(worldNormal, projectorDirection);
        vViewerFacing = dot(worldNormal, viewerDirection);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform sampler2D maskMap;
      uniform float projectionReady;
      uniform vec3 stripeColor;
      uniform float stripeOpacity;
      uniform float selectionFillOpacity;
      uniform float stripePeriod;
      uniform float stripeWidth;
      varying vec4 vProjectedPosition;
      varying float vProjectorFacing;
      varying float vViewerFacing;
      ${inpaintDepthShader}

      void main() {
        if (projectionReady < 0.5) discard;
        if (
          vProjectedPosition.w <= 0.0001 ||
          vProjectorFacing * vViewerFacing < 0.0
        ) discard;
        vec3 ndc = vProjectedPosition.xyz / vProjectedPosition.w;
        if (abs(ndc.x) > 1.0 || abs(ndc.y) > 1.0 || abs(ndc.z) > 1.0) discard;
        vec2 projectorUv = ndc.xy * 0.5 + 0.5;
        if (!isProjectorSurfaceVisible(projectorUv, ndc.z * 0.5 + 0.5)) discard;
        vec2 maskUv = projectorUv;
        maskUv.y = 1.0 - maskUv.y;
        vec4 maskTexel = texture2D(maskMap, maskUv);
        float maskAlpha = max(maskTexel.r, max(maskTexel.g, maskTexel.b)) * maskTexel.a;
        if (maskAlpha <= 0.01) discard;

        float coord = mod(gl_FragCoord.x + gl_FragCoord.y, stripePeriod);
        float stripe = 1.0 - step(stripeWidth, coord);
        gl_FragColor = vec4(
          stripeColor,
          mix(selectionFillOpacity, stripeOpacity, stripe) * maskAlpha
        );
      }
    `,
    transparent: true,
    depthWrite: false,
    // Keep the overlay above the model surface, but still consult scene depth so
    // a front-side selection can never bleed through to hidden back faces.
    depthTest: true,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
    // Imported production meshes can contain reversed winding or two-sided
    // parts. Visibility is decided by the scene depth buffer, so render both
    // sides here instead of letting inconsistent normals punch holes through
    // the topmost selection overlay.
    side: THREE.DoubleSide,
    toneMapped: false,
  });
}

function createAccumulatedInpaintMaskMaterial(maskTexture: THREE.Texture) {
  const material = new THREE.ShaderMaterial({
    uniforms: {
      maskMap: { value: maskTexture },
      occlusionDepthMap: { value: null },
      occlusionDepthTexelSize: { value: new THREE.Vector2(1, 1) },
      occlusionDepthReady: { value: 0 },
      occlusionDepthEpsilon: { value: INPAINT_DEPTH_EPSILON },
      projectionReady: { value: 0 },
      baseReady: { value: 0 },
      liveMap: { value: null },
      liveProjectorMatrix: { value: new THREE.Matrix4() },
      liveProjectorPosition: { value: new THREE.Vector3() },
      liveOperation: { value: 0 },
      maskInverted: { value: 0 },
      stripeColor: { value: new THREE.Color('#ac2f0d') },
      stripeOpacity: { value: 0.94 },
      selectionFillOpacity: { value: 0.16 },
      stripePeriod: { value: 14 },
      stripeWidth: { value: 7 },
    },
    vertexShader: `
      uniform mat4 liveProjectorMatrix;
      uniform vec3 liveProjectorPosition;
      varying vec2 vMaskUv;
      varying vec4 vLiveProjectedPosition;
      varying float vLiveProjectorFacing;
      varying float vViewerFacing;
      void main() {
        vMaskUv = uv;
        vec4 worldPosition = modelMatrix * vec4(position, 1.0);
        vec3 worldNormal = normalize(mat3(modelMatrix) * normal);
        vec3 liveDirection = normalize(liveProjectorPosition - worldPosition.xyz);
        vec3 viewerDirection = normalize(cameraPosition - worldPosition.xyz);
        vLiveProjectedPosition = liveProjectorMatrix * worldPosition;
        vLiveProjectorFacing = dot(worldNormal, liveDirection);
        vViewerFacing = dot(worldNormal, viewerDirection);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform sampler2D maskMap;
      uniform sampler2D liveMap;
      uniform float projectionReady;
      uniform float baseReady;
      uniform float liveOperation;
      uniform float maskInverted;
      uniform vec3 stripeColor;
      uniform float stripeOpacity;
      uniform float selectionFillOpacity;
      uniform float stripePeriod;
      uniform float stripeWidth;
      varying vec2 vMaskUv;
      varying vec4 vLiveProjectedPosition;
      varying float vLiveProjectorFacing;
      varying float vViewerFacing;
      ${inpaintDepthShader}
      void main() {
        if (projectionReady < 0.5) discard;
        float maskAlpha = 0.0;
        if (baseReady > 0.5) {
          vec4 maskTexel = texture2D(maskMap, vMaskUv);
          // R/G preserve which geometric side faced the painting camera. Match
          // that sign to the current view instead of hard-clipping interpolated
          // normals, which produced thin cracks across otherwise solid masks.
          maskAlpha = vViewerFacing >= 0.0 ? maskTexel.r : maskTexel.g;
        }
        if (
          abs(liveOperation) > 0.5 &&
          vLiveProjectedPosition.w > 0.0001 &&
          vLiveProjectorFacing * vViewerFacing >= 0.0
        ) {
          vec3 liveNdc = vLiveProjectedPosition.xyz / vLiveProjectedPosition.w;
          if (abs(liveNdc.x) <= 1.0 && abs(liveNdc.y) <= 1.0 && abs(liveNdc.z) <= 1.0) {
            vec2 liveProjectorUv = liveNdc.xy * 0.5 + 0.5;
            float liveDepth = liveNdc.z * 0.5 + 0.5;
            if (isProjectorSurfaceVisible(liveProjectorUv, liveDepth)) {
              vec2 liveUv = vec2(liveProjectorUv.x, 1.0 - liveProjectorUv.y);
              vec4 liveTexel = texture2D(liveMap, liveUv);
              float liveAlpha = max(liveTexel.r, max(liveTexel.g, liveTexel.b)) * liveTexel.a;
              maskAlpha = liveOperation > 0.0
                ? max(maskAlpha, liveAlpha)
                : maskAlpha * (1.0 - liveAlpha);
            }
          }
        }
        if (maskInverted > 0.5) maskAlpha = 1.0 - maskAlpha;
        if (maskAlpha <= 0.01) discard;
        float coord = mod(gl_FragCoord.x + gl_FragCoord.y, stripePeriod);
        float stripe = 1.0 - step(stripeWidth, coord);
        // The projected color stack writes its own small depth bias. Keep the
        // editor selection deterministically in front of that coplanar surface;
        // polygon offset alone becomes angle-dependent and made the mask vanish
        // when the painted face was viewed head-on.
        gl_FragDepthEXT = clamp(gl_FragCoord.z - 0.00008, 0.0, 1.0);
        gl_FragColor = vec4(
          stripeColor,
          mix(selectionFillOpacity, stripeOpacity, stripe) * maskAlpha
        );
      }
    `,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    polygonOffset: true,
    // Preserve early-Z. Explicit fragment-depth writes made zoom cost scale
    // with every hidden/internal triangle in this dense double-sided model.
    polygonOffsetFactor: -16,
    polygonOffsetUnits: -16,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
  // Three.js normally renders transparent DoubleSide materials twice. This is
  // a surface editor overlay, not a translucent volume; one double-sided pass
  // preserves the exact pixels and halves its dense-mesh submission cost.
  material.forceSinglePass = true;
  return material;
}

function createLiveInpaintScreenPreview() {
  const material = new THREE.ShaderMaterial({
    uniforms: {
      maskMap: { value: null as THREE.Texture | null },
      surfaceDepthMap: { value: null as THREE.Texture | null },
      previewReady: { value: 0 },
      stripeColor: { value: new THREE.Color('#ac2f0d') },
      stripeOpacity: { value: 0.94 },
      selectionFillOpacity: { value: 0.16 },
    },
    vertexShader: `
      varying vec2 vScreenUv;
      void main() {
        vScreenUv = uv;
        gl_Position = vec4(position.xy, 0.0, 1.0);
      }
    `,
    fragmentShader: `
      uniform sampler2D maskMap;
      uniform sampler2D surfaceDepthMap;
      uniform float previewReady;
      uniform vec3 stripeColor;
      uniform float stripeOpacity;
      uniform float selectionFillOpacity;
      varying vec2 vScreenUv;
      void main() {
        if (previewReady < 0.5) discard;
        // Depth and canvas textures use opposite vertical origins. The captured
        // depth clips the brush to the front-most target surface without drawing
        // the production mesh a second time.
        float surfaceDepth = texture2D(surfaceDepthMap, vScreenUv).r;
        if (surfaceDepth >= 0.999999) discard;
        vec2 maskUv = vec2(vScreenUv.x, 1.0 - vScreenUv.y);
        vec4 maskTexel = texture2D(maskMap, maskUv);
        float maskAlpha = max(maskTexel.r, max(maskTexel.g, maskTexel.b)) * maskTexel.a;
        if (maskAlpha <= 0.01) discard;
        float stripe = 1.0 - step(7.0, mod(gl_FragCoord.x + gl_FragCoord.y, 14.0));
        gl_FragColor = vec4(
          stripeColor,
          mix(selectionFillOpacity, stripeOpacity, stripe) * maskAlpha
        );
      }
    `,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
  mesh.name = 'Liclick Live Inpaint Screen Preview';
  mesh.frustumCulled = false;
  mesh.matrixAutoUpdate = false;
  mesh.renderOrder = INPAINT_MASK_OVERLAY_RENDER_ORDER + 1;
  mesh.visible = false;
  mesh.userData.liclickViewportHelper = true;
  return { mesh, material };
}

function createInpaintAccumulationTarget(size = PROJECTION_PAINT_MAX_SIZE) {
  const target = new THREE.WebGLRenderTarget(size, size, {
    format: THREE.RGBAFormat,
    type: THREE.UnsignedByteType,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: false,
    stencilBuffer: false,
  });
  target.texture.colorSpace = THREE.NoColorSpace;
  target.texture.generateMipmaps = false;
  return target;
}

function createInpaintUvAccumulationMaterial(
  snapshot: InpaintProjectionSource,
  operation: 'add' | 'subtract',
) {
  const material = new THREE.ShaderMaterial({
    uniforms: {
      maskMap: { value: snapshot.texture },
      occlusionDepthMap: { value: null },
      occlusionDepthTexelSize: { value: new THREE.Vector2(1, 1) },
      occlusionDepthReady: { value: 0 },
      occlusionDepthEpsilon: { value: INPAINT_DEPTH_EPSILON },
      projectorMatrix: { value: new THREE.Matrix4() },
      projectorPosition: { value: new THREE.Vector3() },
      projectionReady: { value: 1 },
    },
    vertexShader: `
      uniform mat4 projectorMatrix;
      uniform vec3 projectorPosition;
      varying vec4 vProjectedPosition;
      varying float vProjectorFacing;
      void main() {
        vec4 worldPosition = modelMatrix * vec4(position, 1.0);
        vec3 worldNormal = normalize(mat3(modelMatrix) * normal);
        vec3 projectorDelta = projectorPosition - worldPosition.xyz;
        vec3 projectorDirection = projectorDelta / max(length(projectorDelta), 0.000001);
        vProjectedPosition = projectorMatrix * worldPosition;
        vProjectorFacing = dot(worldNormal, projectorDirection);
        gl_Position = vec4(uv.x * 2.0 - 1.0, uv.y * 2.0 - 1.0, 0.0, 1.0);
      }
    `,
    fragmentShader: `
      uniform sampler2D maskMap;
      varying vec4 vProjectedPosition;
      varying float vProjectorFacing;
      ${inpaintDepthShader}
      void main() {
        if (vProjectedPosition.w <= 0.0001) discard;
        vec3 ndc = vProjectedPosition.xyz / vProjectedPosition.w;
        if (abs(ndc.x) > 1.0 || abs(ndc.y) > 1.0 || abs(ndc.z) > 1.0) discard;
        vec2 projectorUv = ndc.xy * 0.5 + 0.5;
        if (!isProjectorSurfaceVisible(projectorUv, ndc.z * 0.5 + 0.5)) discard;
        vec2 maskUv = vec2(projectorUv.x, 1.0 - projectorUv.y);
        vec4 maskTexel = texture2D(maskMap, maskUv);
        float coverage = max(maskTexel.r, max(maskTexel.g, maskTexel.b)) * maskTexel.a;
        if (coverage <= 0.01) discard;
        // Store the two sides independently. The accumulated UV mask can then
        // be shown only from the side that was actually painted, without using
        // a brittle normal threshold that cuts cracks through the selection.
        float positiveSide = step(0.0, vProjectorFacing);
        gl_FragColor = vec4(
          coverage * positiveSide,
          coverage * (1.0 - positiveSide),
          coverage,
          coverage
        );
      }
    `,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: operation === 'add' ? THREE.OneFactor : THREE.ZeroFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
  bindInpaintDepthTarget(material, snapshot.depthTarget);
  return material;
}

type InpaintUvAccumulationResources = {
  modelGroup: THREE.Object3D;
  scene: THREE.Scene;
  material: THREE.ShaderMaterial;
  meshes: Array<{ source: THREE.Mesh; bake: THREE.Mesh }>;
};

const inpaintUvAccumulationResources = new WeakMap<
  THREE.WebGLRenderTarget,
  InpaintUvAccumulationResources
>();

function disposeInpaintUvAccumulationResources(target?: THREE.WebGLRenderTarget) {
  if (!target) return;
  const resources = inpaintUvAccumulationResources.get(target);
  if (!resources) return;
  resources.meshes.forEach(({ bake }) => bake.removeFromParent());
  resources.material.dispose();
  inpaintUvAccumulationResources.delete(target);
}

function getInpaintUvAccumulationResources(
  model: SurfacePaintTarget,
  snapshot: InpaintProjectionSource,
  target: THREE.WebGLRenderTarget,
  operation: 'add' | 'subtract',
) {
  const existing = inpaintUvAccumulationResources.get(target);
  if (existing?.modelGroup === model.group) return existing;
  if (existing) disposeInpaintUvAccumulationResources(target);
  const material = createInpaintUvAccumulationMaterial(snapshot, operation);
  const scene = new THREE.Scene();
  const meshes = getInpaintSurfaceCache(model).meshes.flatMap((source) => {
    if (!source.geometry.getAttribute('uv')) return [];
    const bake = new THREE.Mesh(source.geometry, material);
    bake.matrixAutoUpdate = false;
    bake.frustumCulled = false;
    scene.add(bake);
    return [{ source, bake }];
  });
  const resources = { modelGroup: model.group, scene, material, meshes };
  inpaintUvAccumulationResources.set(target, resources);
  return resources;
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

function updateInpaintProjectionCamera(
  layer: UvPaintLayer,
  camera: THREE.Camera,
  object: THREE.Object3D,
) {
  camera.updateMatrixWorld(true);
  object.updateWorldMatrix(true, false);
  layer.maskProjectorMatrix.copy(camera.projectionMatrix).multiply(camera.matrixWorldInverse);
  layer.maskProjectorObjectMatrix.copy(object.matrixWorld);
  layer.maskProjectorPositionLocal
    .setFromMatrixPosition(camera.matrixWorld)
    .applyMatrix4(inpaintObjectMatrixInverseScratch.copy(object.matrixWorld).invert());
  layer.maskProjectionReady = true;
  layer.maskDepthReady = false;
  bindInpaintDepthTarget(layer.maskMaterial, layer.maskDepthTarget, false);
  bindInpaintDepthTarget(layer.accumulatedMaskMaterial, layer.maskDepthTarget, false);
  [layer.maskMaterial, layer.paintPreviewMaterial].forEach((material) => {
    const uniforms = material.uniforms;
    (uniforms.projectorMatrix.value as THREE.Matrix4).copy(layer.maskProjectorMatrix);
    (uniforms.projectorPosition.value as THREE.Vector3).setFromMatrixPosition(camera.matrixWorld);
    uniforms.projectionReady.value = 1;
  });
}

const inpaintProjectorComparisonScratch = new THREE.Matrix4();
const inpaintObjectMatrixInverseScratch = new THREE.Matrix4();
const inpaintAdjustedProjectorScratch = new THREE.Matrix4();
const inpaintMaterialTransformCache = new WeakMap<
  THREE.ShaderMaterial,
  {
    objectMatrixWorld: THREE.Matrix4;
    projectorMatrix: THREE.Matrix4;
    projectorObjectMatrix: THREE.Matrix4;
    projectorPositionLocal: THREE.Vector3;
  }
>();

function updateInpaintMaterialForObject(
  material: THREE.ShaderMaterial,
  projectorMatrix: THREE.Matrix4,
  projectorObjectMatrix: THREE.Matrix4,
  projectorPositionLocal: THREE.Vector3,
  object: THREE.Object3D,
) {
  object.updateWorldMatrix(true, false);
  const cached = inpaintMaterialTransformCache.get(material);
  if (
    cached?.objectMatrixWorld.equals(object.matrixWorld) &&
    cached.projectorMatrix.equals(projectorMatrix) &&
    cached.projectorObjectMatrix.equals(projectorObjectMatrix) &&
    cached.projectorPositionLocal.equals(projectorPositionLocal)
  )
    return;
  inpaintObjectMatrixInverseScratch.copy(object.matrixWorld).invert();
  inpaintAdjustedProjectorScratch
    .copy(projectorMatrix)
    .multiply(projectorObjectMatrix)
    .multiply(inpaintObjectMatrixInverseScratch);
  (material.uniforms.projectorMatrix.value as THREE.Matrix4).copy(inpaintAdjustedProjectorScratch);
  (material.uniforms.projectorPosition.value as THREE.Vector3)
    .copy(projectorPositionLocal)
    .applyMatrix4(object.matrixWorld);
  material.uniforms.projectionReady.value = 1;
  if (cached) {
    cached.objectMatrixWorld.copy(object.matrixWorld);
    cached.projectorMatrix.copy(projectorMatrix);
    cached.projectorObjectMatrix.copy(projectorObjectMatrix);
    cached.projectorPositionLocal.copy(projectorPositionLocal);
  } else {
    inpaintMaterialTransformCache.set(material, {
      objectMatrixWorld: object.matrixWorld.clone(),
      projectorMatrix: projectorMatrix.clone(),
      projectorObjectMatrix: projectorObjectMatrix.clone(),
      projectorPositionLocal: projectorPositionLocal.clone(),
    });
  }
}

function accumulateInpaintSnapshotToUv(
  renderer: THREE.WebGLRenderer,
  model: SurfacePaintTarget,
  snapshot: InpaintProjectionSource,
  target: THREE.WebGLRenderTarget,
  clear: boolean,
  operation: 'add' | 'subtract' = 'add',
) {
  const resources = getInpaintUvAccumulationResources(model, snapshot, target, operation);
  const { material } = resources;
  material.uniforms.maskMap.value = snapshot.texture;
  bindInpaintDepthTarget(material, snapshot.depthTarget);
  material.blendEquation = THREE.AddEquation;
  material.blendSrc = operation === 'add' ? THREE.OneFactor : THREE.ZeroFactor;
  material.blendDst = THREE.OneMinusSrcAlphaFactor;
  updateInpaintMaterialForObject(
    material,
    snapshot.projectorMatrix,
    snapshot.projectorObjectMatrix,
    snapshot.projectorPositionLocal,
    model.group,
  );
  if (resources.meshes.length === 0) throw new Error('模型没有可用于累计蒙版的 UV。');
  resources.meshes.forEach(({ source, bake }) => {
    source.updateWorldMatrix(true, false);
    bake.matrix.copy(source.matrixWorld);
  });
  const previousTarget = renderer.getRenderTarget();
  const previousAutoClear = renderer.autoClear;
  const previousClearColor = renderer.getClearColor(new THREE.Color()).clone();
  const previousClearAlpha = renderer.getClearAlpha();
  try {
    renderer.autoClear = false;
    renderer.setRenderTarget(target);
    if (clear) {
      renderer.setClearColor(0x000000, 0);
      renderer.clear(true, false, false);
    }
    renderer.render(resources.scene, new THREE.Camera());
  } finally {
    renderer.setRenderTarget(previousTarget);
    renderer.setClearColor(previousClearColor, previousClearAlpha);
    renderer.autoClear = previousAutoClear;
  }
}

function clearInpaintAccumulationTarget(
  renderer: THREE.WebGLRenderer,
  target: THREE.WebGLRenderTarget,
) {
  const previousTarget = renderer.getRenderTarget();
  const previousClearColor = renderer.getClearColor(new THREE.Color()).clone();
  const previousClearAlpha = renderer.getClearAlpha();
  try {
    renderer.setRenderTarget(target);
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, false, false);
  } finally {
    renderer.setRenderTarget(previousTarget);
    renderer.setClearColor(previousClearColor, previousClearAlpha);
  }
}

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
  layer.accumulatedMaskMaterial.dispose();
  (layer.inpaintMaterialBindings ?? []).forEach(({ mesh, original, patched }) => {
    if (mesh.material === patched) mesh.material = original;
    (Array.isArray(patched) ? patched : [patched]).forEach(restoreInpaintPatchedMaterial);
  });
  layer.inpaintMaterialBindings = [];
  disposeInpaintUvAccumulationResources(layer.accumulatedMaskTarget);
  layer.accumulatedMaskTarget.dispose();
  layer.maskDepthTarget?.dispose();
  layer.inpaintSnapshots.forEach((snapshot) => {
    snapshot.overlayMeshes.forEach((mesh) => mesh.removeFromParent());
    snapshot.texture.dispose();
    snapshot.material.dispose();
    snapshot.depthTarget?.dispose();
  });
}

function createInpaintMaskCaptureMaterial(
  maskTexture: THREE.Texture,
  depthTarget?: THREE.WebGLRenderTarget,
  maskUsesUv = false,
) {
  const material = new THREE.ShaderMaterial({
    uniforms: {
      maskMap: { value: maskTexture },
      occlusionDepthMap: { value: null },
      occlusionDepthTexelSize: { value: new THREE.Vector2(1, 1) },
      occlusionDepthReady: { value: 0 },
      occlusionDepthEpsilon: { value: INPAINT_DEPTH_EPSILON },
      projectorMatrix: { value: new THREE.Matrix4() },
      projectorPosition: { value: new THREE.Vector3() },
      projectionReady: { value: 1 },
      maskUsesUv: { value: maskUsesUv ? 1 : 0 },
      maskInverted: { value: 0 },
    },
    vertexShader: `
      uniform mat4 projectorMatrix;
      uniform vec3 projectorPosition;
      varying vec4 vProjectedPosition;
      varying float vProjectorFacing;
      varying float vViewerFacing;
      varying vec2 vSurfaceUv;

      void main() {
        vec4 worldPosition = modelMatrix * vec4(position, 1.0);
        vec3 worldNormal = normalize(mat3(modelMatrix) * normal);
        vec3 projectorDirection = normalize(projectorPosition - worldPosition.xyz);
        vec3 viewerDirection = normalize(cameraPosition - worldPosition.xyz);
        vProjectedPosition = projectorMatrix * worldPosition;
        vProjectorFacing = dot(worldNormal, projectorDirection);
        vViewerFacing = dot(worldNormal, viewerDirection);
        vSurfaceUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform sampler2D maskMap;
      uniform float maskUsesUv;
      uniform float maskInverted;
      varying vec4 vProjectedPosition;
      varying float vProjectorFacing;
      varying float vViewerFacing;
      varying vec2 vSurfaceUv;
      ${inpaintDepthShader}

      void main() {
        vec2 maskUv;
        if (maskUsesUv > 0.5) {
          maskUv = vSurfaceUv;
        } else {
          if (
            vProjectedPosition.w <= 0.0001 ||
            vProjectorFacing * vViewerFacing < 0.0
          ) discard;
          vec3 ndc = vProjectedPosition.xyz / vProjectedPosition.w;
          if (abs(ndc.x) > 1.0 || abs(ndc.y) > 1.0 || abs(ndc.z) > 1.0) discard;
          vec2 projectorUv = ndc.xy * 0.5 + 0.5;
          if (!isProjectorSurfaceVisible(projectorUv, ndc.z * 0.5 + 0.5)) discard;
          maskUv = projectorUv;
          maskUv.y = 1.0 - maskUv.y;
        }
        vec4 maskTexel = texture2D(maskMap, maskUv);
        float coverage = maskUsesUv > 0.5
          ? (vViewerFacing >= 0.0 ? maskTexel.r : maskTexel.g)
          : max(maskTexel.r, max(maskTexel.g, maskTexel.b)) * maskTexel.a;
        if (maskInverted > 0.5) coverage = 1.0 - coverage;
        if (coverage <= 0.01) discard;
        gl_FragColor = vec4(1.0, 1.0, 1.0, coverage);
      }
    `,
    transparent: true,
    depthWrite: true,
    depthTest: true,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
  bindInpaintDepthTarget(material, depthTarget);
  return material;
}

function hasCanvasAlpha(canvas: HTMLCanvasElement, context: CanvasRenderingContext2D) {
  const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
  for (let index = 3; index < data.length; index += 4) {
    if (data[index] > 0) return true;
  }
  return false;
}

async function projectionMaskToDataUrl(source: HTMLCanvasElement) {
  try {
    const startedAt = performance.now();
    const result = await encodeProjectionMaskInWorker(source);
    document.body.dataset.localRepaintProjectionMaskEncodeBackend = 'worker';
    document.body.dataset.localRepaintProjectionMaskEncodeWorkerMs = result.processMs.toFixed(1);
    document.body.dataset.localRepaintProjectionMaskEncodeTotalMs = (
      performance.now() - startedAt
    ).toFixed(1);
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () =>
        typeof reader.result === 'string'
          ? resolve(reader.result)
          : reject(new Error('Could not read encoded local repaint mask.'));
      reader.onerror = () =>
        reject(reader.error ?? new Error('Could not read encoded local repaint mask.'));
      reader.readAsDataURL(result.blob);
    });
  } catch (workerError) {
    document.body.dataset.localRepaintProjectionMaskEncodeBackend = 'main-thread-fallback';
    console.warn(
      '[Liclick 3D Texture] Projection mask Worker unavailable; using compatible encoder.',
      workerError,
    );
  }
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

const LOCAL_REPAINT_IMAGE_CACHE_LIMIT = 6;
const localRepaintImageElementCache = new Map<string, Promise<HTMLImageElement>>();

function loadImageElement(url: string) {
  const cached = localRepaintImageElementCache.get(url);
  if (cached) {
    localRepaintImageElementCache.delete(url);
    localRepaintImageElementCache.set(url, cached);
    return cached;
  }
  const pending = new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Could not load local repaint mask.'));
    image.src = url;
  });
  localRepaintImageElementCache.set(url, pending);
  while (localRepaintImageElementCache.size > LOCAL_REPAINT_IMAGE_CACHE_LIMIT) {
    const oldest = localRepaintImageElementCache.keys().next().value as string | undefined;
    if (!oldest) break;
    localRepaintImageElementCache.delete(oldest);
  }
  void pending.catch(() => {
    if (localRepaintImageElementCache.get(url) === pending) {
      localRepaintImageElementCache.delete(url);
    }
  });
  return pending;
}

function reportLocalRepaintPrewarmProgress(
  progress: number,
  detail: string,
  options: { done?: boolean; failed?: boolean } = {},
) {
  if (document.body.dataset.localRepaintPrewarmProgressRequested !== '1') return;
  window.dispatchEvent(
    new CustomEvent('liclick:local-repaint-prewarm-progress', {
      detail: {
        title: options.failed ? '局部重绘准备失败' : '正在准备局部重绘',
        detail,
        progress,
        done: options.done,
        dismissAfterMs: options.failed ? 4_000 : 450,
      },
    }),
  );
  if (options.done) delete document.body.dataset.localRepaintPrewarmProgressRequested;
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

function isEditableLocalRepaintProjectionLayer(layer?: Layer): layer is Layer {
  return Boolean(
    layer &&
      isLocalRepaintProjectionLayer(layer) &&
      layer.camera &&
      (layer.localRepaintSourceUrl || layer.imageUrl) &&
      (layer.localRepaintMaskUrl || layer.maskUrl),
  );
}

function isLocalRepaintSourceForLayer(
  source: LocalRepaintProjectionSource | undefined,
  layer: Layer | undefined,
) {
  if (!source || !isEditableLocalRepaintProjectionLayer(layer)) return false;
  if (source.targetLayerId !== layer.replacementTargetLayerId) return false;
  if (layer.generationId) return source.generationId === layer.generationId;
  if (layer.captureId) return source.captureId === layer.captureId;
  // imageUrl/maskUrl are resolved by the workspace loader. The dedicated
  // metadata fields can still contain project-relative paths in older saves.
  const sourceUrl = layer.imageUrl || layer.localRepaintSourceUrl;
  return source.imageUrl === sourceUrl || source.persistentImageUrl === sourceUrl;
}

function isLocalRepaintLayerEraserActive(
  paintTool: PaintToolMode,
  activeLayerId: string | undefined,
  layerId: string,
  layers: Layer[],
) {
  if (paintTool !== 'eraser' || activeLayerId !== layerId) return false;
  return isEditableLocalRepaintProjectionLayer(layers.find((layer) => layer.id === layerId));
}

function isLocalRepaintUvMergeLayer(layer: Layer, objectId?: string) {
  return (
    layer.type === 'uv' &&
    layer.id.startsWith(LOCAL_REPAINT_UV_MERGE_LAYER_ID_PREFIX) &&
    (!objectId || !layer.objectId || layer.objectId === objectId)
  );
}

function isMatchingLocalRepaintUvMergeLayer(
  layer: Layer,
  source: LocalRepaintProjectionSource,
  objectId: string,
) {
  return Boolean(
    source.targetLayerId &&
    layer.id === source.targetLayerId &&
    layer.type === 'uv' &&
    (!layer.objectId || layer.objectId === (source.objectId ?? objectId)),
  );
}

function isMatchingLocalRepaintProjectionLayer(
  layer: Layer,
  source: LocalRepaintProjectionSource,
  objectId: string,
) {
  if (!isLocalRepaintProjectionLayer(layer)) return false;
  if (source.generationId) {
    return (
      layer.generationId === source.generationId &&
      (!source.targetLayerId || layer.replacementTargetLayerId === source.targetLayerId)
    );
  }
  if (source.captureId) {
    return (
      layer.captureId === source.captureId &&
      (!source.targetLayerId || layer.replacementTargetLayerId === source.targetLayerId)
    );
  }
  if (source.targetLayerId) return layer.replacementTargetLayerId === source.targetLayerId;
  return !layer.objectId || layer.objectId === (source.objectId ?? objectId);
}

function createLocalRepaintComposite(
  sourceKey: string,
  layerId: string,
  width: number,
  height: number,
  allowedMaskImage?: HTMLImageElement,
  preparedFalloffCanvas?: HTMLCanvasElement,
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
    falloffCanvas:
      preparedFalloffCanvas ?? createLocalRepaintFalloffCanvas(allowedMaskImage, width, height),
    worldToSourceClip: new THREE.Matrix4(),
    objectMatrixDelta: new THREE.Matrix4(),
    objectNormalDelta: new THREE.Matrix3(),
    projectorViewMatrix: new THREE.Matrix4(),
    projectorViewNormalMatrix: new THREE.Matrix3(),
    restoredMaskReady: true,
    hasContent: false,
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
  // A world-space circle can approach the source camera's projection horizon
  // on a grazing triangle. The finite-difference points still land inside the
  // source frame, but their UV delta can be tens of times larger than the
  // requested cursor. One short click then clears a broad source-image region
  // shared by several material pieces. Bound each projected radius to the
  // cursor scale (with perspective headroom) so a numerical/grazing outlier can
  // never turn a dot into a model-wide erase.
  const fallbackUvRadius = Math.max(1, fallbackRadius) / UV_PAINT_RESOLUTION;
  const maximumProjectedRadius = Math.min(
    0.25,
    Math.max(fallbackUvRadius, fallbackUvRadius * 4),
  );
  const fallbackBrush = createCircularBrushTransform(fallbackRadius);
  const clampProjectedAxis = (axis: THREE.Vector2, fallbackAxis: THREE.Vector2) => {
    const length = axis.length();
    if (!Number.isFinite(length) || length < 1e-10) {
      axis.copy(fallbackAxis);
      return;
    }
    if (length > maximumProjectedRadius) {
      axis.multiplyScalar(maximumProjectedRadius / length);
    }
  };
  clampProjectedAxis(axisX, fallbackBrush.axisX);
  clampProjectedAxis(axisY, fallbackBrush.axisY);
  return { axisX, axisY };
}

function mergeLocalRepaintScratchPatch(
  composite: LocalRepaintCompositeState,
  dirtyRect: PaintDirtyRect,
  operation: 'apply' | 'erase' = 'apply',
) {
  const x = Math.max(0, Math.floor(dirtyRect.x));
  const y = Math.max(0, Math.floor(dirtyRect.y));
  const right = Math.min(composite.maskCanvas.width, Math.ceil(dirtyRect.x + dirtyRect.width));
  const bottom = Math.min(composite.maskCanvas.height, Math.ceil(dirtyRect.y + dirtyRect.height));
  const width = Math.max(1, right - x);
  const height = Math.max(1, bottom - y);

  if (operation === 'apply') {
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
  }

  composite.maskContext.save();
  composite.maskContext.globalCompositeOperation =
    operation === 'erase' ? 'destination-out' : 'lighten';
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

function beginLiveEraserPreview(layer: UvPaintLayer, root?: THREE.Object3D) {
  // A local-repaint result is stored as a UV image. Its source image may still
  // be decoding (or its registered live canvas may temporarily be the 1x1
  // bootstrap surface). Publishing that canvas as a full UV replacement makes
  // the whole model flash white while the pointer is down. UV edits are still
  // committed at stroke end; only the unsafe transient replacement is skipped.
  if (layer.target === 'uv-image') {
    endLiveEraserPreview(layer);
    return false;
  }
  // Projected layers use a separate all-white keep-mask that is multiplied
  // over the original projection mask in the shader.
  const sourceWidth = layer.paintDefaultResolution;
  const sourceHeight = layer.paintDefaultResolution;
  const scale = UV_STROKE_PREVIEW_RESOLUTION / Math.max(sourceWidth, sourceHeight, 1);
  const width = Math.max(1, Math.round(sourceWidth * scale));
  const height = Math.max(1, Math.round(sourceHeight * scale));
  const sizeChanged =
    layer.liveResultCanvas.width !== width || layer.liveResultCanvas.height !== height;
  if (sizeChanged) {
    layer.liveResultCanvas.width = width;
    layer.liveResultCanvas.height = height;
    layer.liveEraserPreviewInitialized = false;
  }
  // Keep this multiplier cumulative across consecutive strokes. Clearing it to
  // white on every pointer-down temporarily restored all earlier erasures while
  // the committed canvas/material update was still being published, so the
  // previous stroke appeared to disappear until the asynchronous rebuild caught
  // up. Reusing the same mask makes every new stroke start from the pixels the
  // user can already see; multiplying an already-erased pixel by zero again is
  // idempotent once the persistent layer has caught up.
  if (!layer.liveEraserPreviewInitialized) {
    layer.liveResultContext.clearRect(0, 0, width, height);
    layer.liveResultContext.fillStyle = '#ffffff';
    layer.liveResultContext.fillRect(0, 0, width, height);
    layer.liveEraserPreviewInitialized = true;
  }
  layer.liveEraserPreviewActive = true;
  markLiveProjectedCanvasTextureUpdated(layer.liveResultUrl);
  publishLiveSurfacePaintPreview({
    objectId: layer.objectId,
    layerId: layer.layerId,
    target: layer.target === 'projected-mask' ? 'projected-mask' : 'uv-image',
    assetUrl: layer.liveResultUrl,
    composition: layer.target === 'projected-mask' ? 'multiply-original-mask' : 'replace',
  });
  // React subscribers intentionally run outside the high-frequency input
  // path. Patch the already-resident shader now so switching a layer and
  // immediately pressing the pointer cannot lose or defer the first segment.
  if (root) {
    syncProjectedLayerLiveEraserPreviewInObject(root, layer.layerId, layer.liveResultTexture);
  }
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
  const { gl, camera, scene, invalidate } = useThree();
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
  const strokePaintToolRef = useRef<SurfaceStrokePaintTool>();
  const lastPaintActivityAtRef = useRef(0);
  const strokeTelemetryRef = useRef<StrokeTelemetrySnapshot & { startedAt: number }>();
  const eraserStrokeStartedAtRef = useRef<number>();
  const eraserStrokeToolRef = useRef<SurfaceStrokePaintTool>();
  const activePaintLayerChangedAtRef = useRef(performance.now());
  const previousActivePaintLayerIdRef = useRef<string>();
  const strokeDraftRef = useRef<PaintStrokeDraft>();
  const dirtyTexturesRef = useRef(new Set<THREE.CanvasTexture>());
  const textureUpdateFrameRef = useRef<number>();
  const projectionTextureUpdateTimerRef = useRef<number>();
  const projectionTextureLastUpdateAtRef = useRef(0);
  const projectedEraserBatchesRef = useRef(new Map<string, PendingProjectedEraserBatch>());
  const pointerListenerGenerationRef = useRef(0);
  const localRepaintUvCommitRevisionRef = useRef(0);
  const localRepaintUvCommitChainRef = useRef(Promise.resolve());
  const localRepaintProjectedPublishRequestRef = useRef<() => Promise<void>>();
  const localRepaintProjectedPublishPumpRef = useRef<Promise<void>>();
  const localRepaintLastCommitReportRef = useRef<LocalRepaintUvCommitReport>();
  const localRepaintUvScheduleFrameRef = useRef<number>();
  const localRepaintHandoffFrameRef = useRef<number>();
  const inpaintMaskPrewarmResourceKeyRef = useRef<string>();
  const inpaintDepthCaptureTimerRef = useRef<number>();
  const inpaintDepthCaptureFrameRef = useRef<number>();
  const paintPreviewRevisionRef = useRef(0);
  const maskDirtyRef = useRef(false);
  const maskHasContentRef = useRef(false);
  const currentProjectionHasContentRef = useRef(false);
  const currentProjectionOperationRef = useRef<'add' | 'subtract'>('add');
  const inpaintArchiveTimerRef = useRef<number>();
  const inpaintArchiveIdleRef = useRef<number>();
  const inpaintLastCameraRef = useRef({
    position: camera.position.clone(),
    quaternion: camera.quaternion.clone(),
    zoom: camera.zoom,
  });
  const paintMaskCommitRevisionRef = useRef(0);
  const paintMaskContentPublishedRef = useRef(false);
  const handledPaintMaskInvertRevisionRef = useRef(0);
  const localRepaintSourceImageRef = useRef<{
    url: string;
    allowedMaskUrl: string;
    image: HTMLImageElement;
    liveSource: HTMLImageElement | ImageBitmap;
    previewImageUrl: string;
    allowedMaskImage?: HTMLImageElement;
    falloffCanvas?: HTMLCanvasElement;
  }>();
  const [localRepaintAssetsRevision, setLocalRepaintAssetsRevision] = useState(0);
  const localRepaintCompositeRef = useRef<LocalRepaintCompositeState>();
  const localRepaintGpuOverlayRef = useRef<LocalRepaintGpuOverlayState>();
  const localRepaintRuntimeDepthRef = useRef<{
    sourceKey: string;
    depthUrl: string;
    normalUrl: string;
  }>();
  const viewportLayerStressRunningRef = useRef(false);
  const inpaintDepthMaterial = useMemo(() => {
    const material = new THREE.MeshDepthMaterial({
      depthPacking: THREE.BasicDepthPacking,
      side: THREE.DoubleSide,
    });
    material.colorWrite = false;
    material.depthTest = true;
    material.depthWrite = true;
    return material;
  }, []);
  const liveInpaintScreenPreview = useMemo(() => createLiveInpaintScreenPreview(), []);
  useEffect(() => {
    scene.add(liveInpaintScreenPreview.mesh);
    return () => {
      liveInpaintScreenPreview.mesh.removeFromParent();
      liveInpaintScreenPreview.mesh.geometry.dispose();
      liveInpaintScreenPreview.material.dispose();
    };
  }, [liveInpaintScreenPreview, scene]);
  const clearLocalRepaintGpuOverlay = useCallback(() => {
    disposeLocalRepaintGpuOverlay(localRepaintGpuOverlayRef.current);
    localRepaintGpuOverlayRef.current = undefined;
    delete document.body.dataset.localRepaintOverlayReady;
    delete document.body.dataset.localRepaintOverlayVisible;
    delete document.body.dataset.localRepaintOverlayCompileDurationMs;
    // The canvas uses demand rendering. Removing a coplanar overlay without an
    // explicit invalidation can leave the last z-fighting frame on screen until
    // the next camera move or eye toggle.
    invalidate();
  }, [invalidate]);
  const paintTool = useSceneStore((state) => state.paintTool);
  const displayMode = useSceneStore((state) => state.displayMode);
  const paintMaskResetRevision = useSceneStore((state) => state.paintMaskResetRevision);
  const paintMaskInvertRevision = useSceneStore((state) => state.paintMaskInvertRevision);
  const paintMaskHasContent = useSceneStore((state) => state.paintMaskHasContent);
  const paintMaskSettings = useSceneStore((state) => state.paintMaskSettings);
  const localRepaintBrushSettings = useSceneStore((state) => state.localRepaintBrushSettings);
  const paintToolSettings = useSceneStore((state) => state.paintToolSettings);
  const textureResolutionSetting = useSettingsStore((state) => state.resolution);
  const localRepaintProjectionSource = useSceneStore((state) => state.localRepaintProjectionSource);
  const setPaintMaskDataUrl = useSceneStore((state) => state.setPaintMaskDataUrl);
  const setPaintMaskCapture = useSceneStore((state) => state.setPaintMaskCapture);
  const setOrbitControlsEnabled = useSceneStore((state) => state.setOrbitControlsEnabled);
  const importedModel = useSceneStore((state) => state.importedModel);
  const selectedObjectId = useSceneStore((state) => state.selectedObjectId);
  const activePaintLayer = useLayerStore((state) =>
    state.layers.find((layer) => layer.id === state.activeProjectedLayerId),
  );
  const activePaintLayerId = activePaintLayer?.id;

  useEffect(() => {
    const previousLayerId = previousActivePaintLayerIdRef.current;
    if (previousLayerId === activePaintLayerId) return;
    activePaintLayerChangedAtRef.current = performance.now();
    previousActivePaintLayerIdRef.current = activePaintLayerId;
    markEraserPerformanceEvent('active-layer-change', {
      previousLayerId,
      activeLayerId: activePaintLayerId,
      layerType: activePaintLayer?.type,
      layerRole: activePaintLayer?.role,
    });
  }, [activePaintLayer?.role, activePaintLayer?.type, activePaintLayerId]);
  const pushToast = useToastStore((state) => state.pushToast);
  const showPanel = useWorkspaceLayoutStore((state) => state.showPanel);
  const setPanelCollapsed = useWorkspaceLayoutStore((state) => state.setPanelCollapsed);
  const t = useT();
  const isInpaintMode = paintTool === 'inpaint-add' || paintTool === 'inpaint-subtract';
  const isEditingPersistedLocalRepaint =
    paintTool === 'eraser' && isEditableLocalRepaintProjectionLayer(activePaintLayer);
  const isLocalRepaintApplyMode = paintTool === 'inpaint-apply' || isEditingPersistedLocalRepaint;
  const shouldPrewarmPersistedLocalRepaint =
    isEditableLocalRepaintProjectionLayer(activePaintLayer) &&
    (paintTool === 'none' || isEditingPersistedLocalRepaint);

  useEffect(() => {
    if (!shouldPrewarmPersistedLocalRepaint && paintTool !== 'inpaint-apply') return;
    // Building the radial-gradient stamp is cheap, but doing it on pointer-down
    // makes the very first accepted sample pay canvas allocation and raster work.
    // Keep the current feather preset resident alongside the GPU edit resources.
    getFeatheredBrushStamp(localRepaintBrushSettings.brushFeather);
  }, [
    localRepaintBrushSettings.brushFeather,
    paintTool,
    shouldPrewarmPersistedLocalRepaint,
  ]);

  useEffect(() => {
    if (paintTool !== 'eraser') return;
    // Keep the selected eraser falloff raster resident so the first dot does
    // not allocate and paint a gradient canvas on the pointer-down frame.
    getFeatheredBrushStamp(paintToolSettings.eraserFeather ?? 50);
  }, [paintTool, paintToolSettings.eraserFeather]);

  useEffect(() => {
    if (!shouldPrewarmPersistedLocalRepaint || !activePaintLayer?.camera) return;
    const projectionCamera = activePaintLayer.camera;
    const sourceUrl = activePaintLayer.imageUrl || activePaintLayer.localRepaintSourceUrl;
    const savedMaskUrl = activePaintLayer.maskUrl || activePaintLayer.localRepaintMaskUrl;
    if (!sourceUrl || !savedMaskUrl) return;

    const currentSource = useSceneStore.getState().localRepaintProjectionSource;
    const targetLayerId = activePaintLayer.replacementTargetLayerId;
    if (isLocalRepaintSourceForLayer(currentSource, activePaintLayer)) return;

    let cancelled = false;
    const restoreSource = async () => {
      const liveMaskCanvas = getLiveProjectedCanvasState(savedMaskUrl)?.canvas;
      const allowedMaskUrl = liveMaskCanvas
        ? await canvasToPngDataUrl(liveMaskCanvas)
        : savedMaskUrl;
      if (cancelled) return;
      const layerState = useLayerStore.getState();
      if (layerState.activeProjectedLayerId !== activePaintLayer.id) return;
      const currentPaintTool = useSceneStore.getState().paintTool;
      if (currentPaintTool !== 'none' && currentPaintTool !== 'eraser') return;
      const targetLayer = layerState.layers.find((layer) => layer.id === targetLayerId);
      useSceneStore.getState().setLocalRepaintProjectionSource({
        imageUrl: sourceUrl,
        persistentImageUrl: sourceUrl,
        autoActivate: false,
        allowedMaskUrl,
        depthUrl: activePaintLayer.depthUrl,
        depthEncoding: activePaintLayer.depthEncoding,
        normalUrl: activePaintLayer.normalUrl,
        objectId: activePaintLayer.objectId,
        objectMatrixWorld: activePaintLayer.objectMatrixWorld,
        camera: projectionCamera,
        generationId: activePaintLayer.generationId,
        captureId: activePaintLayer.captureId,
        name: activePaintLayer.name,
        targetLayerId,
        targetLayerType:
          targetLayer?.type === 'uv' || targetLayer?.type === 'projected'
            ? targetLayer.type
            : undefined,
        targetLayerName: targetLayer?.name,
      });
    };
    void restoreSource().catch((error) => {
      console.warn('[Liclick 3D Texture] Could not restore local repaint editing source:', error);
    });
    return () => {
      cancelled = true;
    };
  }, [activePaintLayer, shouldPrewarmPersistedLocalRepaint]);
  const shouldShowColorPaintOverlays = isLocalRepaintOverlayVisible(displayMode, true);
  const shouldShowInpaintMask =
    shouldShowColorPaintOverlays &&
    (isInpaintMode || (paintTool === 'none' && paintMaskHasContent));
  const readShouldShowInpaintMask = useCallback(() => {
    const state = useSceneStore.getState();
    const inpaintMode = state.paintTool === 'inpaint-add' || state.paintTool === 'inpaint-subtract';
    return (
      isLocalRepaintOverlayVisible(state.displayMode, true) &&
      (inpaintMode || (state.paintTool === 'none' && state.paintMaskHasContent))
    );
  }, []);
  const deactivateLiveInpaintScreenPreview = useCallback(
    (layer?: UvPaintLayer, restoreGeometryPreview = false) => {
      liveInpaintScreenPreview.mesh.visible = false;
      liveInpaintScreenPreview.material.uniforms.previewReady.value = 0;
      if (!restoreGeometryPreview || !layer) return;
      const shouldShow = readShouldShowInpaintMask();
      layer.accumulatedMaskOverlays.forEach((overlay) => {
        const parent = overlay.parent;
        overlay.visible =
          parent instanceof THREE.Mesh &&
          !layer.directMaskReadyMeshes.has(parent) &&
          shouldRenderInpaintMaskOnMesh(layer, parent) &&
          shouldShow &&
          (layer.accumulatedMaskReady || currentProjectionHasContentRef.current);
      });
    },
    [liveInpaintScreenPreview, readShouldShowInpaintMask],
  );
  const hideInpaintMaskPresentation = useCallback(
    (layer?: UvPaintLayer) => {
      deactivateLiveInpaintScreenPreview();
      if (!layer) return;
      layer.overlayMeshes.forEach((overlay) => {
        if (overlay.userData.liclickInpaintMaskOverlay) overlay.visible = false;
      });
      layer.accumulatedMaskOverlays.forEach((overlay) => {
        overlay.visible = false;
      });
      layer.inpaintSnapshots.forEach((snapshot) => {
        snapshot.overlayMeshes.forEach((overlay) => {
          overlay.visible = false;
        });
      });
    },
    [deactivateLiveInpaintScreenPreview],
  );
  const activateLiveInpaintScreenPreview = useCallback(
    (layer: UvPaintLayer) => {
      if (
        layer.accumulatedMaskReady ||
        layer.maskInverted ||
        !layer.maskDepthReady ||
        !layer.maskDepthTarget?.depthTexture ||
        hasInpaintProjectionCameraChanged(layer, camera)
      ) {
        deactivateLiveInpaintScreenPreview();
        return false;
      }
      const uniforms = liveInpaintScreenPreview.material.uniforms;
      const shouldShow = readShouldShowInpaintMask();
      if (
        uniforms.previewReady.value > 0.5 &&
        uniforms.maskMap.value === layer.projectionTexture &&
        uniforms.surfaceDepthMap.value === layer.maskDepthTarget.depthTexture
      ) {
        liveInpaintScreenPreview.mesh.visible = shouldShow;
        return shouldShow;
      }
      uniforms.maskMap.value = layer.projectionTexture;
      uniforms.surfaceDepthMap.value = layer.maskDepthTarget.depthTexture;
      uniforms.previewReady.value = 1;
      liveInpaintScreenPreview.mesh.visible = shouldShow;
      layer.accumulatedMaskOverlays.forEach((overlay) => {
        overlay.visible = false;
      });
      return liveInpaintScreenPreview.mesh.visible;
    },
    [
      camera,
      deactivateLiveInpaintScreenPreview,
      liveInpaintScreenPreview,
      readShouldShowInpaintMask,
    ],
  );
  const enabled =
    paintTool === 'brush' || paintTool === 'eraser' || isInpaintMode || isLocalRepaintApplyMode;
  const texturePaintReady = Boolean(importedModel || selectedObjectId);
  const canUseSurfacePaint = Boolean(
    texturePaintReady &&
    activePaintLayer &&
    (paintTool === 'brush'
      ? activePaintLayer.type === 'uv'
      : paintTool === 'eraser'
        ? activePaintLayer.type === 'projected' ||
          activePaintLayer.role === 'local-repaint-overlay'
        : true),
  );

  const runViewportLayerStressScenario =
    useCallback(async (): Promise<ViewportLayerStressResult> => {
      if (viewportLayerStressRunningRef.current) {
        throw new Error('已有性能压测正在运行。');
      }
      const layerState = useLayerStore.getState();
      const sceneState = useSceneStore.getState();
      const settingsState = useSettingsStore.getState();
      const originalLayers = layerState.layers;
      const originalActiveLayerId = layerState.activeProjectedLayerId;
      const originalDisplayMode = sceneState.displayMode;
      const originalLighting = {
        exposure: settingsState.exposure,
        pbrEnvironmentIntensity: settingsState.pbrEnvironmentIntensity,
        pbrKeyLightIntensity: settingsState.pbrKeyLightIntensity,
        pbrLightAzimuth: settingsState.pbrLightAzimuth,
        environmentPreset: settingsState.environmentPreset,
      };
      const selectedObjectId = sceneState.selectedObjectId;
      const ordinaryTargets = originalLayers.filter(
        (layer) =>
          Boolean(layer.imageUrl) &&
          (!selectedObjectId || !layer.objectId || layer.objectId === selectedObjectId),
      );
      // The renderer-owned local repaint overlay can be controlled by a draft
      // row whose image lives in the live texture registry instead of
      // `layer.imageUrl`. Include that eye row explicitly; otherwise the S7
      // "all off" step leaves the overlay enabled and fails to reproduce the
      // user's actual panel workflow.
      const overlayVisibilityLayerId = localRepaintGpuOverlayRef.current?.visibilityLayerId;
      const overlayVisibilityLayer = overlayVisibilityLayerId
        ? originalLayers.find((layer) => layer.id === overlayVisibilityLayerId)
        : undefined;
      const targets =
        overlayVisibilityLayer &&
        !ordinaryTargets.some((layer) => layer.id === overlayVisibilityLayer.id)
          ? [...ordinaryTargets, overlayVisibilityLayer]
          : ordinaryTargets;
      if (targets.length === 0) throw new Error('当前对象没有可切换的纹理图层。');

      const targetIds = targets.map((layer) => layer.id);
      document.body.dataset.perfViewportStressLayerDetails = JSON.stringify(
        targets.map((layer) => ({
          id: layer.id,
          name: layer.name,
          type: layer.type,
          role: layer.role,
          generationId: layer.generationId,
          contentRevision: layer.contentRevision,
          visible: layer.visible,
        })),
      );
      const waitForFrame = () =>
        new Promise<number>((resolve) => window.requestAnimationFrame(resolve));
      const wait = (durationMs: number) =>
        new Promise<void>((resolve) => window.setTimeout(resolve, durationMs));
      const waitForProjectedResidentReady = async (timeoutMs = 20_000) => {
        const deadline = performance.now() + timeoutMs;
        // S7 validates resident eye-state uniforms. Starting the interaction
        // window while the cold bootstrap material is still presented both
        // reports false visibility failures and makes `isViewportInteractionBusy`
        // pause the authoritative texture-array upload indefinitely.
        await waitForFrame();
        await waitForFrame();
        while (performance.now() < deadline) {
          let selectedModelHasResidentMaterial = false;
          for (const model of useSceneStore.getState().importedModels) {
            if (selectedObjectId && model.objectId !== selectedObjectId) continue;
            model.group.traverse((child) => {
              if (selectedModelHasResidentMaterial || !(child instanceof THREE.Mesh)) return;
              const materials = Array.isArray(child.material) ? child.material : [child.material];
              selectedModelHasResidentMaterial = materials.some(
                (material) =>
                  material instanceof THREE.ShaderMaterial &&
                  Boolean(material.userData.liclickProjectedLayerStackState) &&
                  !material.userData.liclickLiveLocalRepaintOverlayMaterial,
              );
            });
          }
          const pipelineIdle = document.body.dataset.projectedArrayPipelineStatus !== 'building';
          const finalMaterialReady = document.body.dataset.textureRestoreProjectedReady === '1';
          const uvCombinationsReady = document.body.dataset.residentUvCombinationReady !== '0';
          const uvToggleTexturesReady = document.body.dataset.residentUvToggleReady !== '0';
          const wireframeReady = document.body.dataset.topologyWireframeReady !== '0';
          if (
            pipelineIdle &&
            finalMaterialReady &&
            uvCombinationsReady &&
            uvToggleTexturesReady &&
            wireframeReady &&
            selectedModelHasResidentMaterial
          )
            return;
          await waitForFrame();
        }
        throw new Error('完整投影材质预热超时，S7 未开始，避免使用临时白膜结果。');
      };
      const modeMismatchDetails: string[] = [];
      const modeMaterialSnapshots: Array<{
        phase: string;
        materials: Array<{
          name: string;
          type: string;
          projected: boolean;
          normal?: number;
          wire?: number;
          liveOverlay?: boolean;
        }>;
      }> = [];
      const overlayMismatchDetails: Array<{
        phase: string;
        actual?: string;
        expected: '0' | '1';
        visibilityLayerId?: string;
        visibilityLayerPresent: boolean;
        visibilityLayerVisible?: boolean;
        includedInTargets: boolean;
      }> = [];
      const recordOverlayMismatch = (expected: '0' | '1', actual?: string) => {
        const visibilityLayerId = localRepaintGpuOverlayRef.current?.visibilityLayerId;
        const visibilityLayer = visibilityLayerId
          ? useLayerStore.getState().layers.find((layer) => layer.id === visibilityLayerId)
          : undefined;
        overlayMismatchDetails.push({
          phase: document.body.dataset.perfViewportStressPhase ?? 'unknown',
          actual,
          expected,
          visibilityLayerId,
          visibilityLayerPresent: Boolean(visibilityLayer),
          visibilityLayerVisible: visibilityLayer?.visible,
          includedInTargets: Boolean(visibilityLayerId && targetIds.includes(visibilityLayerId)),
        });
      };
      const inspectModeState = (
        expectedMode: 'pbr' | 'flat' | 'normal' | 'wire',
        expectedSurfaceColor?: boolean,
      ) => {
        let mismatches = 0;
        const phase = document.body.dataset.perfViewportStressPhase ?? 'unknown';
        const phaseMaterials = new Map<
          string,
          {
            name: string;
            type: string;
            projected: boolean;
            normal?: number;
            wire?: number;
            liveOverlay?: boolean;
          }
        >();
        const visitedMaterials = new Set<THREE.Material>();
        for (const model of useSceneStore.getState().importedModels) {
          // Layer/display controls are scoped to the active object. Other
          // imported models intentionally keep their neutral preview material,
          // so including them here turns a valid selected-model transition into
          // hundreds of false missing-colour/normal/wire reports.
          if (selectedObjectId && model.objectId !== selectedObjectId) continue;
          let modelUsesSurfaceColorMaterial = false;
          const surfaceColorSources = new Set<string>();
          let modelUsesNormalMaterial = false;
          let modelUsesWireMaterial = false;
          model.group.traverse((child) => {
            if (!(child instanceof THREE.Mesh)) return;
            const materials = Array.isArray(child.material) ? child.material : [child.material];
            for (const material of materials) {
              if (phase.endsWith('-mode')) {
                const key = `${material.type}:${material.name}`;
                phaseMaterials.set(key, {
                  name: material.name,
                  type: material.type,
                  projected: Boolean(material.userData.liclickProjectedLayerStackState),
                  normal: Number(
                    (material as THREE.ShaderMaterial).uniforms?.normalPreviewEnabled?.value,
                  ),
                  wire: Number(
                    (material as THREE.ShaderMaterial).uniforms?.wirePreviewEnabled?.value,
                  ),
                  liveOverlay: Boolean(material.userData.liclickLiveLocalRepaintOverlayMaterial),
                });
              }
              if (material instanceof THREE.MeshNormalMaterial) {
                modelUsesNormalMaterial = true;
              }
              if (material.name === 'LiclickWirePreview') {
                modelUsesWireMaterial = true;
              }
              if (visitedMaterials.has(material)) continue;
              visitedMaterials.add(material);
              if (!(material instanceof THREE.ShaderMaterial)) continue;
              // The renderer-owned local repaint overlay deliberately does not
              // participate in normal/wire rendering. Its visibility is checked
              // separately below, so it must not be counted as a mode mismatch.
              if (material.userData.liclickLiveLocalRepaintOverlayMaterial) continue;
              const projectedState = material.userData.liclickProjectedLayerStackState as
                | {
                    bindings?: Array<{ layerId?: string; opacityUniform: string }>;
                  }
                | undefined;
              const hasProjectedContribution = Boolean(
                projectedState?.bindings?.some(
                  (binding) =>
                    Number(material.uniforms[binding.opacityUniform]?.value ?? 0) > 0.0001,
                ),
              );
              const hasResidentTextureContribution =
                (Number(material.uniforms.useUvOverlayMap?.value ?? 0) > 0 &&
                  Number(material.uniforms.uvOverlayOpacity?.value ?? 0) > 0.0001) ||
                (Number(material.uniforms.useTopUvOverlayMap?.value ?? 0) > 0 &&
                  Number(material.uniforms.topUvOverlayOpacity?.value ?? 0) > 0.0001) ||
                (Number(material.uniforms.useBaseMap?.value ?? 0) > 0 &&
                  Number(material.uniforms.baseTextureOpacity?.value ?? 0) > 0.0001);
              if (hasProjectedContribution || hasResidentTextureContribution) {
                modelUsesSurfaceColorMaterial = true;
                projectedState?.bindings?.forEach((binding) => {
                  if (Number(material.uniforms[binding.opacityUniform]?.value ?? 0) > 0.0001) {
                    surfaceColorSources.add(
                      `projected:${binding.layerId ?? binding.opacityUniform}`,
                    );
                  }
                });
                if (Number(material.uniforms.uvOverlayOpacity?.value ?? 0) > 0.0001)
                  surfaceColorSources.add('uv');
                if (Number(material.uniforms.topUvOverlayOpacity?.value ?? 0) > 0.0001)
                  surfaceColorSources.add('top-uv');
                if (Number(material.uniforms.baseTextureOpacity?.value ?? 0) > 0.0001)
                  surfaceColorSources.add('base');
              }
              if (material.uniforms.normalPreviewEnabled) {
                const normal = Number(material.uniforms.normalPreviewEnabled.value ?? 0) > 0.5;
                if (normal) modelUsesNormalMaterial = true;
                if (normal !== (expectedMode === 'normal')) mismatches += 1;
              }
              if (material.uniforms.wirePreviewEnabled) {
                const wire = Number(material.uniforms.wirePreviewEnabled.value ?? 0) > 0.5;
                if (wire) modelUsesWireMaterial = true;
                if (wire !== (expectedMode === 'wire')) mismatches += 1;
              }
            }
          });
          if (expectedMode === 'normal' && !modelUsesNormalMaterial) {
            mismatches += 1;
            if (modeMismatchDetails.length < 100)
              modeMismatchDetails.push(`${phase}:missing-normal-material`);
          }
          if (expectedMode === 'wire' && !modelUsesWireMaterial) {
            mismatches += 1;
            if (modeMismatchDetails.length < 100)
              modeMismatchDetails.push(`${phase}:missing-wire-material`);
          }
          if (
            expectedSurfaceColor !== undefined &&
            (expectedMode === 'pbr' || expectedMode === 'flat')
          ) {
            if (expectedSurfaceColor && !modelUsesSurfaceColorMaterial) {
              mismatches += 1;
              if (modeMismatchDetails.length < 100)
                modeMismatchDetails.push(
                  `${document.body.dataset.perfViewportStressPhase ?? 'unknown'}:missing-color`,
                );
            }
            if (!expectedSurfaceColor && modelUsesSurfaceColorMaterial) {
              mismatches += 1;
              if (modeMismatchDetails.length < 100)
                modeMismatchDetails.push(
                  `${document.body.dataset.perfViewportStressPhase ?? 'unknown'}:stale-color:${[
                    ...surfaceColorSources,
                  ].join(',')}`,
                );
            }
          }
        }
        if (
          expectedMode === 'wire' &&
          Number(document.body.dataset.topologyWireframeMeshCount ?? '0') <= 0
        )
          mismatches += 1;
        if (phase.endsWith('-mode')) {
          modeMaterialSnapshots.push({ phase, materials: [...phaseMaterials.values()] });
        }
        return mismatches;
      };

      // Establish one authoritative resident stack before reserving the frame
      // budget for the stress run. Eye toggles then update uniforms only and do
      // not depend on a cold background material build that interaction
      // throttling is designed to defer.
      useLayerStore.getState().setLayerVisibility(targetIds, true);
      try {
        await waitForProjectedResidentReady();
      } catch (error) {
        useLayerStore.getState().setLayers(originalLayers);
        if (originalActiveLayerId) useLayerStore.getState().setActiveLayer(originalActiveLayerId);
        throw error;
      }
      const modes = ['pbr', 'normal', 'wire', 'flat', 'wire', 'pbr'] as const;
      const startedAt = performance.now();
      const backgroundRevisionAtStart = Number(
        document.body.dataset.projectedMaterialBuildRevision ?? '0',
      );
      let operations = 0;
      let modeStateMismatches = 0;
      let overlayVisibilityMismatches = 0;
      viewportLayerStressRunningRef.current = true;
      document.body.dataset.perfAutoOrbit = '1';
      document.body.dataset.perfSimulatedViewportInteraction = '1';
      document.body.dataset.perfSuppressProjectLayerSync = '1';
      document.body.dataset.perfViewportStressPhase = 's7-viewport-layer-stress';
      const finishScenario = startPerformanceSpan(
        'interaction',
        's7-viewport-layer-stress-scenario',
        { layerCount: targetIds.length },
      );
      try {
        // The resident-stack preflight above may finish a deferred browser/GPU
        // task after the isolated sampler has started. Give that harness-only
        // completion its own phase and drain it before attributing frames to a
        // real mode, eye-toggle or orbit operation.
        document.body.dataset.perfViewportStressPhase = 's7-harness-settle';
        await waitForFrame();
        await waitForFrame();
        for (let cycle = 0; cycle < 2; cycle += 1) {
          for (const mode of modes) {
            document.body.dataset.perfViewportStressPhase = `s7-${mode}-mode`;
            useSceneStore.getState().setDisplayMode(mode);
            operations += 1;
            await waitForFrame();
            await waitForFrame();
            // The first normal-mode transition can publish on the third frame
            // after a cold projected shader restore. Keep the acceptance window
            // below 50ms at 60Hz while avoiding a false state error at frame 2.
            await waitForFrame();
            await waitForFrame();
            modeStateMismatches += inspectModeState(mode);

            document.body.dataset.perfViewportStressPhase = `s7-${mode}-all-off`;
            useLayerStore.getState().setLayerVisibility(targetIds, false);
            operations += targetIds.length;
            await waitForFrame();
            await waitForFrame();
            modeStateMismatches += inspectModeState(mode, false);
            const overlayHidden = document.body.dataset.localRepaintOverlayVisible;
            const overlayState = localRepaintGpuOverlayRef.current;
            if (overlayHidden === '1' && overlayState?.visibilityLayerSeen) {
              overlayVisibilityMismatches += 1;
              recordOverlayMismatch('0', overlayHidden);
            }

            for (const [targetIndex, id] of targetIds.entries()) {
              const targetLayer = targets.find((layer) => layer.id === id);
              // Local repaint is renderer-owned: it intentionally sits outside
              // the resident projected stack and has its own visibility probe.
              // Requiring the main stack to expose colour for this target alone
              // reports a false failure even when the overlay is correct.
              const expectsMainSurfaceColor =
                targetLayer && !isRendererOwnedLocalRepaintLayer(targetLayer) ? true : undefined;
              const targetKind = `${targetIndex}-${targetLayer?.type ?? 'unknown'}-${targetLayer?.role ?? 'normal'}`;
              document.body.dataset.perfViewportStressPhase = `s7-${mode}-${targetKind}-layer-on`;
              useLayerStore.getState().setLayerVisibility([id], true);
              operations += 1;
              await wait(12);
              await waitForFrame();
              await waitForFrame();
              modeStateMismatches += inspectModeState(mode, expectsMainSurfaceColor);
              document.body.dataset.perfViewportStressPhase = `s7-${mode}-${targetKind}-layer-off`;
              useLayerStore.getState().setLayerVisibility([id], false);
              operations += 1;
              await wait(12);
              await waitForFrame();
              await waitForFrame();
              modeStateMismatches += inspectModeState(mode, false);
            }

            document.body.dataset.perfViewportStressPhase = `s7-${mode}-all-on`;
            useLayerStore.getState().setLayerVisibility(targetIds, true);
            operations += targetIds.length;
            await waitForFrame();
            await waitForFrame();
            modeStateMismatches += inspectModeState(mode, true);
            const overlayVisible = document.body.dataset.localRepaintOverlayVisible;
            const overlayVisibilityLayerId = localRepaintGpuOverlayRef.current?.visibilityLayerId;
            const overlayVisibilityLayer = overlayVisibilityLayerId
              ? useLayerStore
                  .getState()
                  .layers.find((layer) => layer.id === overlayVisibilityLayerId)
              : undefined;
            const shouldValidateOverlay = Boolean(
              overlayVisibilityLayer || localRepaintGpuOverlayRef.current?.visibilityLayerSeen,
            );
            // An orphaned renderer overlay must remain hidden even in a colour
            // mode. Only an existing, visible eye row authorizes it to render.
            const expectedOverlayVisible =
              (mode === 'pbr' || mode === 'flat') && overlayVisibilityLayer?.visible ? '1' : '0';
            if (
              shouldValidateOverlay &&
              overlayVisible !== undefined &&
              overlayVisible !== expectedOverlayVisible
            ) {
              overlayVisibilityMismatches += 1;
              recordOverlayMismatch(expectedOverlayVisible, overlayVisible);
            }

            if (mode === 'pbr') {
              document.body.dataset.perfViewportStressPhase = 's7-pbr-lighting';
              // One stress step represents one lighting preset change. Publish
              // it atomically so subscribers render once instead of rebuilding
              // the same lighting state five times in a single interaction.
              useSettingsStore.setState({
                environmentPreset: cycle % 2 === 0 ? 'dark' : 'soft',
                exposure: cycle % 2 === 0 ? 0.72 : 1.28,
                pbrEnvironmentIntensity: cycle % 2 === 0 ? 0.2 : 0.82,
                pbrKeyLightIntensity: cycle % 2 === 0 ? 0.55 : 1.45,
                pbrLightAzimuth: cycle % 2 === 0 ? -120 : 135,
              });
              operations += 5;
              await waitForFrame();
              await waitForFrame();
            }
          }
        }
        const backgroundRevisionAtEnd = Number(
          document.body.dataset.projectedMaterialBuildRevision ?? '0',
        );
        const result: ViewportLayerStressResult = {
          operations,
          durationMs: performance.now() - startedAt,
          frameP95: 0,
          frameMax: 0,
          droppedFrames: 0,
          projectedBackgroundRebuilds: Math.max(
            0,
            backgroundRevisionAtEnd - backgroundRevisionAtStart,
          ),
          modeStateMismatches,
          overlayVisibilityMismatches,
        };
        document.body.dataset.perfViewportStressMismatchDetails =
          JSON.stringify(modeMismatchDetails);
        document.body.dataset.perfViewportStressOverlayMismatchDetails =
          JSON.stringify(overlayMismatchDetails);
        document.body.dataset.perfViewportStressModeMaterials =
          JSON.stringify(modeMaterialSnapshots);
        finishScenario(
          modeStateMismatches === 0 && overlayVisibilityMismatches === 0 ? 'end' : 'error',
          result,
        );
        return result;
      } catch (error) {
        finishScenario('error', {
          message: error instanceof Error ? error.message : String(error),
        });
        throw error;
      } finally {
        useLayerStore.getState().setLayers(originalLayers);
        if (originalActiveLayerId) useLayerStore.getState().setActiveLayer(originalActiveLayerId);
        useSceneStore.getState().setDisplayMode(originalDisplayMode);
        useSettingsStore.setState(originalLighting);
        delete document.body.dataset.perfAutoOrbit;
        delete document.body.dataset.perfSimulatedViewportInteraction;
        delete document.body.dataset.perfSuppressProjectLayerSync;
        delete document.body.dataset.perfViewportStressPhase;
        viewportLayerStressRunningRef.current = false;
      }
    }, []);

  useEffect(() => {
    const target = window as typeof window & {
      LiclickPerfViewportStress?: { run: () => Promise<ViewportLayerStressResult> };
    };
    target.LiclickPerfViewportStress = { run: runViewportLayerStressScenario };
    return () => {
      delete target.LiclickPerfViewportStress;
    };
  }, [runViewportLayerStressScenario]);

  useEffect(() => {
    // This renderer-owned overlay is intentionally excluded from SceneRoot's
    // ordinary projected-layer reconciliation. Subscribe to the stores here so
    // a mode switch updates its GPU uniforms synchronously, even if React is
    // busy or an asynchronous overlay build completes around the same frame.
    const syncOverlayDisplay = () => {
      const overlay = localRepaintGpuOverlayRef.current;
      if (!overlay) return;
      const sceneState = useSceneStore.getState();
      const settingsState = useSettingsStore.getState();
      const layerVisible = readLocalRepaintGpuOverlayLayerVisibility(overlay);
      const visibilityChanged = setLocalRepaintGpuOverlayVisibility(
        overlay,
        isLocalRepaintOverlayVisible(sceneState.displayMode, layerVisible),
      );
      const lightingChanged = syncLocalRepaintGpuOverlayLighting(
        overlay,
        getPreviewLighting({
          displayMode: sceneState.displayMode,
          environmentPreset: settingsState.environmentPreset,
          exposure: settingsState.exposure,
          pbrEnvironmentIntensity: settingsState.pbrEnvironmentIntensity,
          pbrKeyLightIntensity: settingsState.pbrKeyLightIntensity,
          pbrLightAzimuth: settingsState.pbrLightAzimuth,
        }),
      );
      if (visibilityChanged || lightingChanged) invalidate();
    };
    syncOverlayDisplay();
    const unsubscribeScene = useSceneStore.subscribe((state, previousState) => {
      if (state.displayMode !== previousState.displayMode) syncOverlayDisplay();
    });
    const unsubscribeSettings = useSettingsStore.subscribe((state, previousState) => {
      if (
        state.environmentPreset !== previousState.environmentPreset ||
        state.exposure !== previousState.exposure ||
        state.pbrEnvironmentIntensity !== previousState.pbrEnvironmentIntensity ||
        state.pbrKeyLightIntensity !== previousState.pbrKeyLightIntensity ||
        state.pbrLightAzimuth !== previousState.pbrLightAzimuth
      ) {
        syncOverlayDisplay();
      }
    });
    return () => {
      unsubscribeScene();
      unsubscribeSettings();
    };
  }, [invalidate]);

  useEffect(() => {
    // Eye state is store authority even when the renderer overlay was compiled
    // by an earlier task/HMR generation. A component-level subscription always
    // follows the current overlay ref, so no stale per-overlay closure can keep
    // pixels visible after its row is hidden.
    const syncVisibility = (layers = useLayerStore.getState().layers) => {
      const overlay = localRepaintGpuOverlayRef.current;
      if (!overlay) return;
      const layerVisible = readLocalRepaintGpuOverlayLayerVisibility(overlay, layers);
      if (
        setLocalRepaintGpuOverlayVisibility(
          overlay,
          isLocalRepaintOverlayVisible(useSceneStore.getState().displayMode, layerVisible),
        )
      ) {
        invalidate();
      }
    };
    syncVisibility();
    return useLayerStore.subscribe((state) => syncVisibility(state.layers));
  }, [invalidate]);

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
      ) {
        // Keep paint layers created by an older HMR generation compatible with
        // the per-mesh selection ownership guard.
        const needsAccumulatedMeshMigration = !layerRef.current.accumulatedMaskMeshes;
        layerRef.current.accumulatedMaskMeshes ??= new Set();
        layerRef.current.currentProjectionMeshes ??= new Set();
        if (needsAccumulatedMeshMigration && layerRef.current.accumulatedMaskReady) {
          getPaintableMeshes(model).forEach((mesh) =>
            layerRef.current?.accumulatedMaskMeshes.add(mesh),
          );
        }
        return layerRef.current;
      }
      deactivateLiveInpaintScreenPreview();
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
      // This canvas is uploaded to WebGL on every visible brush frame and is
      // only read at explicit capture/commit boundaries. Asking Chromium for a
      // CPU-backed willReadFrequently surface forced a CPU -> GPU copy per dot
      // and produced the repeatable 300-400ms high-frequency input spikes.
      const projection = createPaintCanvas(PROJECTION_PAINT_MAX_SIZE, false);
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
      const accumulatedMaskTarget = createInpaintAccumulationTarget();
      const accumulatedMaskMaterial = createAccumulatedInpaintMaskMaterial(
        accumulatedMaskTarget.texture,
      );
      accumulatedMaskMaterial.uniforms.liveMap.value = projectionTexture;

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
        liveEraserPreviewInitialized: false,
        paintOverlayTargets: new Set(),
        paintPreviewOverlays: [],
        projectionCanvas: projection.canvas,
        projectionContext: projection.context,
        projectionTexture,
        maskCanvas: mask.canvas,
        maskContext: mask.context,
        maskTexture,
        maskMaterial,
        accumulatedMaskMaterial,
        accumulatedMaskTarget,
        accumulatedMaskOverlays: [],
        accumulatedMaskReady: false,
        accumulatedMaskMeshes: new Set(),
        currentProjectionMeshes: new Set(),
        maskInverted: false,
        inpaintMaterialBindings: [],
        directMaskReadyMeshes: new Set(),
        maskProjectorMatrix: new THREE.Matrix4(),
        maskProjectorObjectMatrix: new THREE.Matrix4(),
        maskProjectorPositionLocal: new THREE.Vector3(),
        maskProjectionReady: false,
        maskDepthReady: false,
        inpaintSnapshots: [],
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
    [deactivateLiveInpaintScreenPreview, getPaintableMeshes, paintTool, textureResolutionSetting],
  );

  useLayoutEffect(() => {
    if (
      (paintTool !== 'brush' && paintTool !== 'eraser') ||
      !canUseSurfacePaint ||
      isEditingPersistedLocalRepaint
    ) {
      const previousLayer = layerRef.current;
      if (previousLayer?.liveEraserPreviewActive) endLiveEraserPreview(previousLayer);
      return;
    }
    const model = getTargetModel();
    if (!model) return;
    const prewarmStartedAt = performance.now();
    const layer = getUvPaintLayer(model);
    if (paintTool === 'eraser') {
      // Attach the neutral GPU multiplier as soon as the tool is selected.
      // Waiting for pointer-down made SceneRoot add the sampler and rebuild the
      // projected material inside the first stroke, which could expose the clay
      // material for one frame. The all-white multiplier is visually neutral,
      // so it is safe to prewarm before any pixels are erased.
      beginLiveEraserPreview(layer, model.group);
      invalidate();
      measureEraserPerformanceEvent('layer-eraser-prewarm', prewarmStartedAt, {
        activeLayerId: activePaintLayerId,
        target: layer.target,
        ready: layer.isReady,
      });
    } else if (layer.liveEraserPreviewActive) {
      endLiveEraserPreview(layer);
    }
  }, [
    activePaintLayerId,
    canUseSurfacePaint,
    getTargetModel,
    getUvPaintLayer,
    invalidate,
    isEditingPersistedLocalRepaint,
    paintTool,
  ]);

  const ensureOverlayForMesh = useCallback(
    (layer: UvPaintLayer, mesh: THREE.Mesh) => {
      // Raycasts can hit the visible mask mesh itself. Never attach another
      // mask mesh below an overlay or the render passes grow after each stroke.
      if (mesh.userData.liclickPaintOverlay) return;
      let accumulatedOverlay = layer.accumulatedMaskOverlays.find(
        (overlay) => overlay.parent === mesh,
      );
      if (!accumulatedOverlay) {
        accumulatedOverlay = new THREE.Mesh(mesh.geometry, layer.accumulatedMaskMaterial);
        accumulatedOverlay.name = 'Liclick Accumulated Inpaint Mask Overlay';
        accumulatedOverlay.userData.liclickPaintOverlay = true;
        accumulatedOverlay.userData.liclickInpaintMaskOverlay = true;
        accumulatedOverlay.userData.liclickAccumulatedInpaintMaskOverlay = true;
        accumulatedOverlay.visible =
          shouldRenderInpaintMaskOnMesh(layer, mesh) &&
          (layer.accumulatedMaskReady || currentProjectionHasContentRef.current) &&
          readShouldShowInpaintMask();
        accumulatedOverlay.renderOrder = INPAINT_MASK_OVERLAY_RENDER_ORDER;
        mesh.add(accumulatedOverlay);
        layer.accumulatedMaskOverlays.push(accumulatedOverlay);
        layer.overlayMeshes.push(accumulatedOverlay);
      }
      // One accumulated overlay composites both the fixed UV history and the
      // current projected stroke. Do not allocate a second geometry pass.
      layer.overlayMeshes = layer.overlayMeshes.filter((overlay) => {
        if (
          !overlay.userData.liclickInpaintMaskOverlay ||
          overlay.userData.liclickAccumulatedInpaintMaskOverlay ||
          overlay.parent !== mesh
        )
          return true;
        overlay.removeFromParent();
        return false;
      });
      layer.overlayTargets.delete(mesh);
    },
    [readShouldShowInpaintMask],
  );

  const ensureInpaintMaskOverlaysForModel = useCallback(
    (layer: UvPaintLayer, model: SurfacePaintTarget) => {
      // Migrate paint layers created by an older HMR generation in place.
      layer.directMaskReadyMeshes ??= new Set();
      // The selection texture lives in screen space and may span several
      // disconnected submeshes even when the pointer itself only raycasts one
      // of them. Include real geometry even when it has no UVs; UV availability
      // is relevant to texture baking, but must not make a visible fitting punch
      // a hole through this screen-space editor overlay.
      const meshes = getInpaintSurfaceCache(model).meshes;
      const surfaceMeshes = new Set<THREE.Object3D>(meshes);
      const nextBindings: UvPaintLayer['inpaintMaterialBindings'] = [];
      if (USE_DIRECT_INPAINT_MATERIAL_PATCH) {
        meshes.forEach((mesh) => {
          const existing = layer.inpaintMaterialBindings.find((binding) => binding.mesh === mesh);
          if (existing && mesh.material === existing.patched) {
            nextBindings.push(existing);
            return;
          }
          if (existing) {
            (Array.isArray(existing.patched) ? existing.patched : [existing.patched]).forEach(
              restoreInpaintPatchedMaterial,
            );
          }
          layer.directMaskReadyMeshes.delete(mesh);
          const original = mesh.material;
          const patched = Array.isArray(original)
            ? original.map((material) => createInpaintPatchedMaterial(material, layer, mesh))
            : createInpaintPatchedMaterial(original, layer, mesh);
          nextBindings.push({ mesh, original, patched });
        });
      }
      layer.inpaintMaterialBindings.forEach((binding) => {
        if (USE_DIRECT_INPAINT_MATERIAL_PATCH && surfaceMeshes.has(binding.mesh)) return;
        if (binding.mesh.material === binding.patched) binding.mesh.material = binding.original;
        (Array.isArray(binding.patched) ? binding.patched : [binding.patched]).forEach(
          restoreInpaintPatchedMaterial,
        );
        layer.directMaskReadyMeshes.delete(binding.mesh);
      });
      if (!USE_DIRECT_INPAINT_MATERIAL_PATCH) {
        // HMR and previously entered repaint sessions may leave meshes marked as
        // direct-ready. Keeping those ids suppresses the lightweight overlay and
        // makes the mask appear to paint intermittently until a full page reload.
        layer.directMaskReadyMeshes.clear();
      }
      layer.inpaintMaterialBindings = nextBindings;
      layer.overlayMeshes = layer.overlayMeshes.filter((overlay) => {
        if (
          !overlay.userData.liclickInpaintMaskOverlay ||
          overlay.userData.liclickAccumulatedInpaintMaskOverlay
        )
          return true;
        overlay.removeFromParent();
        return false;
      });
      layer.overlayTargets.clear();
      layer.inpaintSnapshots.forEach((snapshot) => {
        snapshot.overlayMeshes.forEach((overlay) => overlay.removeFromParent());
        snapshot.texture.dispose();
        snapshot.material.dispose();
        snapshot.depthTarget?.dispose();
      });
      layer.inpaintSnapshots = [];
      const retainedAccumulatedOverlays = new Map<THREE.Object3D, THREE.Mesh>();
      layer.accumulatedMaskOverlays = layer.accumulatedMaskOverlays.filter((overlay) => {
        const parent = overlay.parent;
        if (!parent || !surfaceMeshes.has(parent) || retainedAccumulatedOverlays.has(parent)) {
          overlay.removeFromParent();
          layer.overlayMeshes = layer.overlayMeshes.filter((item) => item !== overlay);
          return false;
        }
        retainedAccumulatedOverlays.set(parent, overlay);
        overlay.material = layer.accumulatedMaskMaterial;
        return true;
      });
      meshes.forEach((mesh) => ensureOverlayForMesh(layer, mesh));
      layer.accumulatedMaskOverlays.forEach((overlay) => {
        const parent = overlay.parent;
        overlay.visible =
          parent instanceof THREE.Mesh &&
          !layer.directMaskReadyMeshes.has(parent) &&
          shouldRenderInpaintMaskOnMesh(layer, parent) &&
          readShouldShowInpaintMask() &&
          (layer.accumulatedMaskReady || currentProjectionHasContentRef.current);
      });
      {
        document.body.dataset.inpaintMaskRenderPath = JSON.stringify({
          mode: USE_DIRECT_INPAINT_MATERIAL_PATCH
            ? 'resident-material-with-overlay-fallback'
            : 'depth-tested-overlay-only',
          meshCount: meshes.length,
          materialTypes: Array.from(
            new Set(
              meshes.flatMap((mesh) =>
                (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).map(
                  (material) => material.type,
                ),
              ),
            ),
          ),
          overlayCount: layer.accumulatedMaskOverlays.filter((overlay) => overlay.visible).length,
          directReadyCount: layer.directMaskReadyMeshes.size,
        });
      }
      if (
        USE_DIRECT_INPAINT_MATERIAL_PATCH &&
        meshes.some((mesh) => !layer.directMaskReadyMeshes.has(mesh))
      ) {
        void gl.compileAsync(scene, camera).then(
          () => {
            if (layerRef.current !== layer) return;
            layer.inpaintMaterialBindings.forEach((binding) => {
              if (binding.mesh.material === binding.patched) {
                layer.directMaskReadyMeshes.add(binding.mesh);
              }
            });
            layer.accumulatedMaskOverlays.forEach((overlay) => {
              if (overlay.parent instanceof THREE.Mesh) {
                overlay.visible =
                  !layer.directMaskReadyMeshes.has(overlay.parent) &&
                  shouldRenderInpaintMaskOnMesh(layer, overlay.parent) &&
                  readShouldShowInpaintMask() &&
                  (layer.accumulatedMaskReady || currentProjectionHasContentRef.current);
              }
            });
            document.body.dataset.inpaintMaskDirectReadyCount = String(
              layer.directMaskReadyMeshes.size,
            );
            invalidate();
          },
          (error) => {
            console.warn(
              '[Liclick 3D Texture] Direct mask material precompile failed; keeping overlay fallback.',
              error,
            );
          },
        );
      }
    },
    [camera, ensureOverlayForMesh, gl, invalidate, readShouldShowInpaintMask, scene],
  );

  const syncLocalRepaintGpuOverlayActivity = useCallback(() => {
    const overlay = localRepaintGpuOverlayRef.current;
    if (!overlay) return;
    const sceneState = useSceneStore.getState();
    const layerState = useLayerStore.getState();
    const layers = layerState.layers;
    const composite = localRepaintCompositeRef.current;
    const hasPersistedLayer = layers.some((layer) => layer.id === overlay.layerId);
    const hasLiveContent = Boolean(
      composite?.sourceKey === overlay.sourceKey && composite.hasContent,
    );
    const previewOwnsOverlay = sceneState.localRepaintPreviewLayer?.id === overlay.layerId;
    const erasesPersistedLocalRepaint = isLocalRepaintLayerEraserActive(
      sceneState.paintTool,
      layerState.activeProjectedLayerId,
      overlay.layerId,
      layers,
    );
    const keepsLiveLocalRepaintPreview =
      sceneState.paintTool === 'inpaint-apply' ||
      erasesPersistedLocalRepaint ||
      (previewOwnsOverlay &&
        (sceneState.paintTool === 'inpaint-add' || sceneState.paintTool === 'inpaint-subtract'));
    // An empty prewarmed overlay used to rasterize the complete model even
    // though every fragment resolved to zero alpha. Do not submit that draw at
    // all. Mask editing is part of the same local-repaint session, so keep the
    // live result visible while moving between the apply brush and mask brush.
    // After leaving those tools, keep the overlay only for the very short atomic
    // handoff window before the persisted row is resident.
    const shouldRender = Boolean(
      hasLiveContent &&
      (keepsLiveLocalRepaintPreview || !hasPersistedLayer) &&
      isLocalRepaintOverlayVisible(
        sceneState.displayMode,
        readLocalRepaintGpuOverlayLayerVisibility(overlay, layers),
      ),
    );
    if (setLocalRepaintGpuOverlayVisibility(overlay, shouldRender)) invalidate();
    if (
      !keepsLiveLocalRepaintPreview &&
      hasPersistedLayer &&
      previewOwnsOverlay
    ) {
      // The resident projected row now owns presentation. Removing this marker
      // also stops SceneRoot from muting that row after the renderer-only twin
      // has been hidden.
      sceneState.setLocalRepaintPreviewLayer(undefined);
    }
  }, [invalidate]);

  useEffect(() => {
    syncLocalRepaintGpuOverlayActivity();
    const unsubscribeLayers = useLayerStore.subscribe(syncLocalRepaintGpuOverlayActivity);
    return unsubscribeLayers;
  }, [displayMode, paintTool, syncLocalRepaintGpuOverlayActivity]);

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

  const scheduleTextureUpdate = useCallback(
    (texture: THREE.CanvasTexture) => {
      // Publish the texture revision before requesting the render. Deferring
      // needsUpdate itself to rAF let R3F's already-queued render win the race,
      // so the new mask was uploaded one whole frame later (and button 3 could
      // probe an apparently empty GPU mask). Coalesce only duplicate revision
      // bumps; the first sample in each frame is immediately renderable.
      if (!dirtyTexturesRef.current.has(texture)) {
        dirtyTexturesRef.current.add(texture);
        texture.needsUpdate = true;
      }
      invalidate();
      if (textureUpdateFrameRef.current !== undefined) return;
      textureUpdateFrameRef.current = window.requestAnimationFrame(() => {
        textureUpdateFrameRef.current = undefined;
        dirtyTexturesRef.current.clear();
      });
    },
    [invalidate],
  );

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

  const captureInpaintProjectionDepth = useCallback(
    (layer: UvPaintLayer, model: SurfacePaintTarget) => {
      if (
        layerRef.current !== layer ||
        layer.objectId !== model.objectId ||
        hasInpaintProjectionCameraChanged(layer, camera)
      )
        return false;
      const width = Math.max(1, layer.projectionCanvas.width);
      const height = Math.max(1, layer.projectionCanvas.height);
      if (
        !layer.maskDepthTarget ||
        layer.maskDepthTarget.width !== width ||
        layer.maskDepthTarget.height !== height
      ) {
        layer.maskDepthTarget?.dispose();
        layer.maskDepthTarget = createInpaintDepthTarget(width, height);
      }
      const target = layer.maskDepthTarget;
      // Reuse the exact depth pass material prepared while the viewport is idle.
      // Constructing and linking a fresh MeshDepthMaterial during every first
      // selection stroke produced a repeatable ~230ms mask-add frame.
      const restoreScene = applyTargetOnlyMaterial(
        scene,
        model.objectId,
        () => inpaintDepthMaterial,
      );
      const previousTarget = gl.getRenderTarget();
      const previousClearColor = gl.getClearColor(new THREE.Color()).clone();
      const previousClearAlpha = gl.getClearAlpha();
      const previousAutoClear = gl.autoClear;
      const finishDepthCapture = startPerformanceSpan(
        'local-repaint',
        'selection-projector-depth-capture',
        { width, height },
      );
      try {
        gl.autoClear = true;
        gl.setRenderTarget(target);
        gl.setClearColor('#ffffff', 1);
        gl.clear(true, true, true);
        gl.render(scene, camera);
        layer.maskDepthReady = true;
        bindInpaintDepthTarget(layer.maskMaterial, target, true);
        bindInpaintDepthTarget(layer.accumulatedMaskMaterial, target, true);
        finishDepthCapture('end', { width, height });
        invalidate();
        return true;
      } catch (error) {
        finishDepthCapture('error', {
          message: error instanceof Error ? error.message : String(error),
        });
        throw error;
      } finally {
        restoreScene();
        gl.setRenderTarget(previousTarget);
        gl.setClearColor(previousClearColor, previousClearAlpha);
        gl.autoClear = previousAutoClear;
      }
    },
    [camera, gl, inpaintDepthMaterial, invalidate, scene],
  );

  const scheduleInpaintProjectionDepth = useCallback(
    (layer: UvPaintLayer, model: SurfacePaintTarget, immediate = false) => {
      if (inpaintDepthCaptureTimerRef.current !== undefined) {
        window.clearTimeout(inpaintDepthCaptureTimerRef.current);
        inpaintDepthCaptureTimerRef.current = undefined;
      }
      if (inpaintDepthCaptureFrameRef.current !== undefined) {
        window.cancelAnimationFrame(inpaintDepthCaptureFrameRef.current);
        inpaintDepthCaptureFrameRef.current = undefined;
      }
      const capture = () => {
        inpaintDepthCaptureFrameRef.current = undefined;
        if (isPaintingRef.current || hasInpaintProjectionCameraChanged(layer, camera)) return false;
        return captureInpaintProjectionDepth(layer, model);
      };
      if (immediate) return capture();
      inpaintDepthCaptureTimerRef.current = window.setTimeout(() => {
        inpaintDepthCaptureTimerRef.current = undefined;
        inpaintDepthCaptureFrameRef.current = window.requestAnimationFrame(capture);
      }, INPAINT_DEPTH_CAPTURE_DELAY_MS);
      return false;
    },
    [camera, captureInpaintProjectionDepth],
  );

  useEffect(
    () => () => {
      if (inpaintDepthCaptureTimerRef.current !== undefined) {
        window.clearTimeout(inpaintDepthCaptureTimerRef.current);
      }
      if (inpaintDepthCaptureFrameRef.current !== undefined) {
        window.cancelAnimationFrame(inpaintDepthCaptureFrameRef.current);
      }
    },
    [],
  );

  const archiveCurrentInpaintProjection = useCallback(
    (
      layer: UvPaintLayer,
      model: SurfacePaintTarget,
      operation: 'add' | 'subtract' = 'add',
    ) => {
      if (!currentProjectionHasContentRef.current) return false;
      // Never persist an unoccluded projector into UV space. In normal use the
      // depth pass is prewarmed on tool activation and refreshed synchronously
      // before the first stamp after a camera move; this guard protects error,
      // HMR and context-recovery paths from permanently baking x-ray coverage.
      if (!layer.maskDepthReady || !layer.maskDepthTarget) {
        console.warn(
          '[Liclick 3D Texture] Skipped selection-mask archive because projector depth is unavailable.',
        );
        return false;
      }
      deactivateLiveInpaintScreenPreview();
      accumulateInpaintSnapshotToUv(
        gl,
        model,
        {
          texture: layer.projectionTexture,
          projectorMatrix: layer.maskProjectorMatrix,
          projectorObjectMatrix: layer.maskProjectorObjectMatrix,
          projectorPositionLocal: layer.maskProjectorPositionLocal,
          depthTarget: layer.maskDepthTarget,
        },
        layer.accumulatedMaskTarget,
        !layer.accumulatedMaskReady,
        operation,
      );
      layer.accumulatedMaskReady = true;
      if (operation === 'add') {
        layer.currentProjectionMeshes.forEach((mesh) => layer.accumulatedMaskMeshes.add(mesh));
      }
      layer.currentProjectionMeshes.clear();
      layer.accumulatedMaskMaterial.uniforms.projectionReady.value = 1;
      if (layer.accumulatedMaskMaterial.uniforms.baseReady)
        layer.accumulatedMaskMaterial.uniforms.baseReady.value = 1;
      if (layer.accumulatedMaskMaterial.uniforms.liveOperation)
        layer.accumulatedMaskMaterial.uniforms.liveOperation.value = 0;
      layer.accumulatedMaskOverlays.forEach((overlay) => {
        overlay.visible =
          overlay.parent instanceof THREE.Mesh &&
          !layer.directMaskReadyMeshes.has(overlay.parent) &&
          shouldRenderInpaintMaskOnMesh(layer, overlay.parent) &&
          readShouldShowInpaintMask();
      });
      layer.projectionContext.clearRect(
        0,
        0,
        layer.projectionCanvas.width,
        layer.projectionCanvas.height,
      );
      currentProjectionHasContentRef.current = false;
      layer.overlayMeshes.forEach((mesh) => {
        if (
          mesh.userData.liclickInpaintMaskOverlay &&
          !mesh.userData.liclickAccumulatedInpaintMaskOverlay
        )
          mesh.visible = false;
      });
      scheduleProjectionTextureUpdate(layer.projectionTexture, true);
      return true;
    },
    [
      deactivateLiveInpaintScreenPreview,
      gl,
      readShouldShowInpaintMask,
      scheduleProjectionTextureUpdate,
    ],
  );

  const syncInpaintMaskProjection = useCallback(
    (model: SurfacePaintTarget) => {
      const layer = getUvPaintLayer(model);
      // Multiple short strokes from the same camera share the live projector.
      // Archiving before this equality check forced a full UV accumulation pass
      // on every new dot even though the projector had not changed.
      if (!hasInpaintProjectionCameraChanged(layer, camera)) return layer;

      archiveCurrentInpaintProjection(layer, model, currentProjectionOperationRef.current);
      const rect = gl.domElement.getBoundingClientRect();
      resizeProjectionCanvas(layer, rect.width / Math.max(rect.height, 1), false);
      updateInpaintProjectionCamera(layer, camera, model.group);
      layer.paintPreviewMaterial.uniforms.projectionReady.value = 0;
      layer.paintPreviewOverlays.forEach((overlay) => {
        overlay.visible = false;
      });
      layer.overlayMeshes.forEach((mesh) => {
        if (mesh.userData.liclickInpaintMaskOverlay) {
          mesh.visible = mesh.userData.liclickAccumulatedInpaintMaskOverlay
            ? mesh.parent instanceof THREE.Mesh &&
              !layer.directMaskReadyMeshes.has(mesh.parent) &&
              shouldRenderInpaintMaskOnMesh(layer, mesh.parent) &&
              readShouldShowInpaintMask() &&
              (layer.accumulatedMaskReady || currentProjectionHasContentRef.current)
            : false;
        }
      });
      return layer;
    },
    [
      archiveCurrentInpaintProjection,
      camera,
      getUvPaintLayer,
      gl.domElement,
      readShouldShowInpaintMask,
    ],
  );

  const cancelIdleInpaintArchive = useCallback(() => {
    if (inpaintArchiveTimerRef.current !== undefined) {
      window.clearTimeout(inpaintArchiveTimerRef.current);
      inpaintArchiveTimerRef.current = undefined;
    }
    if (inpaintArchiveIdleRef.current !== undefined) {
      window.cancelIdleCallback?.(inpaintArchiveIdleRef.current);
      inpaintArchiveIdleRef.current = undefined;
    }
  }, []);

  const scheduleIdleInpaintArchive = useCallback(
    (layer: UvPaintLayer, model: SurfacePaintTarget) => {
      cancelIdleInpaintArchive();
      // Keep the pointer-up boundary free: the finished stroke reaches the
      // screen first, then the fixed UV buffer is updated only after input has
      // been quiet for a short period. A new stroke cancels this work.
      inpaintArchiveTimerRef.current = window.setTimeout(() => {
        inpaintArchiveTimerRef.current = undefined;
        const archive = () => {
          inpaintArchiveIdleRef.current = undefined;
          if (
            isPaintingRef.current ||
            layerRef.current !== layer ||
            !currentProjectionHasContentRef.current
          )
            return;
          archiveCurrentInpaintProjection(layer, model, currentProjectionOperationRef.current);
          invalidate();
        };
        if (window.requestIdleCallback) {
          inpaintArchiveIdleRef.current = window.requestIdleCallback(archive, {
            timeout: 600,
          });
        } else {
          inpaintArchiveIdleRef.current = window.setTimeout(archive, 0);
        }
      }, 450);
    },
    [archiveCurrentInpaintProjection, cancelIdleInpaintArchive, invalidate],
  );

  useEffect(() => cancelIdleInpaintArchive, [cancelIdleInpaintArchive]);

  useEffect(() => {
    if (!canUseSurfacePaint || paintTool !== 'none' || !shouldShowColorPaintOverlays)
      return undefined;
    const model = getTargetModel();
    if (!model) return undefined;
    const layer = getUvPaintLayer(model);
    const resourceKey = `${model.objectId}:${layer.layerId}:${layer.projectionTexture.uuid}`;
    if (inpaintMaskPrewarmResourceKeyRef.current === resourceKey) return undefined;
    let cancelled = false;
    let idleId: number | undefined;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let frameId: number | undefined;
    const waitForFrame = () =>
      new Promise<void>((resolve) => {
        frameId = window.requestAnimationFrame(() => resolve());
      });
    const canContinuePrewarm = () =>
      !cancelled && useSceneStore.getState().paintTool === 'none';
    const hidePrewarmedMaskIfInactive = () => {
      const currentTool = useSceneStore.getState().paintTool;
      if (currentTool !== 'inpaint-add' && currentTool !== 'inpaint-subtract') {
        hideInpaintMaskPresentation(layer);
      }
    };
    const prepare = async () => {
      if (!canContinuePrewarm()) return;
      if (isPaintingRef.current || document.body.dataset.perfSimulatedViewportInteraction === '1') {
        timeoutId = setTimeout(() => void prepare(), 250);
        return;
      }
      syncInpaintMaskProjection(model);
      const meshes: THREE.Mesh[] = [];
      model.group.traverse((child) => {
        if (!(child instanceof THREE.Mesh)) return;
        if (
          child.userData.liclickPaintOverlay ||
          child.userData.liclickViewportHelper ||
          child.userData.liclickSelectionGlow ||
          child.userData.liclickWireframeOverlay ||
          !child.geometry.getAttribute('position')
        )
          return;
        meshes.push(child);
      });
      for (let index = 0; index < meshes.length; index += 1) {
        if (!canContinuePrewarm()) {
          hidePrewarmedMaskIfInactive();
          return;
        }
        ensureOverlayForMesh(layer, meshes[index]);
        if ((index + 1) % 3 === 0) await waitForFrame();
        if (!canContinuePrewarm()) {
          hidePrewarmedMaskIfInactive();
          return;
        }
      }
      const compileIsolatedMeshes = async (
        sourceMeshes: THREE.Mesh[],
        overrideMaterial?: THREE.Material,
      ) => {
        const compileScene = new THREE.Scene();
        sourceMeshes.forEach((sourceMesh) => {
          const compileMesh = sourceMesh.clone(false) as THREE.Mesh;
          compileMesh.material = overrideMaterial ?? sourceMesh.material;
          compileMesh.visible = true;
          compileMesh.frustumCulled = false;
          compileScene.add(compileMesh);
        });
        try {
          await gl.compileAsync(compileScene, camera);
        } finally {
          compileScene.clear();
        }
      };
      try {
        if (!canContinuePrewarm()) return;
        gl.initTexture(layer.projectionTexture);
        // Compile only isolated mesh shells for the local-repaint programs.
        // Passing the live scene here lets compileAsync retain unrelated
        // materials while model restore is replacing them. Three's
        // parallel-compile poller then dereferences a disposed currentProgram,
        // producing an uncaught error and leaving the prewarm promise pending.
        // The isolated scene warms the identical material programs without
        // touching live visibility or unrelated material lifetimes.
        await compileIsolatedMeshes(layer.accumulatedMaskOverlays);
        if (!canContinuePrewarm()) return;
        // Compile the front-most-depth pass before the selection tool becomes
        // interactive. The pass remains pixel-identical; only shader linking is
        // moved out of the first user stroke.
        await compileIsolatedMeshes(meshes, inpaintDepthMaterial);
        if (!canContinuePrewarm()) return;
        // Allocate and fill the front-most depth target while idle as well.
        // Shader pre-linking alone still left the first selection stroke paying
        // the render-target allocation/first-render cost on the visible frame.
        captureInpaintProjectionDepth(layer, model);
      } catch (error) {
        console.warn('[Liclick 3D Texture] Selection mask GPU prewarm was incomplete:', error);
      } finally {
        hidePrewarmedMaskIfInactive();
      }
      if (!cancelled) {
        inpaintMaskPrewarmResourceKeyRef.current = resourceKey;
        markPerformanceEvent('local-repaint', 'selection-mask-overlay-prewarm', {
          meshCount: meshes.length,
        });
      }
    };
    if ('requestIdleCallback' in window) {
      idleId = window.requestIdleCallback(() => void prepare(), { timeout: 2_000 });
    } else {
      timeoutId = setTimeout(() => void prepare(), 600);
    }
    return () => {
      cancelled = true;
      if (idleId !== undefined && 'cancelIdleCallback' in window) window.cancelIdleCallback(idleId);
      if (timeoutId !== undefined) clearTimeout(timeoutId);
      if (frameId !== undefined) window.cancelAnimationFrame(frameId);
      hidePrewarmedMaskIfInactive();
    };
  }, [
    camera,
    canUseSurfacePaint,
    captureInpaintProjectionDepth,
    ensureOverlayForMesh,
    getTargetModel,
    getUvPaintLayer,
    gl,
    hideInpaintMaskPresentation,
    inpaintDepthMaterial,
    paintTool,
    syncInpaintMaskProjection,
  ]);

  useEffect(() => () => inpaintDepthMaterial.dispose(), [inpaintDepthMaterial]);

  useFrame(() => {
    const model = getTargetModel();
    const layer = layerRef.current;
    if (model && layer?.objectId === model.objectId) {
      // Imported/projected materials may be swapped asynchronously after the
      // local-repaint tool opens. Detect that one-time ownership change and
      // rebind the direct mask path; the fallback overlay stays visible until
      // the replacement program has compiled, so the mask never flashes out.
      if (
        isInpaintMode &&
        layer.inpaintMaterialBindings.some((binding) => binding.mesh.material !== binding.patched)
      ) {
        ensureInpaintMaskOverlaysForModel(layer, model);
      }
      // Projector uniforms are model-local and change only when a projection is
      // created. Rewriting and matrix-comparing them on every orbit frame adds
      // CPU work without changing a pixel.
      const previous = inpaintLastCameraRef.current;
      const cameraChanged =
        previous.position.distanceToSquared(camera.position) > 1e-10 ||
        previous.quaternion.angleTo(camera.quaternion) > 1e-6 ||
        Math.abs(previous.zoom - camera.zoom) > 1e-6;
      if (cameraChanged) {
        if (liveInpaintScreenPreview.mesh.visible) {
          deactivateLiveInpaintScreenPreview(layer, true);
        }
        previous.position.copy(camera.position);
        previous.quaternion.copy(camera.quaternion);
        previous.zoom = camera.zoom;
        // Camera navigation is a presentation-only path. Do not arm an idle
        // archive from wheel/orbit frames: under sustained wheel input the old
        // 450ms timer repeatedly crossed its deadline and submitted a full UV
        // accumulation pass in the middle of navigation. The frozen live
        // projector remains correct in model space and is handed off exactly
        // once at the next paint/capture boundary.
      }
    }
    // Orbit/zoom must never archive, copy canvases or rebuild projectors. The
    // current projector remains attached to model space until the next stroke.
  });

  const capturePaintMask = useCallback(async (options?: {
    aspect?: number;
    camera?: THREE.Camera;
  }) => {
    const model = getTargetModel();
    const layer = layerRef.current;
    if (!model || !layer || layer.objectId !== model.objectId || !maskHasContentRef.current)
      return undefined;

    const sources: Array<{
      texture: THREE.Texture;
      usesUv: boolean;
      meshes?: ReadonlySet<THREE.Mesh>;
      projectorMatrix?: THREE.Matrix4;
      projectorObjectMatrix?: THREE.Matrix4;
      projectorPositionLocal?: THREE.Vector3;
      depthTarget?: THREE.WebGLRenderTarget;
    }> = [
      ...(layer.accumulatedMaskReady
        ? [
            {
              texture: layer.accumulatedMaskTarget.texture,
              usesUv: true,
              meshes: layer.maskInverted ? undefined : new Set(layer.accumulatedMaskMeshes),
            },
          ]
        : []),
      ...layer.inpaintSnapshots.map((snapshot) => ({
        texture: snapshot.texture,
        projectorMatrix: snapshot.projectorMatrix,
        projectorObjectMatrix: snapshot.projectorObjectMatrix,
        projectorPositionLocal: snapshot.projectorPositionLocal,
        depthTarget: snapshot.depthTarget,
        usesUv: false,
      })),
      ...(currentProjectionHasContentRef.current
        ? [
            {
              texture: layer.projectionTexture,
              projectorMatrix: layer.maskProjectorMatrix,
              projectorObjectMatrix: layer.maskProjectorObjectMatrix,
              projectorPositionLocal: layer.maskProjectorPositionLocal,
              depthTarget: layer.maskDepthReady ? layer.maskDepthTarget : undefined,
              usesUv: false,
              meshes: layer.maskInverted ? undefined : new Set(layer.currentProjectionMeshes),
            },
          ]
        : []),
    ];
    if (sources.length === 0) return undefined;

    const viewportRect = gl.domElement.getBoundingClientRect();
    const viewportAspect = viewportRect.width / Math.max(viewportRect.height, 1);
    const aspect =
      Number.isFinite(options?.aspect) && (options?.aspect ?? 0) > 0
        ? options!.aspect!
        : viewportAspect;
    const width =
      aspect >= 1
        ? PROJECTION_PAINT_MAX_SIZE
        : Math.max(1, Math.round(PROJECTION_PAINT_MAX_SIZE * aspect));
    const height =
      aspect >= 1
        ? Math.max(1, Math.round(PROJECTION_PAINT_MAX_SIZE / aspect))
        : PROJECTION_PAINT_MAX_SIZE;
    const materials = sources.map((source) => {
      const material = createInpaintMaskCaptureMaterial(
        source.texture,
        source.depthTarget,
        source.usesUv,
      );
      // Each white coverage pass is composited over the previous one. The
      // render helper clears depth (not colour) between projector cameras.
      material.depthWrite = true;
      material.transparent = true;
      material.uniforms.maskInverted.value = layer.maskInverted ? 1 : 0;
      return material;
    });
    const startedAt = performance.now();
    try {
      const maskUrl = await renderScenePassesToPngUrl(
        {
          gl,
          scene,
          camera: cloneCameraForCaptureAspect(options?.camera ?? camera, aspect),
          objectId: model.objectId,
          width,
          height,
          clearColor: '#000000',
          clearAlpha: 1,
        },
        sources.map((source, index) => ({
          prepare: () => {
            const material = materials[index];
            if (!source.usesUv) {
              updateInpaintMaterialForObject(
                material,
                source.projectorMatrix!,
                source.projectorObjectMatrix!,
                source.projectorPositionLocal!,
                model.group,
              );
            }
            const restoreScene = applyTargetOnlyMaterial(scene, model.objectId, () => material);
            if (source.meshes) {
              scene.traverse((object) => {
                if (!(object instanceof THREE.Mesh)) return;
                if (object.userData.liclickObjectId !== model.objectId) return;
                if (!source.meshes?.has(object)) object.visible = false;
              });
            }
            return restoreScene;
          },
        })),
        {
          dataTexture: true,
          ignoreSceneBackground: true,
          // Projector accumulation is exact and order preserving; yielding
          // changes only scheduling, not any pixel or camera transform.
          waitForViewportIdle: waitForBrowserPaint,
        },
      );
      document.body.dataset.localRepaintButton2MaskCaptureMs = (
        performance.now() - startedAt
      ).toFixed(1);
      document.body.dataset.localRepaintButton2MaskProjectionCount = String(sources.length);
      return maskUrl;
    } finally {
      materials.forEach((material) => material.dispose());
    }
  }, [archiveCurrentInpaintProjection, camera, getTargetModel, gl, scene]);

  useEffect(() => {
    setPaintMaskCapture(capturePaintMask);
    return () => {
      if (useSceneStore.getState().paintMaskCapture === capturePaintMask) {
        setPaintMaskCapture(undefined);
      }
    };
  }, [capturePaintMask, setPaintMaskCapture]);

  useEffect(() => {
    if (
      paintMaskInvertRevision === 0 ||
      paintMaskInvertRevision === handledPaintMaskInvertRevisionRef.current
    )
      return;
    handledPaintMaskInvertRevisionRef.current = paintMaskInvertRevision;
    const model = getTargetModel();
    if (!model) return;
    const layer = getUvPaintLayer(model);
    deactivateLiveInpaintScreenPreview();
    layer.maskInverted = !layer.maskInverted;
    layer.accumulatedMaskMaterial.uniforms.maskInverted ??= { value: 0 };
    layer.accumulatedMaskMaterial.uniforms.maskInverted.value = layer.maskInverted ? 1 : 0;
    layer.accumulatedMaskOverlays.forEach((overlay) => {
      const parent = overlay.parent;
      overlay.visible =
        parent instanceof THREE.Mesh &&
        !layer.directMaskReadyMeshes.has(parent) &&
        shouldRenderInpaintMaskOnMesh(layer, parent) &&
        readShouldShowInpaintMask();
    });
    maskHasContentRef.current = true;
    maskDirtyRef.current = false;
    paintMaskCommitRevisionRef.current += 1;
    setPaintMaskDataUrl(undefined, true);
    document.body.dataset.localRepaintInvertBackend = 'gpu-uniform';
    invalidate();
  }, [
    deactivateLiveInpaintScreenPreview,
    getTargetModel,
    getUvPaintLayer,
    invalidate,
    paintMaskInvertRevision,
    readShouldShowInpaintMask,
    setPaintMaskDataUrl,
  ]);

  const waitForPaintCommitIdle = useCallback(
    (isCancelled?: () => boolean) =>
      new Promise<boolean>((resolve) => {
        const tryCommit = () => {
          if (isCancelled?.()) {
            resolve(false);
            return;
          }
          // While the repaint tool is active, accumulate short strokes and
          // publish once after a real pause. Once the user leaves the tool the
          // live overlay must hand off immediately; retaining the three-second
          // delay kept a duplicate full-model pass alive during ordinary zoom.
          const minimumIdleMs =
            useSceneStore.getState().paintTool === 'inpaint-apply'
              ? LOCAL_REPAINT_HIGH_RES_IDLE_MS
              : 0;
          const idleFor = performance.now() - lastPaintActivityAtRef.current;
          if (isPaintingRef.current || idleFor < minimumIdleMs) {
            window.setTimeout(tryCommit, Math.max(16, Math.min(50, minimumIdleMs - idleFor)));
            return;
          }
          const requestIdle = window.requestIdleCallback;
          if (requestIdle) {
            requestIdle(
              (deadline) => {
                if (isCancelled?.()) {
                  resolve(false);
                  return;
                }
                if (
                  isPaintingRef.current ||
                  performance.now() - lastPaintActivityAtRef.current <
                    (useSceneStore.getState().paintTool === 'inpaint-apply'
                      ? LOCAL_REPAINT_HIGH_RES_IDLE_MS
                      : 0)
                ) {
                  tryCommit();
                  return;
                }
                if (!deadline.didTimeout && deadline.timeRemaining() < 12) {
                  tryCommit();
                  return;
                }
                resolve(true);
              },
              { timeout: 5000 },
            );
            return;
          }
          window.setTimeout(() => {
            if (isCancelled?.()) {
              resolve(false);
              return;
            }
            if (isPaintingRef.current) {
              tryCommit();
              return;
            }
            resolve(true);
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
      localRepaintProjectedPublishRequestRef.current = undefined;
      clearLocalRepaintGpuOverlay();
      useSceneStore.getState().setLocalRepaintPreviewLayer(undefined);
    },
    [clearLocalRepaintGpuOverlay],
  );

  useEffect(() => {
    localRepaintUvCommitRevisionRef.current += 1;
    if (localRepaintHandoffFrameRef.current !== undefined)
      window.cancelAnimationFrame(localRepaintHandoffFrameRef.current);
    localRepaintHandoffFrameRef.current = undefined;
    if (localRepaintUvScheduleFrameRef.current !== undefined)
      window.cancelAnimationFrame(localRepaintUvScheduleFrameRef.current);
    localRepaintUvScheduleFrameRef.current = undefined;
    const source = localRepaintProjectionSource;
    const traceSourceEffect = (event: string) => {
      if (document.body.dataset.perfLocalRepaintMeasuring !== '1') return;
      let history: Array<Record<string, unknown>> = [];
      try {
        history = JSON.parse(
          document.body.dataset.localRepaintSourceEffectHistory ?? '[]',
        ) as typeof history;
      } catch {
        history = [];
      }
      history.push({
        event,
        unixMs: Date.now(),
        generationId: source?.generationId,
        targetLayerId: source?.targetLayerId,
        imageLength: source?.imageUrl.length,
        maskLength: source?.allowedMaskUrl.length,
        maskTail: source?.allowedMaskUrl.slice(-24),
      });
      document.body.dataset.localRepaintSourceEffectHistory = JSON.stringify(history.slice(-12));
    };
    traceSourceEffect('setup');
    delete document.body.dataset.localRepaintGpuReadyGeneration;
    delete document.body.dataset.localRepaintGpuReadyTarget;
    delete document.body.dataset.localRepaintGpuErrorGeneration;
    delete document.body.dataset.localRepaintGpuErrorTarget;
    if (!source) {
      clearLocalRepaintGpuOverlay();
      localRepaintSourceImageRef.current = undefined;
      localRepaintCompositeRef.current = undefined;
      localRepaintRuntimeDepthRef.current = undefined;
      setLocalRepaintAssetsRevision(0);
      useSceneStore.getState().setLocalRepaintPreviewLayer(undefined);
      return undefined;
    }

    const sceneState = useSceneStore.getState();
    const currentPreviewLayer = sceneState.localRepaintPreviewLayer;
    if (
      currentPreviewLayer &&
      !isMatchingLocalRepaintProjectionLayer(
        currentPreviewLayer,
        source,
        source.objectId ?? selectedObjectId ?? 'surface-object',
      )
    ) {
      // A renderer-owned preview mutes the persisted row with the same id. When
      // switching from repaint B back to repaint A, release B before decoding A;
      // otherwise B remains hidden while its GPU overlay is being rebound.
      sceneState.setLocalRepaintPreviewLayer(undefined);
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
    const sourceDecodeStartedAt = performance.now();
    const previousAssets = localRepaintSourceImageRef.current;
    void Promise.all([
      previousAssets?.url === source.imageUrl
        ? Promise.resolve(previousAssets.image)
        : loadImageElement(source.imageUrl),
      // The generated visibility mask is authoritative. Never turn a failed
      // mask fetch into unrestricted projection opacity.
      loadImageElement(source.allowedMaskUrl),
    ])
      .then(async ([sourceImage, allowedMaskImage]) => {
        if (cancelled) return;
        if (document.body.dataset.perfLocalRepaintMeasuring === '1') {
          document.body.dataset.localRepaintSourceDecodeMs = (
            performance.now() - sourceDecodeStartedAt
          ).toFixed(1);
        }
        const sourceWidth = sourceImage.naturalWidth || sourceImage.width;
        const sourceHeight = sourceImage.naturalHeight || sourceImage.height;
        const liveMaskSize = getLocalRepaintLiveMaskSize(sourceWidth, sourceHeight);
        const falloffCanvas = await createLocalRepaintFalloffCanvasAsync(
          allowedMaskImage,
          sourceImage,
          liveMaskSize.width,
          liveMaskSize.height,
        );
        const liveSource =
          previousAssets?.url === source.imageUrl
            ? previousAssets.liveSource
            : await createLocalRepaintLiveSource(sourceImage);
        if (cancelled) {
          traceSourceEffect('cancelled-after-falloff');
          return;
        }
        reportLocalRepaintPrewarmProgress(0.4, '高清图与透明蒙版已解码');
        // Register an asynchronously resized GPU source for interaction. The
        // full-resolution HTML image remains beside it for final quality work.
        const registerStartedAt = performance.now();
        // Each generation owns an immutable runtime texture URL. Reusing one
        // component-wide id disposed/replaced the previous generation's texture;
        // persisted older layers still referenced that URL and therefore began
        // sampling the newest repaint after any material/eye refresh.
        const previewImageUrl = registerLiveProjectedImageTexture(
          `local-repaint-source-preview:${createLocalRepaintSourceKey(
            source,
            source.objectId ?? selectedObjectId ?? 'unknown-object',
          )}`,
          liveSource,
          THREE.SRGBColorSpace,
        );
        if (document.body.dataset.perfLocalRepaintMeasuring === '1') {
          document.body.dataset.localRepaintSourceRegisterMs = (
            performance.now() - registerStartedAt
          ).toFixed(1);
        }
        reportLocalRepaintPrewarmProgress(0.56, '准备 GPU 原生纹理');
        localRepaintSourceImageRef.current = {
          url: source.imageUrl,
          allowedMaskUrl: source.allowedMaskUrl,
          image: sourceImage,
          liveSource,
          previewImageUrl,
          allowedMaskImage,
          falloffCanvas,
        };
        // The existing material and visible result stay resident while the new
        // mask is decoded. Swap only the mutable mask/composite after every new
        // asset is ready, avoiding a blank frame and a redundant shader rebuild.
        localRepaintCompositeRef.current = undefined;
        setLocalRepaintAssetsRevision((revision) => revision + 1);
        // Do not enable button 3 yet. The effect below publishes its empty
        // projection, uploads both immutable source and mutable mask textures,
        // and compiles the material before the first user stroke is accepted.
      })
      .catch((error) => {
        console.warn(
          '[Liclick 3D Texture] Could not prepare local repaint projection source:',
          error,
        );
        localRepaintSourceImageRef.current = undefined;
        localRepaintCompositeRef.current = undefined;
        document.body.dataset.localRepaintGpuErrorGeneration = source.generationId ?? '';
        document.body.dataset.localRepaintGpuErrorTarget = source.targetLayerId ?? '';
        reportLocalRepaintPrewarmProgress(1, '无法读取高清结果或蒙版，请重试', {
          done: true,
          failed: true,
        });
        const sceneState = useSceneStore.getState();
        const currentSource = sceneState.localRepaintProjectionSource;
        if (
          currentSource &&
          currentSource.generationId === source.generationId &&
          currentSource.imageUrl === source.imageUrl &&
          currentSource.allowedMaskUrl === source.allowedMaskUrl
        ) {
          // A failed owner must not block the next generation from binding.
          // Guard the identity so a newer task that won the race is untouched.
          sceneState.setLocalRepaintPreviewLayer(undefined);
          sceneState.setLocalRepaintProjectionSource(undefined);
        }
      });
    return () => {
      cancelled = true;
      traceSourceEffect('cleanup');
    };
  }, [clearLocalRepaintGpuOverlay, localRepaintProjectionSource]);

  useEffect(() => {
    const layer = layerRef.current;
    if (!layer) return;
    deactivateLiveInpaintScreenPreview();
    layer.maskContext.clearRect(0, 0, layer.maskCanvas.width, layer.maskCanvas.height);
    layer.projectionContext.clearRect(
      0,
      0,
      layer.projectionCanvas.width,
      layer.projectionCanvas.height,
    );
    // Clearing a completed task only removes its pixels. The projector camera
    // and depth target are still valid for the same view, so keep them warm for
    // the next task instead of rebuilding GPU depth synchronously on its first
    // pointer-down. Camera movement invalidates and refreshes this cache through
    // syncInpaintMaskProjection independently.
    bindInpaintDepthTarget(layer.maskMaterial, layer.maskDepthTarget, layer.maskDepthReady);
    bindInpaintDepthTarget(
      layer.accumulatedMaskMaterial,
      layer.maskDepthTarget,
      layer.maskDepthReady,
    );
    layer.inpaintSnapshots.forEach((snapshot) => {
      snapshot.overlayMeshes.forEach((mesh) => mesh.removeFromParent());
      snapshot.texture.dispose();
      snapshot.material.dispose();
      snapshot.depthTarget?.dispose();
    });
    layer.inpaintSnapshots = [];
    layer.accumulatedMaskReady = false;
    layer.accumulatedMaskMeshes.clear();
    layer.currentProjectionMeshes.clear();
    layer.accumulatedMaskMaterial.uniforms.projectionReady.value = 0;
    if (layer.accumulatedMaskMaterial.uniforms.baseReady)
      layer.accumulatedMaskMaterial.uniforms.baseReady.value = 0;
    if (layer.accumulatedMaskMaterial.uniforms.liveOperation)
      layer.accumulatedMaskMaterial.uniforms.liveOperation.value = 0;
    clearInpaintAccumulationTarget(gl, layer.accumulatedMaskTarget);
    layer.accumulatedMaskOverlays.forEach((overlay) => {
      overlay.visible = false;
    });
    scheduleTextureUpdate(layer.maskTexture);
    scheduleTextureUpdate(layer.projectionTexture);
    maskDirtyRef.current = false;
    maskHasContentRef.current = false;
    paintMaskContentPublishedRef.current = false;
    currentProjectionHasContentRef.current = false;
    currentProjectionOperationRef.current = 'add';
  }, [
    deactivateLiveInpaintScreenPreview,
    gl,
    paintMaskResetRevision,
    scheduleTextureUpdate,
  ]);

  useEffect(() => {
    const layer = layerRef.current;
    if (!layer) return;
    if (!shouldShowInpaintMask) hideInpaintMaskPresentation(layer);
    layer.overlayMeshes.forEach((mesh) => {
      if (mesh.userData.liclickInpaintMaskOverlay) {
        mesh.visible = mesh.userData.liclickAccumulatedInpaintMaskOverlay
          ? mesh.parent instanceof THREE.Mesh &&
            !layer.directMaskReadyMeshes.has(mesh.parent) &&
            shouldRenderInpaintMaskOnMesh(layer, mesh.parent) &&
            shouldShowInpaintMask &&
            (layer.accumulatedMaskReady || currentProjectionHasContentRef.current)
          : false;
      }
      if (mesh.userData.liclickPaintStrokePreview) {
        mesh.visible =
          shouldShowColorPaintOverlays &&
          layer.paintPreviewMaterial.uniforms.projectionReady.value > 0.5;
      }
    });
    layer.inpaintSnapshots.forEach((snapshot) => {
      snapshot.overlayMeshes.forEach((mesh) => {
        mesh.visible = false;
      });
    });
    const canUseFastScreenPreview =
      shouldShowInpaintMask &&
      currentProjectionHasContentRef.current &&
      currentProjectionOperationRef.current === 'add' &&
      !layer.accumulatedMaskReady &&
      !layer.maskInverted;
    if (canUseFastScreenPreview) activateLiveInpaintScreenPreview(layer);
    else deactivateLiveInpaintScreenPreview();
  }, [
    activateLiveInpaintScreenPreview,
    deactivateLiveInpaintScreenPreview,
    hideInpaintMaskPresentation,
    paintTool,
    shouldShowColorPaintOverlays,
    shouldShowInpaintMask,
  ]);

  useEffect(() => {
    if (!isInpaintMode) return;
    const model = getTargetModel();
    if (!model) return;
    const layer = syncInpaintMaskProjection(model);
    ensureInpaintMaskOverlaysForModel(layer, model);
    // Correctness must be present on the first visible stamp. Deferring this
    // capture let the lightweight live overlay briefly project through holes
    // until the delayed depth pass caught up.
    scheduleInpaintProjectionDepth(layer, model, true);

    // Local repaint uses a dedicated projected preview. Hide that transient
    // material when the user returns to the persistent selection projector.
    layer.paintPreviewMaterial.uniforms.projectionReady.value = 0;
    layer.paintPreviewOverlays.forEach((overlay) => {
      overlay.visible = false;
    });
    layer.overlayMeshes.forEach((mesh) => {
      if (mesh.userData.liclickInpaintMaskOverlay) {
        mesh.visible = mesh.userData.liclickAccumulatedInpaintMaskOverlay
          ? mesh.parent instanceof THREE.Mesh &&
            !layer.directMaskReadyMeshes.has(mesh.parent) &&
            shouldRenderInpaintMaskOnMesh(layer, mesh.parent) &&
            shouldShowInpaintMask &&
            (layer.accumulatedMaskReady || currentProjectionHasContentRef.current)
          : false;
      }
    });
  }, [
    ensureInpaintMaskOverlaysForModel,
    getTargetModel,
    isInpaintMode,
    shouldShowInpaintMask,
    scheduleInpaintProjectionDepth,
    syncInpaintMaskProjection,
  ]);

  useEffect(() => {
    // Keep the compiled mask blend resident while a selection exists. Toggling
    // the brush then changes input ownership only; it must not briefly restore
    // and recompile the base material, which made the mask disappear.
    if (isInpaintMode || paintMaskHasContent) return;
    const layer = layerRef.current;
    if (!layer || !layer.inpaintMaterialBindings?.length) return;
    layer.inpaintMaterialBindings.forEach(({ mesh, original, patched }) => {
      if (mesh.material === patched) mesh.material = original;
      (Array.isArray(patched) ? patched : [patched]).forEach(restoreInpaintPatchedMaterial);
    });
    layer.inpaintMaterialBindings = [];
    layer.overlayMeshes.forEach((overlay) => {
      if (overlay.userData.liclickInpaintMaskOverlay) overlay.visible = false;
    });
    invalidate();
  }, [invalidate, isInpaintMode, paintMaskHasContent]);

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
            : paintTool === 'inpaint-apply'
              ? localRepaintBrushSettings.brushSize
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
      localRepaintBrushSettings.brushSize,
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
          : paintTool === 'inpaint-apply'
            ? localRepaintBrushSettings.brushSize
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
    localRepaintBrushSettings.brushSize,
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
    (event: Pick<globalThis.PointerEvent, 'clientX' | 'clientY'>) => {
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
      featherPercent?: number,
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
      const featheredStamp =
        featherPercent === undefined ? undefined : getFeatheredBrushStamp(featherPercent);
      const paintStamp =
        featheredStamp || paintHardness === undefined
          ? undefined
          : getPaintBrushStamp(color, paintHardness);
      const brushStamp = featheredStamp ?? paintStamp;

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
      const { width, height } = getLocalRepaintLiveMaskSize(sourceWidth, sourceHeight);

      model.group.updateMatrixWorld(true);
      const sourceKey = createLocalRepaintSourceKey(localRepaintSource, model.objectId);
      const currentLayers = useLayerStore.getState().layers;
      const existingLayer = currentLayers.find((item) =>
        isMatchingLocalRepaintProjectionLayer(item, localRepaintSource, model.objectId),
      );
      if (document.body.dataset.perfLocalRepaintMeasuring === '1') {
        document.body.dataset.localRepaintLayerHandoff = JSON.stringify({
          phase: document.body.dataset.perfLocalRepaintPhase,
          sourceTargetLayerId: localRepaintSource.targetLayerId,
          existingLayerId: existingLayer?.id,
          currentPreviewLayerId: useSceneStore.getState().localRepaintPreviewLayer?.id,
          matchingProjectedLayers: currentLayers
            .filter((item) =>
              isMatchingLocalRepaintProjectionLayer(item, localRepaintSource, model.objectId),
            )
            .map((item) => ({
              id: item.id,
              replacementTargetLayerId: item.replacementTargetLayerId,
              generationId: item.generationId,
            })),
        });
      }
      let composite = localRepaintCompositeRef.current;
      const layerId =
        existingLayer?.id ??
        (composite?.sourceKey === sourceKey
          ? composite.layerId
          : createId(LOCAL_REPAINT_PROJECTION_LAYER_ID_PREFIX));
      // Prefer the workspace-resolved canonical field. Older project files can
      // retain a relative localRepaintMaskUrl even though maskUrl is already an
      // absolute runtime URL after reload.
      const savedMaskUrl = existingLayer?.maskUrl ?? existingLayer?.localRepaintMaskUrl;
      // Live repaint masks use a stable registry URL derived from layerId. Read
      // the old canvas before createLocalRepaintComposite registers the new one
      // at that same URL, otherwise switching back to an older repaint replaces
      // its cumulative mask with a blank canvas before it can be restored.
      const savedLiveMaskCanvas = savedMaskUrl
        ? getLiveProjectedCanvasState(savedMaskUrl)?.canvas
        : undefined;
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
          localRepaintSourceImageRef.current?.falloffCanvas,
        );
        localRepaintCompositeRef.current = composite;
        if (composite && savedMaskUrl) {
          composite.restoredMaskUrl = savedMaskUrl;
          composite.restoredMaskReady = false;
          document.body.dataset.localRepaintMaskRestoreState = `pending:${composite.layerId}`;
          const restoreSavedMask = (image: CanvasImageSource) => {
            if (
              localRepaintCompositeRef.current !== composite ||
              composite?.restoredMaskUrl !== savedMaskUrl
            )
              return;
            composite.maskContext.save();
            composite.maskContext.globalCompositeOperation = 'copy';
            composite.maskContext.drawImage(
              image,
              0,
              0,
              composite.maskCanvas.width,
              composite.maskCanvas.height,
            );
            composite.maskContext.restore();
            composite.hasContent = true;
            composite.restoredMaskReady = true;
            document.body.dataset.localRepaintMaskRestoreState = `ready:${composite.layerId}`;
            delete document.body.dataset.localRepaintMaskRestoreErrorUrl;
            markLiveProjectedCanvasTextureUpdated(composite.maskUrl);
          };
          if (savedLiveMaskCanvas) {
            restoreSavedMask(savedLiveMaskCanvas);
            composite.restoredMaskPromise = Promise.resolve();
          } else {
            composite.restoredMaskPromise = loadImageElement(savedMaskUrl)
              .then(restoreSavedMask)
              .catch((error) => {
                document.body.dataset.localRepaintMaskRestoreState = `failed:${composite?.layerId ?? 'unknown'}`;
                document.body.dataset.localRepaintMaskRestoreErrorUrl = savedMaskUrl;
                console.warn('[Liclick 3D Texture] Could not restore local repaint mask:', error);
              });
          }
        }
      }
      if (!composite) return undefined;
      updateLocalRepaintProjectionMatrix(composite, model, localRepaintSource);
      const runtimeDepth =
        localRepaintRuntimeDepthRef.current?.sourceKey === sourceKey
          ? localRepaintRuntimeDepthRef.current.depthUrl
          : undefined;
      const runtimeNormal =
        localRepaintRuntimeDepthRef.current?.sourceKey === sourceKey
          ? localRepaintRuntimeDepthRef.current.normalUrl
          : undefined;

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
        depthUrl: runtimeDepth ?? localRepaintSource.depthUrl,
        depthEncoding: runtimeDepth ? 'linear-view' : localRepaintSource.depthEncoding,
        normalUrl: runtimeNormal,
        objectId: localRepaintSource.objectId ?? model.objectId,
        objectMatrixWorld:
          localRepaintSource.objectMatrixWorld ?? model.group.matrixWorld.toArray(),
        camera: localRepaintSource.camera,
        generationId: localRepaintSource.generationId,
        captureId: localRepaintSource.captureId,
        replacementTargetLayerId: localRepaintSource.targetLayerId,
        renderedColor: false,
        minimumProjectionFacing: LOCAL_REPAINT_MINIMUM_FACE_ON,
        projectionVisibilityPolicy: 'surface-locked-v1',
        isBaked: false,
        needsRebake: true,
        visible: true,
        opacity: 1,
        strength: 1,
        // Local repaint is a literal source replacement inside the authored
        // brush alpha, not Photoshop's contrast-changing Overlay blend mode.
        blendMode: 'normal',
        adjustments: { hue: 0, saturation: 0, lightness: 0 },
        order: 0,
        createdAt: existingLayer?.createdAt ?? new Date().toISOString(),
      };
      // Keep the interactive projection out of the persisted layer stack. It is
      // renderer-only state, so pointer-down no longer creates a temporary row or
      // forces the UV layer compositor to rebuild.
      const sceneState = useSceneStore.getState();
      const currentPreviewLayer = sceneState.localRepaintPreviewLayer;
      const currentOverlay = localRepaintGpuOverlayRef.current;
      const persistedOverlayCanOwnPresentation = Boolean(
        !existingLayer ||
          (composite.hasContent &&
            composite.gpuOverlayReady &&
            currentOverlay?.sourceKey === sourceKey &&
            currentOverlay.layerId === projectedLayer.id &&
            currentOverlay.root.visible),
      );
      const previewAlreadyPublished =
        currentPreviewLayer?.id === projectedLayer.id &&
        currentPreviewLayer.imageUrl === projectedLayer.imageUrl &&
        currentPreviewLayer.maskUrl === projectedLayer.maskUrl &&
        currentPreviewLayer.depthUrl === projectedLayer.depthUrl &&
        currentPreviewLayer.normalUrl === projectedLayer.normalUrl &&
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
      // A persisted row must remain visible until its saved mask is resident.
      // Publishing the renderer-owner marker earlier mutes that row in SceneRoot
      // while this empty canvas is still transparent, making the whole repaint
      // disappear as soon as the eraser is selected.
      // GPU readiness alone is not enough: refresh/prewarm deliberately keeps the
      // renderer-only twin hidden. Do not mute the saved row until that twin is
      // actually visible, and repair a stale owner marker from an interrupted
      // handoff so refresh can never leave both representations hidden.
      if (
        existingLayer &&
        currentPreviewLayer?.id === projectedLayer.id &&
        !persistedOverlayCanOwnPresentation
      ) {
        sceneState.setLocalRepaintPreviewLayer(undefined);
      } else if (persistedOverlayCanOwnPresentation && !previewAlreadyPublished) {
        sceneState.setLocalRepaintPreviewLayer(projectedLayer);
      }
      return composite;
    },
    [localRepaintProjectionSource],
  );

  const ensureLocalRepaintGpuOverlay = useCallback(
    async (
      model: SurfacePaintTarget,
      source: LocalRepaintProjectionSource,
      composite: LocalRepaintCompositeState,
    ) => {
      const sourceKey = createLocalRepaintSourceKey(source, model.objectId);
      const currentOverlay = localRepaintGpuOverlayRef.current;
      if (
        currentOverlay?.sourceKey === sourceKey &&
        currentOverlay.layerId === composite.layerId &&
        currentOverlay.material.userData.liclickDisposedMaterial !== true
      ) {
        const previewImageUrl = localRepaintSourceImageRef.current?.previewImageUrl;
        const sourceTexture = previewImageUrl
          ? getLiveProjectedTexture(previewImageUrl, THREE.SRGBColorSpace, { flipY: false })
          : undefined;
        const layerVisible = readLocalRepaintGpuOverlayLayerVisibility(currentOverlay);
        const sceneState = useSceneStore.getState();
        const layerState = useLayerStore.getState();
        const erasesPersistedLocalRepaint = isLocalRepaintLayerEraserActive(
          sceneState.paintTool,
          layerState.activeProjectedLayerId,
          composite.layerId,
          layerState.layers,
        );
        const visible = Boolean(
          composite.hasContent &&
          (sceneState.paintTool === 'inpaint-apply' || erasesPersistedLocalRepaint) &&
          isLocalRepaintOverlayVisible(sceneState.displayMode, layerVisible),
        );
        if (
          syncLocalRepaintGpuOverlayBinding(currentOverlay, {
            modelGroup: model.group,
            sourceTexture,
            maskTexture: composite.maskTexture,
            visible,
          })
        ) {
          const repairRevision =
            Number(document.body.dataset.localRepaintOverlayRepairRevision ?? '0') + 1;
          document.body.dataset.localRepaintOverlayRepairRevision = String(repairRevision);
          invalidate();
        }
        composite.gpuOverlayReady = true;
        return currentOverlay;
      }

      const previewImageUrl = localRepaintSourceImageRef.current?.previewImageUrl;
      if (!previewImageUrl) return undefined;
      model.group.updateMatrixWorld(true);
      const compileStartedAt = performance.now();
      const runtimeDepth =
        localRepaintRuntimeDepthRef.current?.sourceKey === sourceKey
          ? localRepaintRuntimeDepthRef.current.depthUrl
          : undefined;
      const visibilityDepthUrl = runtimeDepth ?? source.depthUrl;
      const visibilityNormalUrl =
        localRepaintRuntimeDepthRef.current?.sourceKey === sourceKey
          ? localRepaintRuntimeDepthRef.current.normalUrl
          : undefined;
      const material = await createProjectedLayerMaterial({
        layerId: composite.layerId,
        imageUrl: previewImageUrl,
        maskUrl: composite.maskUrl,
        maskSpace: 'projection',
        depthUrl: visibilityDepthUrl,
        depthIsLinearView: runtimeDepth ? true : source.depthEncoding === 'linear-view',
        normalUrl: visibilityNormalUrl,
        // Capture normals are smooth-shaded for image generation, while this
        // material evaluates flat derivative normals. Comparing the two clips
        // valid curved and low-poly regions into permanent paint dead zones.
        // Capture depth already provides exact front-surface visibility and is
        // sufficient to prevent projection-through without the false rejects.
        camera: source.camera,
        objectId: source.objectId ?? model.objectId,
        objectMatrixWorld: source.objectMatrixWorld ?? model.group.matrixWorld.toArray(),
        currentObjectMatrixWorld: model.group.matrixWorld.toArray(),
        opacity: 1,
        strength: 1,
        blendMode: 'normal',
        compositeRole: 'overlay',
        visible: true,
        depthTest: true,
        useMask: true,
        useDepthCheck: Boolean(visibilityDepthUrl),
        useNormalCheck: Boolean(visibilityNormalUrl),
        renderedColor: false,
        transparentProjectionOnly: true,
        minimumProjectionFacing: LOCAL_REPAINT_MINIMUM_FACE_ON,
        projectionVisibilityPolicy: 'surface-locked-v1',
        enableBackfaceCulling: true,
        edgeFeather: 0.004,
        depthBias: 0.025,
        previewLighting: getPreviewLighting({
          displayMode: useSceneStore.getState().displayMode,
          environmentPreset: useSettingsStore.getState().environmentPreset,
          exposure: useSettingsStore.getState().exposure,
          pbrEnvironmentIntensity: useSettingsStore.getState().pbrEnvironmentIntensity,
          pbrKeyLightIntensity: useSettingsStore.getState().pbrKeyLightIntensity,
          pbrLightAzimuth: useSettingsStore.getState().pbrLightAzimuth,
        }),
      });

      const currentSource = useSceneStore.getState().localRepaintProjectionSource;
      if (
        localRepaintCompositeRef.current !== composite ||
        !currentSource ||
        createLocalRepaintSourceKey(currentSource, model.objectId) !== sourceKey
      ) {
        disposeGeneratedMaterialTree(material);
        return undefined;
      }

      // A new repaint task changes textures/camera uniforms, not the shader
      // structure. Keep the already-linked overlay program and geometry alive,
      // then atomically rebind the new source. Recompiling the identical shader
      // on every task caused a measured 179ms source-bind frame and the user's
      // repeat-task half-beat delay.
      if (
        currentOverlay &&
        currentOverlay.material.userData.liclickDisposedMaterial !== true &&
        currentOverlay.root.parent === model.group
      ) {
        const rebindUniforms = [
          'projectedMap',
          'maskMap',
          'depthMap',
          'normalMap',
          'visibilityTexelSize',
          'projectorMatrix',
          'objectMatrixDelta',
          'objectNormalDelta',
          'projectorViewMatrix',
          'projectorPosition',
          'useMask',
          'useDepthCheck',
          'useNormalCheck',
          'depthIsLinearView',
          'projectorNear',
          'projectorFar',
          'minimumProjectionFacing',
          'surfaceLockedVisibility',
          'edgeFeather',
          'depthBias',
        ] as const;
        rebindUniforms.forEach((name) => {
          const nextUniform = material.uniforms[name];
          const residentUniform = currentOverlay.material.uniforms[name];
          if (nextUniform && residentUniform) residentUniform.value = nextUniform.value;
        });
        currentOverlay.material.userData[PROJECTED_LAYER_MATERIAL_USER_DATA_KEY] =
          material.userData[PROJECTED_LAYER_MATERIAL_USER_DATA_KEY];
        currentOverlay.material.name = material.name;
        currentOverlay.sourceKey = sourceKey;
        currentOverlay.layerId = composite.layerId;
        currentOverlay.visibilityLayerId = composite.layerId;
        currentOverlay.visibilityLayerSeen = false;
        const layerVisible = readLocalRepaintGpuOverlayLayerVisibility(currentOverlay);
        syncLocalRepaintGpuOverlayBinding(currentOverlay, {
          modelGroup: model.group,
          sourceTexture: material.uniforms.projectedMap?.value as THREE.Texture | undefined,
          maskTexture: composite.maskTexture,
          visible: isLocalRepaintOverlayVisible(useSceneStore.getState().displayMode, layerVisible),
        });
        syncProjectedLayerMaterialProjection(model.group);
        disposeGeneratedMaterialTree(material);
        document.body.dataset.localRepaintOverlayReuse = 'resident-program';
        document.body.dataset.localRepaintOverlayCompileDurationMs = (
          performance.now() - compileStartedAt
        ).toFixed(1);
        document.body.dataset.localRepaintOverlayReady = '1';
        composite.gpuOverlayReady = true;
        invalidate();
        return currentOverlay;
      }

      clearLocalRepaintGpuOverlay();

      const targets: THREE.Mesh[] = [];
      model.group.traverse((child) => {
        if (!(child instanceof THREE.Mesh)) return;
        if (
          child.userData.liclickPaintOverlay ||
          child.userData.liclickViewportHelper ||
          child.userData.liclickSelectionGlow ||
          child.userData.liclickWireframeOverlay ||
          !child.geometry.getAttribute('position')
        )
          return;
        targets.push(child);
      });
      const root = new THREE.Group();
      root.name = 'Liclick Live Local Repaint GPU Overlay';
      root.userData.liclickPaintOverlay = true;
      root.userData.liclickLocalRepaintGpuOverlay = true;
      root.matrixAutoUpdate = false;
      const inverseRoot = model.group.matrixWorld.clone().invert();
      const meshes = targets.map((target) => {
        const overlay = new THREE.Mesh(target.geometry, material);
        overlay.name = `Liclick Live Local Repaint - ${target.name || target.uuid}`;
        overlay.userData.liclickPaintOverlay = true;
        overlay.userData.liclickLocalRepaintGpuOverlay = true;
        overlay.frustumCulled = target.frustumCulled;
        overlay.renderOrder = LOCAL_REPAINT_OVERLAY_RENDER_ORDER;
        overlay.matrix.copy(inverseRoot.clone().multiply(target.matrixWorld));
        overlay.matrixAutoUpdate = false;
        overlay.raycast = () => undefined;
        root.add(overlay);
        return overlay;
      });
      // Keep the live renderer layer as a stable sibling tree. Attaching it as
      // an unmanaged child of a reconciled model mesh allowed later material
      // commits to detach it even though the brush mask continued updating.
      model.group.add(root);
      // The generated overlay has its own runtime id, while the row the user
      // sees is the stable UV destination. Follow only that row's visibility:
      // ordinary projected-stack reconciliation is intentionally blocked from
      // touching this renderer-owned material, but an explicit eye click must
      // still hide both the live projection and the persisted UV result.
      // The visible first-row result owns the eye control. Its replacement
      // target is an implementation-only UV layer hidden from the panel, so
      // listening to targetLayerId would miss the user's click entirely.
      const visibilityLayerId = composite.layerId;
      let lastVisibility: boolean | undefined;
      const applyVisibility = (layerVisible: boolean) => {
        const sceneState = useSceneStore.getState();
        const layerState = useLayerStore.getState();
        const hasPersistedLayer = layerState.layers.some(
          (layer) => layer.id === composite.layerId,
        );
        const erasesPersistedLocalRepaint = isLocalRepaintLayerEraserActive(
          sceneState.paintTool,
          layerState.activeProjectedLayerId,
          composite.layerId,
          layerState.layers,
        );
        const visible = Boolean(
          composite.hasContent &&
          (sceneState.paintTool === 'inpaint-apply' ||
            erasesPersistedLocalRepaint ||
            !hasPersistedLayer) &&
          isLocalRepaintOverlayVisible(sceneState.displayMode, layerVisible),
        );
        if (visible === lastVisibility) return;
        lastVisibility = visible;
        setLocalRepaintGpuOverlayVisibility(overlayState, visible);
        invalidate();
      };
      const overlayState: LocalRepaintGpuOverlayState = {
        sourceKey,
        layerId: composite.layerId,
        visibilityLayerId,
        visibilityLayerSeen: false,
        material,
        root,
        meshes,
        unsubscribeVisibility: () => undefined,
      };
      applyVisibility(readLocalRepaintGpuOverlayLayerVisibility(overlayState));
      const unsubscribeVisibility = useLayerStore.subscribe((state) => {
        // Some high-frequency layer actions intentionally retain/mutate layer
        // objects while publishing a new array. Reading previousState after
        // that mutation can yield the *new* eye value for both snapshots and
        // suppress the notification. Compare against the renderer's own last
        // visibility in applyVisibility instead; current store state is the
        // sole authority.
        const visible = readLocalRepaintGpuOverlayLayerVisibility(overlayState, state.layers);
        applyVisibility(visible);
      });
      overlayState.unsubscribeVisibility = unsubscribeVisibility;
      localRepaintGpuOverlayRef.current = overlayState;
      syncLocalRepaintGpuOverlayActivity();
      syncProjectedLayerMaterialProjection(model.group);
      if (typeof gl.compileAsync === 'function' && targets[0]) {
        // Compile only the new overlay program. Compiling the whole live scene
        // captures unrelated background materials that SceneRoot may replace
        // while the asynchronous poll is still running.
        const compileScene = new THREE.Scene();
        const compileMesh = new THREE.Mesh(targets[0].geometry, material);
        compileScene.add(compileMesh);
        const compilePromise = gl.compileAsync(compileScene, camera);
        overlayState.compilePromise = compilePromise;
        try {
          await compilePromise;
        } finally {
          overlayState.compilePromise = undefined;
          compileScene.remove(compileMesh);
        }
      }
      if (localRepaintGpuOverlayRef.current !== overlayState) {
        disposeLocalRepaintGpuOverlay(overlayState);
        return undefined;
      }
      document.body.dataset.localRepaintOverlayReady = '1';
      composite.gpuOverlayReady = true;
      document.body.dataset.localRepaintOverlayCompileDurationMs = (
        performance.now() - compileStartedAt
      ).toFixed(1);
      invalidate();
      return overlayState;
    },
    [
      camera,
      clearLocalRepaintGpuOverlay,
      gl,
      invalidate,
      syncLocalRepaintGpuOverlayActivity,
    ],
  );

  // The target layer is bound when the user enters apply mode. Never mutate it
  // from a pointer event: doing so resets decoded assets and rebuilds materials
  // in the middle of the first stroke, which makes feedback arrive seconds late.
  const resolveLocalRepaintStrokeSource = useCallback(
    // Read at gesture start instead of closing over the render that installed a
    // benchmark/pointer handler. A source can finish GPU prewarming between two
    // renders; the first valid stroke must bind that newest source immediately.
    () => useSceneStore.getState().localRepaintProjectionSource,
    [],
  );

  useEffect(() => {
    if (!localRepaintProjectionSource || localRepaintAssetsRevision <= 0) return undefined;
    const preparedAssets = localRepaintSourceImageRef.current;
    if (
      !preparedAssets ||
      preparedAssets.url !== localRepaintProjectionSource.imageUrl ||
      preparedAssets.allowedMaskUrl !== localRepaintProjectionSource.allowedMaskUrl
    )
      return undefined;
    let cancelled = false;
    reportLocalRepaintPrewarmProgress(0.08, '读取高清生成结果');
    let timeoutId: number | undefined;
    let frameId: number | undefined;
    const waitForFrame = () =>
      new Promise<void>((resolve) => {
        frameId = window.requestAnimationFrame(() => resolve());
      });
    const prepare = async () => {
      if (cancelled) return;
      if (isPaintingRef.current || isViewportInteractionBusy()) {
        timeoutId = window.setTimeout(() => void prepare(), 80);
        return;
      }
      const waitForViewportIdle = async () => {
        while (!cancelled && (isPaintingRef.current || isViewportInteractionBusy())) {
          await waitForFrame();
        }
      };
      const model = getTargetModel();
      if (!model || !localRepaintSourceImageRef.current) return;
      const source = resolveLocalRepaintStrokeSource();
      if (!source) return;
      const startedAt = performance.now();
      const composite = ensureLiveLocalRepaintComposite(model, source);
      if (!composite) return;
      try {
        if (composite.restoredMaskPromise) await composite.restoredMaskPromise;
        if (cancelled || localRepaintCompositeRef.current !== composite) return;
        if (composite.restoredMaskUrl && !composite.hasContent) {
          throw new Error('局部重绘历史蒙版恢复失败。');
        }
        await waitForViewportIdle();
        if (cancelled) return;
        reportLocalRepaintPrewarmProgress(0.64, '上传高清颜色纹理');
        const sourceTexture = getLiveProjectedTexture(
          localRepaintSourceImageRef.current.previewImageUrl,
          THREE.SRGBColorSpace,
          { flipY: false },
        );
        // Upload immutable color and empty coverage before accepting input. The
        // first painted frame must contain only a tiny mask update, never image
        // decode, texture allocation or shader compilation.
        if (sourceTexture) gl.initTexture(sourceTexture);
        await waitForViewportIdle();
        if (cancelled) return;
        reportLocalRepaintPrewarmProgress(0.76, '上传透明 Alpha 蒙版');
        gl.initTexture(composite.maskTexture);
        await waitForFrame();
        reportLocalRepaintPrewarmProgress(0.84, '校准前后表面遮挡');
        const sourceKey = createLocalRepaintSourceKey(source, model.objectId);
        if (localRepaintRuntimeDepthRef.current?.sourceKey !== sourceKey) {
          const visibilityStartedAt = performance.now();
          const visibility = await createRuntimeProjectionDepth({
            renderer: gl,
            group: model.group,
            camera: source.camera,
            captureObjectMatrixWorld: source.objectMatrixWorld ?? model.group.matrixWorld.toArray(),
            width: composite.maskCanvas.width,
            height: composite.maskCanvas.height,
            includeNormal: true,
            waitForViewportIdle,
          });
          if (cancelled) return;
          localRepaintRuntimeDepthRef.current = {
            sourceKey,
            depthUrl: visibility.depthUrl,
            normalUrl: visibility.normalUrl,
          };
          document.body.dataset.localRepaintRuntimeDepthMs = (
            performance.now() - visibilityStartedAt
          ).toFixed(1);
          document.body.dataset.localRepaintRuntimeDepthBackend = 'exact-current-geometry';
        }
        await waitForViewportIdle();
        if (cancelled) return;
        reportLocalRepaintPrewarmProgress(0.88, '编译独立局部重绘覆盖层');
        const overlay = await ensureLocalRepaintGpuOverlay(model, source, composite);
        if (!overlay) {
          const latestSource = resolveLocalRepaintStrokeSource();
          const superseded =
            cancelled ||
            localRepaintCompositeRef.current !== composite ||
            !latestSource ||
            createLocalRepaintSourceKey(latestSource, model.objectId) !==
              createLocalRepaintSourceKey(source, model.objectId);
          // Source binding can legitimately advance while an older shader is
          // compiling (for example when S6 reuses the newest generation). The
          // newer effect owns readiness; do not surface this cancellation as a
          // GPU failure or transiently replace its progress with an error.
          if (superseded) return;
          throw new Error('局部重绘透明覆盖层未能完成。');
        }
        await waitForFrame();
        const readyOverlay = await ensureLocalRepaintGpuOverlay(model, source, composite);
        if (
          !readyOverlay ||
          readyOverlay.material.userData.liclickDisposedMaterial === true ||
          readyOverlay.root.parent !== model.group ||
          localRepaintGpuOverlayRef.current !== readyOverlay
        ) {
          throw new Error('局部重绘透明覆盖层在就绪发布前失去绑定。');
        }
        // Re-run the lightweight publication step only after the persisted mask
        // and overlay are both ready. The live overlay is already visible, so
        // SceneRoot can now mute the stored row without a blank handoff frame.
        if (ensureLiveLocalRepaintComposite(model, source) !== composite) {
          throw new Error('局部重绘图层在就绪发布前失去绑定。');
        }
        // The independent overlay is authoritative during painting. SceneRoot's
        // publication barrier already prevents a newly built background program
        // from committing while any paint tool is active. Requiring the newest
        // 15-layer build here duplicated that barrier and could hold button 3 for
        // 10-15 seconds even though a correct resident background was visible.
        // Require one valid resident background, then let the queued quality
        // upgrade publish after painting becomes idle.
        reportLocalRepaintPrewarmProgress(0.94, '稳定背景贴图材质');
        const backgroundDeadline = performance.now() + 3_000;
        let backgroundReady = false;
        while (!cancelled && performance.now() < backgroundDeadline) {
          // A valid resident background can be either a projected texture stack
          // or the ordinary display-mode material used by the clay/flat view.
          // The latter intentionally has no projectedFinalMaterialReadyUnixMs,
          // so requiring that marker rejects an otherwise ready white model.
          backgroundReady =
            Number(document.body.dataset.projectedBackgroundMaterialRevision ?? '0') > 0;
          if (backgroundReady) break;
          await waitForFrame();
        }
        if (!backgroundReady && !cancelled) {
          throw new Error('局部重绘背景贴图材质预热超时。');
        }
      } catch (error) {
        console.warn('[Liclick 3D Texture] Local repaint GPU prewarm failed:', error);
        document.body.dataset.localRepaintGpuErrorGeneration = source.generationId ?? '';
        document.body.dataset.localRepaintGpuErrorTarget = source.targetLayerId ?? '';
        reportLocalRepaintPrewarmProgress(1, '局部重绘 GPU 覆盖层准备失败，请重试', {
          done: true,
          failed: true,
        });
        return;
      }
      if (cancelled) return;
      const sceneState = useSceneStore.getState();
      const currentSource = sceneState.localRepaintProjectionSource;
      document.body.dataset.localRepaintGpuReadyGeneration = source.generationId ?? '';
      document.body.dataset.localRepaintGpuReadyTarget = source.targetLayerId ?? '';
      reportLocalRepaintPrewarmProgress(1, 'GPU 已就绪，可以立即涂抹', { done: true });
      if (
        source.autoActivate !== false &&
        sceneState.paintTool === 'none' &&
        currentSource?.generationId === source.generationId &&
        currentSource?.targetLayerId === source.targetLayerId
      ) {
        sceneState.setPaintTool('inpaint-apply');
      }
      markPerformanceEvent('local-repaint', 'gpu-source-mask-material-prewarm', {
        sourceWidth: localRepaintSourceImageRef.current.image.naturalWidth,
        sourceHeight: localRepaintSourceImageRef.current.image.naturalHeight,
        maskWidth: composite.maskCanvas.width,
        maskHeight: composite.maskCanvas.height,
        durationMs: performance.now() - startedAt,
      });
    };
    // Publish the empty lightweight projection on the very next frame. Waiting
    // for requestIdleCallback left shader/material creation until the first
    // brush gesture on busy scenes, so a valid stroke could remain invisible
    // for several frames while the projected material was being prepared.
    frameId = window.requestAnimationFrame(() => void prepare());
    return () => {
      cancelled = true;
      if (frameId !== undefined) window.cancelAnimationFrame(frameId);
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
    };
  }, [
    ensureLiveLocalRepaintComposite,
    ensureLocalRepaintGpuOverlay,
    getTargetModel,
    gl,
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
    (
      result: UvPaintHit,
      pressure = 1,
      strokePaintTool: SurfaceStrokePaintTool = paintTool,
    ) => {
      const pressureSizeScale = getPressureSizeScale(pressure);
      // Surface masks consume the projected footprint; ordinary paint consumes
      // the UV-density-aware footprint computed for the current triangle. The
      // visible brush/eraser feedback still uses the screen projection below.
      const usesSurfaceBrush =
        strokePaintTool === 'inpaint-add' ||
        strokePaintTool === 'inpaint-subtract' ||
        strokePaintTool === 'inpaint-apply' ||
        strokePaintTool === 'inpaint-apply-erase';
      const screenBrush = scaleBrushTransform(result.screenBrush, pressureSizeScale);
      const uvBrush = usesSurfaceBrush
        ? result.uvBrush
        : scaleBrushTransform(result.uvBrush, pressureSizeScale);
      // Local repaint owns its dedicated 320px live mask and does not need the
      // ordinary UV/mask painting resource bundle. Avoid even looking that
      // bundle up on the high-frequency path.
      const layer =
        strokePaintTool === 'inpaint-apply' || strokePaintTool === 'inpaint-apply-erase'
          ? undefined
          : getUvPaintLayer(result.model);
      const previousSample = lastSampleRef.current;
      const usesProjectionStroke =
        strokePaintTool === 'inpaint-add' ||
        strokePaintTool === 'inpaint-subtract' ||
        strokePaintTool === 'inpaint-apply' ||
        strokePaintTool === 'inpaint-apply-erase';
      const fromUv = usesProjectionStroke ? undefined : getStrokeSourceUv(result);
      if (!usesProjectionStroke && !fromUv && previousSample && strokeTelemetryRef.current) {
        strokeTelemetryRef.current.continuityBreaks += 1;
      }
      // Selection masks use the current viewport, while local repaint is
      // rasterized below in the generated image's capture-camera coordinates.
      const previousScreenUv = lastSampleRef.current?.screenUv;
      const fromScreenUv =
        strokePaintTool === 'inpaint-add' || strokePaintTool === 'inpaint-subtract'
          ? previousScreenUv
          : fromUv
            ? previousScreenUv
            : undefined;
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
        const eraserFeather = paintToolSettings.eraserFeather ?? 50;
        // The eraser has a direct alpha/keep-mask preview. Never reuse the
        // paint or selection overlays here: stale selection prewarm geometry
        // otherwise makes an eraser stroke look like a red striped mask.
        hideInpaintMaskPresentation(layer);
        layer.paintPreviewOverlays.forEach((overlay) => {
          overlay.visible = false;
        });
        drawSurfaceBrushSegment(
          layer.projectionContext,
          undefined,
          fromScreenUv,
          result.screenUv,
          screenBrush,
          '#ffffff',
          'source-over',
          'screen',
          eraserFeather,
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
            eraserFeather,
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
          eraserFeather,
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
            hardness: 100 - eraserFeather,
          });
        }
        if (strokeDraftRef.current?.target === 'paint') {
          strokeDraftRef.current.bounds = unionDirtyRect(strokeDraftRef.current.bounds, bounds);
        }
      } else if (strokePaintTool === 'inpaint-add') {
        if (!layer) return;
        const hitMesh = result.hit.object instanceof THREE.Mesh ? result.hit.object : undefined;
        const newlyHitMesh =
          hitMesh && !layer.currentProjectionMeshes.has(hitMesh) ? hitMesh : undefined;
        if (hitMesh) layer.currentProjectionMeshes.add(hitMesh);
        if (newlyHitMesh && !layer.directMaskReadyMeshes.has(newlyHitMesh)) {
          ensureOverlayForMesh(layer, newlyHitMesh);
        }
        const projectionBounds = drawSurfaceBrushSegment(
          layer.projectionContext,
          undefined,
          fromScreenUv,
          result.screenUv,
          screenBrush,
          '#ffffff',
          'source-over',
          'screen',
          // Selection masks are binary. A feathered alpha stamp accumulates
          // opacity wherever pointer samples overlap, producing visibly darker
          // patches inside one stroke. A solid stamp keeps every selected pixel
          // at the same value no matter how many times the brush passes over it.
          undefined,
        );
        // Pointer samples are already coalesced to one hit per display frame.
        // Publish the CanvasTexture in this same frame so pen feedback follows
        // the nib instead of waiting for a second requestAnimationFrame.
        scheduleTextureUpdate(layer.projectionTexture);
        if (strokeDraftRef.current?.target === 'mask') {
          strokeDraftRef.current.bounds = unionDirtyRect(
            strokeDraftRef.current.bounds,
            projectionBounds,
          );
        }
        maskDirtyRef.current = true;
        maskHasContentRef.current = true;
        currentProjectionHasContentRef.current = true;
        layer.accumulatedMaskMaterial.uniforms.projectionReady.value = 1;
        (layer.accumulatedMaskMaterial.uniforms.liveProjectorMatrix.value as THREE.Matrix4).copy(
          layer.maskProjectorMatrix,
        );
        (
          layer.accumulatedMaskMaterial.uniforms.liveProjectorPosition.value as THREE.Vector3
        ).setFromMatrixPosition(camera.matrixWorld);
        layer.accumulatedMaskMaterial.uniforms.liveOperation.value = layer.maskInverted ? -1 : 1;
        const usesFastScreenPreview =
          !layer.maskInverted && activateLiveInpaintScreenPreview(layer);
        if (!usesFastScreenPreview) {
          layer.accumulatedMaskOverlays.forEach((overlay) => {
            overlay.visible =
              overlay.parent instanceof THREE.Mesh &&
              !layer.directMaskReadyMeshes.has(overlay.parent) &&
              shouldRenderInpaintMaskOnMesh(layer, overlay.parent) &&
              readShouldShowInpaintMask();
          });
          layer.overlayMeshes.forEach((mesh) => {
            if (
              mesh.userData.liclickInpaintMaskOverlay &&
              !mesh.userData.liclickAccumulatedInpaintMaskOverlay
            )
              mesh.visible = false;
          });
        }
        if (document.body.dataset.perfLocalRepaintMeasuring === '1') {
          document.body.dataset.inpaintMaskLiveState = JSON.stringify({
            tool: strokePaintTool,
            textureVersion: layer.projectionTexture.version,
            overlayCount: layer.overlayMeshes.filter(
              (mesh) => mesh.userData.liclickInpaintMaskOverlay,
            ).length,
            visibleOverlayCount: layer.overlayMeshes.filter(
              (mesh) => mesh.userData.liclickInpaintMaskOverlay && mesh.visible && mesh.parent,
            ).length,
          });
        }
      } else if (strokePaintTool === 'inpaint-subtract') {
        if (!layer) return;
        deactivateLiveInpaintScreenPreview();
        const hitMesh = result.hit.object instanceof THREE.Mesh ? result.hit.object : undefined;
        const newlyHitMesh =
          hitMesh && !layer.currentProjectionMeshes.has(hitMesh) ? hitMesh : undefined;
        if (hitMesh) layer.currentProjectionMeshes.add(hitMesh);
        if (newlyHitMesh && !layer.directMaskReadyMeshes.has(newlyHitMesh)) {
          ensureOverlayForMesh(layer, newlyHitMesh);
        }
        const projectionBounds = drawSurfaceBrushSegment(
          layer.projectionContext,
          undefined,
          fromScreenUv,
          result.screenUv,
          screenBrush,
          '#ffffff',
          'source-over',
          'screen',
          // Keep subtract previews binary as well, so repeated samples never
          // create a partially erased overlap band.
          undefined,
        );
        scheduleTextureUpdate(layer.projectionTexture);
        if (strokeDraftRef.current?.target === 'mask') {
          strokeDraftRef.current.bounds = unionDirtyRect(
            strokeDraftRef.current.bounds,
            projectionBounds,
          );
        }
        maskDirtyRef.current = true;
        currentProjectionHasContentRef.current = true;
        layer.accumulatedMaskMaterial.uniforms.projectionReady.value = 1;
        (layer.accumulatedMaskMaterial.uniforms.liveProjectorMatrix.value as THREE.Matrix4).copy(
          layer.maskProjectorMatrix,
        );
        (
          layer.accumulatedMaskMaterial.uniforms.liveProjectorPosition.value as THREE.Vector3
        ).setFromMatrixPosition(camera.matrixWorld);
        layer.accumulatedMaskMaterial.uniforms.liveOperation.value = layer.maskInverted ? 1 : -1;
        layer.accumulatedMaskOverlays.forEach((overlay) => {
          overlay.visible =
            overlay.parent instanceof THREE.Mesh &&
            !layer.directMaskReadyMeshes.has(overlay.parent) &&
            shouldRenderInpaintMaskOnMesh(layer, overlay.parent) &&
            readShouldShowInpaintMask();
        });
        layer.overlayMeshes.forEach((mesh) => {
          if (
            mesh.userData.liclickInpaintMaskOverlay &&
            !mesh.userData.liclickAccumulatedInpaintMaskOverlay
          )
            mesh.visible = false;
        });
        if (document.body.dataset.perfLocalRepaintMeasuring === '1') {
          document.body.dataset.inpaintMaskLiveState = JSON.stringify({
            tool: strokePaintTool,
            textureVersion: layer.projectionTexture.version,
            overlayCount: layer.overlayMeshes.filter(
              (mesh) => mesh.userData.liclickInpaintMaskOverlay,
            ).length,
            visibleOverlayCount: layer.overlayMeshes.filter(
              (mesh) => mesh.userData.liclickInpaintMaskOverlay && mesh.visible && mesh.parent,
            ).length,
          });
        }
      } else if (
        strokePaintTool === 'inpaint-apply' ||
        strokePaintTool === 'inpaint-apply-erase'
      ) {
        const erasesLocalRepaint = strokePaintTool === 'inpaint-apply-erase';
        const draft = strokeDraftRef.current;
        const composite = draft?.localRepaintComposite;
        const surfaceFacesProjector =
          composite &&
          result.hit.object instanceof THREE.Mesh &&
          result.hit.face &&
          (Boolean(draft?.localRepaintSource?.depthUrl) ||
            isLocalRepaintSurfaceFacingProjector(
              composite,
              result.hit.object,
              result.hit.face,
              result.hit.point,
            ));
        localRepaintUv = composite
          ? projectWorldPointToLocalRepaintUv(result.hit.point, composite.worldToSourceClip)
          : undefined;
        if (
          !draft?.localRepaintSource ||
          !localRepaintSourceImageRef.current ||
          !composite ||
          (erasesLocalRepaint &&
            Boolean(composite.restoredMaskUrl) &&
            !composite.restoredMaskReady) ||
          !surfaceFacesProjector ||
          !localRepaintUv ||
          !hasLocalRepaintSourceContent(localRepaintUv)
        ) {
          lastUvRef.current = undefined;
          lastSampleRef.current = undefined;
          return;
        }
        const featherPercent = THREE.MathUtils.clamp(
          localRepaintBrushSettings.brushFeather,
          0,
          100,
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
          '#ffffff',
          'lighten',
          'screen',
          // The dedicated eraser uses its own panel value. Right-button erase
          // inside the local-repaint brush keeps that brush's feather value, so
          // each tool remains controlled by the panel currently visible.
          erasesLocalRepaint && paintTool === 'eraser'
            ? (paintToolSettings.eraserFeather ?? 50)
            : featherPercent,
        );
        if (strokeDraftRef.current?.target === 'apply-local-repaint') {
          strokeDraftRef.current.bounds = unionDirtyRect(
            strokeDraftRef.current.bounds,
            projectionBounds,
          );
          // Additive strokes are clipped by generated-content alpha. Eraser
          // strokes now preserve the selected soft edge while clearing only
          // coverage that an earlier accepted stroke could create.
          mergeLocalRepaintScratchPatch(
            composite,
            projectionBounds,
            erasesLocalRepaint ? 'erase' : 'apply',
          );
          if (!erasesLocalRepaint) composite.hasContent = true;
          // The prewarmed overlay is deliberately absent from the render list
          // while its mask is empty. Activate it only after the first accepted
          // stamp so merely entering the tool or hovering a 300k-face model
          // cannot halve camera/zoom throughput.
          syncLocalRepaintGpuOverlayActivity();
          if (isPerformanceInstrumentationEnabled()) {
            const sampleX = THREE.MathUtils.clamp(
              Math.floor(localRepaintUv.x * composite.maskCanvas.width),
              0,
              composite.maskCanvas.width - 1,
            );
            const sampleY = THREE.MathUtils.clamp(
              Math.floor(localRepaintUv.y * composite.maskCanvas.height),
              0,
              composite.maskCanvas.height - 1,
            );
            const maskPixel = composite.maskContext.getImageData(sampleX, sampleY, 1, 1).data;
            const falloffContext = composite.falloffCanvas.getContext('2d', {
              willReadFrequently: true,
            });
            const falloffPixel = falloffContext?.getImageData(sampleX, sampleY, 1, 1).data;
            document.body.dataset.localRepaintLastApply = JSON.stringify({
              uv: [localRepaintUv.x, localRepaintUv.y],
              operation: erasesLocalRepaint ? 'erase' : 'apply',
              pixel: [sampleX, sampleY],
              mask: [...maskPixel],
              falloff: falloffPixel ? [...falloffPixel] : undefined,
            });
          }
          // This mask is an interaction-only 1024px coverage texture. Upload it
          // on the same RAF as the stamp so
          // every accepted sample has immediate visual feedback. paintAt already
          // runs at most once per display frame for projected strokes, so setting
          // needsUpdate directly does not add duplicate uploads and avoids
          // scheduling the actual texture change one frame later.
          composite.maskTexture.needsUpdate = true;
          // The viewport currently renders continuously, but this explicit
          // invalidation makes realtime repaint independent of that policy and
          // closes the intermittent thumbnail-only update race.
          invalidate();
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
      activateLiveInpaintScreenPreview,
      camera,
      canConnectLocalRepaintStroke,
      deactivateLiveInpaintScreenPreview,
      drawSurfaceBrushSegment,
      ensureOverlayForMesh,
      ensurePaintPreviewOverlayForMesh,
      getStrokeSourceUv,
      getUvPaintLayer,
      hasLocalRepaintSourceContent,
      hideInpaintMaskPresentation,
      isInpaintMode,
      isLocalRepaintApplyMode,
      localRepaintBrushSettings.brushFeather,
      paintTool,
      paintToolSettings.brushHardness,
      paintToolSettings.color,
      paintToolSettings.eraserFeather,
      readShouldShowInpaintMask,
      invalidate,
      scheduleTextureUpdate,
      syncLocalRepaintGpuOverlayActivity,
    ],
  );

  const commitMaskIfDirty = useCallback(
    (forceMaskCommit = false) => {
      if (!maskDirtyRef.current) return;
      const layer = layerRef.current;
      maskDirtyRef.current = false;
      // Applying a generated repaint must not rewrite and re-encode the original
      // selection mask after every stroke. That full-canvas readback was the main
      // source of the button-3 input lag.
      if (isLocalRepaintApplyMode && !forceMaskCommit) return;
      const hasContent = Boolean(layer && maskHasContentRef.current);
      paintMaskCommitRevisionRef.current += 1;
      if (!layer || !hasContent) {
        paintMaskContentPublishedRef.current = false;
        setPaintMaskDataUrl(undefined, false);
        return;
      }
      // The live GPU/canvas mask is authoritative while drawing. Serializing the
      // full accumulated projection after every pointer-up took ~160ms on the UI
      // thread even though button 2 captures the exact mask again before submit.
      // Publish content/revision immediately and defer the lossless PNG snapshot
      // to that explicit boundary.
      document.body.dataset.localRepaintProjectionMaskEncodeBackend = 'deferred-until-button2';
      // Notify React panels only for the empty -> non-empty transition. The live
      // canvas remains authoritative, so publishing the same boolean after every
      // short stroke only makes unrelated panels reconcile on pointer-up.
      if (!paintMaskContentPublishedRef.current) {
        paintMaskContentPublishedRef.current = true;
        setPaintMaskDataUrl(undefined, true);
      }
    },
    [isLocalRepaintApplyMode, setPaintMaskDataUrl],
  );

  const beginStrokeHistory = useCallback(
    (result: UvPaintHit, strokePaintTool: SurfaceStrokePaintTool = paintTool) => {
      const target =
        strokePaintTool === 'inpaint-add' || strokePaintTool === 'inpaint-subtract'
          ? 'mask'
          : strokePaintTool === 'inpaint-apply' || strokePaintTool === 'inpaint-apply-erase'
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
        cancelIdleInpaintArchive();
        const requestedOperation = strokePaintTool === 'inpaint-subtract' ? 'subtract' : 'add';
        const nextOperation = layer.maskInverted
          ? requestedOperation === 'add'
            ? 'subtract'
            : 'add'
          : requestedOperation;
        if (
          currentProjectionHasContentRef.current &&
          currentProjectionOperationRef.current !== nextOperation
        ) {
          archiveCurrentInpaintProjection(
            layer,
            result.model,
            currentProjectionOperationRef.current,
          );
        }
        currentProjectionOperationRef.current = nextOperation;
        // Tool activation prewarms the resident material for the whole model,
        // while useFrame repairs an asynchronous material replacement. Repeating
        // that full model/binding/overlay reconciliation for every dot made
        // high-frequency short strokes pay setup cost after each pointer-down.
      }
      if (target === 'paint') {
        if (!layer) return;
        if (strokePaintTool === 'eraser') {
          beginLiveEraserPreview(layer, result.model.group);
          invalidate();
        }
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
        updateInpaintProjectionCamera(layer, camera, result.model.group);
        const previewUniforms = layer.paintPreviewMaterial.uniforms;
        (previewUniforms.previewColor.value as THREE.Color).set(
          strokePaintTool === 'eraser' ? '#ffffff' : paintToolSettings.color,
        );
        previewUniforms.previewOpacity.value = strokePaintTool === 'eraser' ? 0 : 1;
        previewUniforms.projectionReady.value = strokePaintTool === 'eraser' ? 0 : 1;
        layer.paintPreviewOverlays.forEach((overlay) => {
          overlay.visible = false;
        });
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
      archiveCurrentInpaintProjection,
      cancelIdleInpaintArchive,
      camera,
      gl.domElement,
      invalidate,
      ensureLiveLocalRepaintComposite,
      isInpaintMode,
      isLocalRepaintApplyMode,
      paintTool,
      paintToolSettings.color,
      readShouldShowInpaintMask,
      resolveLocalRepaintStrokeSource,
    ],
  );

  const handoffLocalRepaintPreview = useCallback(
    (composite: LocalRepaintCompositeState, sourceKey: string, commitRevision: number) => {
      if (localRepaintHandoffFrameRef.current !== undefined)
        window.cancelAnimationFrame(localRepaintHandoffFrameRef.current);
      const sceneStateAtCommit = useSceneStore.getState();
      const layerStateAtCommit = useLayerStore.getState();
      const previewOwnsComposite =
        sceneStateAtCommit.localRepaintPreviewLayer?.id === composite.layerId;
      const erasesPersistedLocalRepaint = isLocalRepaintLayerEraserActive(
        sceneStateAtCommit.paintTool,
        layerStateAtCommit.activeProjectedLayerId,
        composite.layerId,
        layerStateAtCommit.layers,
      );
      const keepsLiveLocalRepaintPreview =
        sceneStateAtCommit.paintTool === 'inpaint-apply' ||
        erasesPersistedLocalRepaint ||
        (previewOwnsComposite &&
          (sceneStateAtCommit.paintTool === 'inpaint-add' ||
            sceneStateAtCommit.paintTool === 'inpaint-subtract'));
      if (
        keepsLiveLocalRepaintPreview &&
        localRepaintCompositeRef.current === composite &&
        localRepaintCompositeRef.current.sourceKey === sourceKey
      ) {
        // The projected live mask remains authoritative while applying the
        // result and while editing the selection mask. Clearing it during that
        // tool switch creates a blank interval (or a permanent blank when the
        // UV patch sits below projected layers), so retain the same hot path.
        localRepaintHandoffFrameRef.current = undefined;
        return;
      }
      const startedAt = performance.now();
      const finish = () => {
        const sceneState = useSceneStore.getState();
        const layerState = useLayerStore.getState();
        const currentPreview = sceneState.localRepaintPreviewLayer;
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
          markLiveProjectedCanvasTextureUpdated(composite.maskUrl);
        }
        if (currentPreview?.id === composite.layerId) {
          const stillEditingLocalRepaintMask =
            sceneState.paintTool === 'inpaint-add' ||
            sceneState.paintTool === 'inpaint-subtract';
          const stillErasingPersistedLocalRepaint = isLocalRepaintLayerEraserActive(
            sceneState.paintTool,
            layerState.activeProjectedLayerId,
            composite.layerId,
            layerState.layers,
          );
          const keepInteractivePathWarm =
            (sceneState.paintTool === 'inpaint-apply' ||
              stillEditingLocalRepaintMask ||
              stillErasingPersistedLocalRepaint) &&
            localRepaintCompositeRef.current?.sourceKey === sourceKey;
          // Keep the now-empty renderer preview mounted between strokes. The
          // mask makes it visually inert, while retaining the prepared
          // projection material so the next stroke follows the same hot path as
          // the first one instead of recompiling after pointer-down.
          sceneState.setLocalRepaintPreviewLayer(
            keepInteractivePathWarm ? { ...currentPreview, opacity: 1 } : undefined,
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
      // A reloaded layer is never allowed to publish its live runtime canvas
      // until the durable mask has been copied into it. Otherwise one early
      // eraser gesture can replace the stored mask with an empty canvas.
      if (composite.restoredMaskUrl && !composite.restoredMaskReady) return;
      const commitRevision = localRepaintUvCommitRevisionRef.current + 1;
      localRepaintUvCommitRevisionRef.current = commitRevision;
      const queueStartedAt = performance.now();
      if (!LOCAL_REPAINT_INTERACTIVE_UV_BAKE_ENABLED) {
        const persistProjectedResult = async () => {
          const canCommit = await waitForPaintCommitIdle(
            () =>
              localRepaintUvCommitRevisionRef.current !== commitRevision ||
              localRepaintCompositeRef.current?.sourceKey !== composite.sourceKey,
          );
          if (!canCommit || isPaintingRef.current) return;
          const publishStartedAt = performance.now();
          document.body.dataset.perfLocalRepaintPhase = 's6-publish-deferred-export';
          const layerState = useLayerStore.getState();
          const currentLayers = layerState.layers;
          const existingProjectionLayer = currentLayers.find((item) =>
            isMatchingLocalRepaintProjectionLayer(item, source, model.objectId),
          );
          const previewLayer = useSceneStore.getState().localRepaintPreviewLayer;
          const runtimeDepth =
            localRepaintRuntimeDepthRef.current?.sourceKey === composite.sourceKey
              ? localRepaintRuntimeDepthRef.current.depthUrl
              : undefined;
          const persistedLayer: Layer = {
            ...(previewLayer?.id === composite.layerId ? previewLayer : existingProjectionLayer),
            id: composite.layerId,
            name: source.targetLayerName
              ? `${source.targetLayerName} · 局部替换`
              : (source.name ?? 'Local repaint brush'),
            type: 'projected',
            // Keep color and alpha as separate GPU-native assets. Building a
            // full RGBA canvas looked synchronous but Chromium deferred a
            // 70-260ms flush until its first thumbnail/readback. The renderer,
            // export and masked layer thumbnail all consume this exact pair.
            // Persist the generation-owned asset URL, never the mutable runtime
            // preview registry URL. Runtime URLs are an optimization for the
            // active GPU overlay only and must not become durable layer data.
            imageUrl: source.persistentImageUrl ?? source.imageUrl,
            maskUrl: composite.maskUrl,
            depthUrl: runtimeDepth ?? source.depthUrl,
            depthEncoding: runtimeDepth ? 'linear-view' : source.depthEncoding,
            objectId: source.objectId ?? model.objectId,
            objectMatrixWorld: source.objectMatrixWorld ?? model.group.matrixWorld.toArray(),
            camera: source.camera,
            generationId: source.generationId,
            captureId: source.captureId,
            replacementTargetLayerId: source.targetLayerId,
            localRepaintSourceUrl: source.persistentImageUrl ?? source.imageUrl,
            localRepaintMaskUrl: composite.maskUrl,
            renderedColor: false,
            minimumProjectionFacing: LOCAL_REPAINT_MINIMUM_FACE_ON,
            projectionVisibilityPolicy: 'surface-locked-v1',
            isBaked: false,
            needsRebake: true,
            visible: true,
            opacity: 1,
            strength: 1,
            blendMode: 'normal',
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
              !isMatchingLocalRepaintProjectionLayer(item, source, model.objectId),
          );
          layerState.setLayers([persistedLayer, ...retainedLayers]);
          // setLayers already selects the first visible row. EditorPage owns the
          // single layer-store -> project-store synchronization effect; doing
          // both writes again here caused two full editor/project renders on the
          // first idle frame after a stroke.
          const report: LocalRepaintUvCommitReport = {
            mode: 'deferred-export',
            revision: commitRevision,
            resolution: Math.min(UV_TEXTURE_RESOLUTION[textureResolutionSetting], 4096),
            maskSnapshotMs: 0,
            idleWaitMs: performance.now() - queueStartedAt,
            gpuBakeMs: 0,
            mergeAndPublishMs: performance.now() - publishStartedAt,
            totalMs: performance.now() - queueStartedAt,
            coveredPixels: 0,
            coverageRatio: 0,
            bakePerformanceBreakdown: {},
          };
          localRepaintLastCommitReportRef.current = report;
          markPerformanceEvent('local-repaint', 's6-uv-commit-complete', report);
        };
        // Latest-wins publication. The previous implementation appended every
        // short stroke to a Promise chain. Hundreds of dot strokes therefore
        // left hundreds of cancelled idle waits/microtasks to wake up in order,
        // culminating in multi-second main-thread stalls. Keep only the newest
        // cumulative mask request; the live canvas already contains all older
        // strokes, so publishing superseded requests has no semantic value.
        localRepaintProjectedPublishRequestRef.current = persistProjectedResult;
        if (!localRepaintProjectedPublishPumpRef.current) {
          const drainLatestProjectedPublish = async () => {
            while (localRepaintProjectedPublishRequestRef.current) {
              const publishLatest = localRepaintProjectedPublishRequestRef.current;
              localRepaintProjectedPublishRequestRef.current = undefined;
              try {
                await publishLatest();
              } catch (error) {
                console.warn(
                  '[Liclick 3D Texture] Could not persist local repaint projection:',
                  error,
                );
              }
            }
          };
          const pump = drainLatestProjectedPublish().finally(() => {
            if (localRepaintProjectedPublishPumpRef.current === pump) {
              localRepaintProjectedPublishPumpRef.current = undefined;
            }
          });
          localRepaintProjectedPublishPumpRef.current = pump;
        }
        return;
      }

      const sourceKey = composite.sourceKey;
      const previewLayerId = composite.layerId;
      const currentLayers = useLayerStore.getState().layers;
      const currentMergeLayer = currentLayers.find((item) =>
        isMatchingLocalRepaintUvMergeLayer(item, source, model.objectId),
      );
      if (
        !currentMergeLayer ||
        (currentMergeLayer.imageUrl && currentMergeLayer.role !== 'local-repaint-overlay')
      ) {
        const sceneState = useSceneStore.getState();
        sceneState.setLocalRepaintProjectionSource(undefined);
        sceneState.setPaintTool('none');
        console.warn('[Liclick 3D Texture] The internal local repaint layer is unavailable.');
        return;
      }
      const mergeLayerId = currentMergeLayer.id;
      // The mask contains only strokes that have not reached UV yet. Freeze it
      // synchronously, then keep drawing into the live canvas while this snapshot
      // is processed in the serialized background queue.
      const maskSnapshotStartedAt = performance.now();
      const maskSnapshot = copyCanvasRect(composite.maskCanvas, {
        x: 0,
        y: 0,
        width: composite.maskCanvas.width,
        height: composite.maskCanvas.height,
      });
      const maskSnapshotMs = performance.now() - maskSnapshotStartedAt;

      const commitUvStroke = async () => {
        const canCommit = await waitForPaintCommitIdle(
          () =>
            localRepaintUvCommitRevisionRef.current !== commitRevision ||
            localRepaintCompositeRef.current?.sourceKey !== sourceKey,
        );
        if (!canCommit) return;
        if (
          localRepaintUvCommitRevisionRef.current !== commitRevision ||
          localRepaintCompositeRef.current?.sourceKey !== sourceKey ||
          isPaintingRef.current
        )
          return;
        const idleWaitMs = performance.now() - queueStartedAt;

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
          depthUrl:
            localRepaintRuntimeDepthRef.current?.sourceKey === sourceKey
              ? localRepaintRuntimeDepthRef.current.depthUrl
              : source.depthUrl,
          depthEncoding:
            localRepaintRuntimeDepthRef.current?.sourceKey === sourceKey
              ? 'linear-view'
              : source.depthEncoding,
          objectId: source.objectId ?? model.objectId,
          objectMatrixWorld: source.objectMatrixWorld ?? model.group.matrixWorld.toArray(),
          camera: source.camera,
          generationId: source.generationId,
          captureId: source.captureId,
          replacementTargetLayerId: source.targetLayerId,
          renderedColor: false,
          minimumProjectionFacing: LOCAL_REPAINT_MINIMUM_FACE_ON,
          projectionVisibilityPolicy: 'surface-locked-v1',
          visible: true,
          opacity: 1,
          strength: 1,
          blendMode: 'normal',
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
        document.body.dataset.perfLocalRepaintPhase = 's6-publish-gpu-bake';
        const gpuBakeStartedAt = performance.now();
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
        const gpuBakeMs = performance.now() - gpuBakeStartedAt;
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

        document.body.dataset.perfLocalRepaintPhase = 's6-publish-merge-upload';
        const mergeAndPublishStartedAt = performance.now();
        const layerState = useLayerStore.getState();
        const latestLayers = layerState.layers;
        const existingMergeLayers = latestLayers.filter((item) =>
          isMatchingLocalRepaintUvMergeLayer(item, source, model.objectId),
        );
        const existingMergeLayer =
          existingMergeLayers.find((item) => item.id === mergeLayerId) ?? existingMergeLayers[0];
        if (!existingMergeLayer) {
          throw new Error('局部重绘目标图层已被删除，请新建并选中空白图层后重试。');
        }
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
        if (!existingMergeLayer.imageUrl) {
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
            !isMatchingLocalRepaintUvMergeLayer(item, source, model.objectId) &&
            !isMatchingLocalRepaintProjectionLayer(item, source, model.objectId),
        );
        const mergedLayer: Layer = {
          ...existingMergeLayer,
          id: mergeLayerId,
          name: existingMergeLayer.name || source.name || LOCAL_REPAINT_UV_MERGE_LAYER_NAME,
          type: 'uv',
          role: 'local-repaint-overlay',
          imageUrl: assetUrl,
          objectId: source.objectId ?? model.objectId,
          generationId: source.generationId,
          captureId: source.captureId,
          replacementTargetLayerId: source.targetLayerId,
          renderedColor: false,
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
        const mergeAndPublishMs = performance.now() - mergeAndPublishStartedAt;
        const report: LocalRepaintUvCommitReport = {
          mode: 'interactive-uv',
          revision: commitRevision,
          resolution: bakeResolution,
          maskSnapshotMs,
          idleWaitMs,
          gpuBakeMs,
          mergeAndPublishMs,
          totalMs: performance.now() - queueStartedAt,
          coveredPixels: bakeResult.report.coveredPixels,
          coverageRatio: bakeResult.report.coverageRatio,
          bakePerformanceBreakdown: bakeResult.report.performanceBreakdown ?? {},
        };
        localRepaintLastCommitReportRef.current = report;
        markPerformanceEvent('local-repaint', 's6-uv-commit-complete', report);
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
      markEraserPerformanceEvent('projected-refinement-start', {
        layerId: batch.layer.layerId,
        revision,
        strokeSnapshots: batch.snapshots.length,
      });
      const snapshots = [...batch.snapshots];
      try {
        const bakeResult = await bakeProjectedEraserStrokesToUv({
          snapshots,
          resolution: getEraserBakeResolution(batch.layer.paintCanvas),
          runtimeKey: `${batch.layer.layerId}:${revision}`,
        });
        if (!isCurrent()) return;
        const alphaBounds = await getCanvasAlphaBoundsAsync(bakeResult.canvas);
        if (!isCurrent()) return;
        await yieldProjectedEraserRefinement();
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
        let copiedBeforeTileCount = 0;
        for (const key of touchedTiles) {
          if (historyTilesByKey.has(key)) continue;
          const bounds = getPaintHistoryTileBounds(batch.layer.paintCanvas, key);
          if (!bounds) continue;
          const tile: PaintHistoryTile = {
            bounds,
            before: copyCanvasRect(batch.layer.paintCanvas, bounds),
            after: copyCanvasRect(batch.layer.paintCanvas, bounds),
          };
          historyTiles.push(tile);
          historyTilesByKey.set(key, tile);
          copiedBeforeTileCount += 1;
          if (copiedBeforeTileCount % 4 === 0) {
            await yieldProjectedEraserRefinement();
            if (!isCurrent()) return;
          }
        }

        // The interactive UV stamps have already made the eraser feel instant.
        // This single deferred projection pass only fills missed UV islands and
        // triangle seams after input has been idle.
        batch.layer.paintContext.save();
        batch.layer.paintContext.globalCompositeOperation = 'destination-out';
        batch.layer.paintContext.drawImage(
          bakeResult.canvas,
          alphaBounds.x,
          alphaBounds.y,
          alphaBounds.width,
          alphaBounds.height,
          projectedBounds.x,
          projectedBounds.y,
          projectedBounds.width,
          projectedBounds.height,
        );
        batch.layer.paintContext.restore();
        if (batch.layer.target === 'projected-mask') {
          batch.layer.paintContext.save();
          batch.layer.paintContext.globalCompositeOperation = 'destination-over';
          batch.layer.paintContext.fillStyle = '#000000';
          batch.layer.paintContext.fillRect(
            projectedBounds.x,
            projectedBounds.y,
            projectedBounds.width,
            projectedBounds.height,
          );
          batch.layer.paintContext.restore();
        }
        for (let index = 0; index < historyTiles.length; index += 1) {
          const tile = historyTiles[index];
          if (!tile) continue;
          tile.after = copyCanvasRect(batch.layer.paintCanvas, tile.bounds);
          if ((index + 1) % 4 === 0 && index + 1 < historyTiles.length) {
            await yieldProjectedEraserRefinement();
            if (!isCurrent()) return;
          }
        }
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
        measureEraserPerformanceEvent('projected-refinement-complete', startedAt, {
          layerId: batch.layer.layerId,
          revision,
          strokeSnapshots: snapshots.length,
          coveredPixels: bakeResult.report.coveredPixels,
          historyTiles: historyTiles.length,
        });
        if (isPerformanceInstrumentationEnabled()) {
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
        measureEraserPerformanceEvent('projected-refinement-error', startedAt, {
          layerId: batch.layer.layerId,
          revision,
          message: error instanceof Error ? error.message : String(error),
        });
        // The immediate UV result is already committed, so a failed refinement
        // must never block the editor or replay the same expensive task.
        console.warn('[Liclick 3D Texture] Deferred projected eraser refinement failed:', error);
      }
    },
    [],
  );

  const scheduleProjectedEraserRefinement = useCallback(
    (layer: UvPaintLayer, snapshot: ProjectedEraserSnapshot, historyTiles: PaintHistoryTile[]) => {
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
        if (
          isPaintingRef.current ||
          isViewportInteractionBusy(500) ||
          idleFor < PROJECTED_ERASER_HIGH_RES_IDLE_MS
        ) {
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
          if (isPaintingRef.current || isViewportInteractionBusy(500)) {
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
      if (
        layer &&
        !(draft?.paintOperation === 'eraser' && layer.target === 'projected-mask')
      )
        endLiveEraserPreview(layer);
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
          // Keep the projected eraser's cumulative multiplier resident for the
          // lifetime of the tool. Removing it after every pointer-up changes the
          // projected material structure and starts an asynchronous shader/
          // texture-array rebuild; the handoff exposed the white clay material
          // for a frame even though the erase itself had already committed.
          // Both the committed mask and this multiplier run on the GPU, and
          // multiplying an already-erased pixel by zero remains idempotent.
          if (!(draft.paintOperation === 'eraser' && layer.target === 'projected-mask')) {
            endLiveEraserPreview(layer);
          }
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
          layer.paintContext.fillRect(
            paintBounds.x,
            paintBounds.y,
            paintBounds.width,
            paintBounds.height,
          );
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
          // Undo/redo changes the authoritative base independently of the
          // cumulative live multiplier. Rebuild that multiplier from white on
          // the next stroke so an undone erasure cannot reappear in preview.
          layer.liveEraserPreviewInitialized = false;
          // The layer URL remains stable across strokes, so React/store updates
          // alone do not always schedule an R3F frame. Upload and invalidate the
          // resident canvas immediately or a previous stroke can appear to
          // vanish until an unrelated render happens.
          scheduleTextureUpdate(layer.paintTexture);
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
        scheduleTextureUpdate(layer.paintTexture);
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
        if (draft.paintOperation === 'eraser') {
          measureEraserPerformanceEvent('eraser-commit-complete', commitStartedAt, {
            layerId: layer.layerId,
            target: layer.target,
            backingInitializedThisCommit: !backingWasInitialized,
            historyTiles: historyTiles.length,
          });
          measureEraserNextFrame('eraser-commit-presented', commitStartedAt, {
            layerId: layer.layerId,
            target: layer.target,
          });
        }
        // The screen-space stroke plane can be withdrawn after the committed
        // texture is published. Projected erasing keeps its GPU multiplier
        // resident, so this handoff no longer changes material structure.
        finishProjectedPreview();
        if (isPerformanceInstrumentationEnabled()) {
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

      // Each accepted sample already marked the CanvasTexture for upload in the
      // paint frame. Pointer-up only advances the registry revision so a later
      // save/export cannot reuse an older encoded mask; uploading the same 1K
      // canvas again here was the repeatable short-stroke release hitch.
      markLiveProjectedCanvasTextureUpdated(composite.maskUrl, { upload: false });
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
    scheduleTextureUpdate,
  ]);

  const commitStrokeHistory = useCallback(() => {
    const draft = strokeDraftRef.current;
    strokeDraftRef.current = undefined;
    if (!draft?.bounds) return;
    if (draft.target === 'paint') return;
    if (draft.target === 'apply-local-repaint') return;
    if (!draft.layer) return;

    // The live stroke path already updates these flags. Scanning every pixel in
    // the projection canvas here was a synchronous full-resolution readback on
    // every pointer-up and caused the characteristic "画一下顿一下" pause.
    currentProjectionHasContentRef.current = true;
    maskHasContentRef.current = true;
  }, []);

  const probeLocalRepaintGpuOutput = useCallback(() => {
    const overlay = localRepaintGpuOverlayRef.current;
    if (!overlay || overlay.meshes.length === 0)
      return { visiblePixels: 0, maxAlpha: 0, sceneChangedPixels: 0, sceneMaxDelta: 0 };
    overlay.root.updateWorldMatrix(true, true);
    const probeScene = new THREE.Scene();
    const probeMeshes = overlay.meshes.map((mesh) => {
      const probeMesh = new THREE.Mesh(mesh.geometry, overlay.material);
      probeMesh.matrix.copy(mesh.matrixWorld);
      probeMesh.matrixAutoUpdate = false;
      probeMesh.frustumCulled = false;
      probeScene.add(probeMesh);
      return probeMesh;
    });
    const size = 256;
    const target = new THREE.WebGLRenderTarget(size, size, {
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      depthBuffer: true,
      stencilBuffer: false,
    });
    const previousTarget = gl.getRenderTarget();
    const previousClearColor = gl.getClearColor(new THREE.Color()).clone();
    const previousClearAlpha = gl.getClearAlpha();
    const pixels = new Uint8Array(size * size * 4);
    const sceneWithOverlay = new Uint8Array(size * size * 4);
    const sceneWithoutOverlay = new Uint8Array(size * size * 4);
    const previousOverlayVisibility = overlay.root.visible;
    try {
      gl.setRenderTarget(target);
      gl.setClearColor(0x000000, 0);
      gl.clear(true, true, false);
      gl.render(probeScene, camera);
      gl.readRenderTargetPixels(target, 0, 0, size, size, pixels);
      overlay.root.visible = true;
      gl.clear(true, true, false);
      gl.render(scene, camera);
      gl.readRenderTargetPixels(target, 0, 0, size, size, sceneWithOverlay);
      overlay.root.visible = false;
      gl.clear(true, true, false);
      gl.render(scene, camera);
      gl.readRenderTargetPixels(target, 0, 0, size, size, sceneWithoutOverlay);
    } finally {
      overlay.root.visible = previousOverlayVisibility;
      gl.setRenderTarget(previousTarget);
      gl.setClearColor(previousClearColor, previousClearAlpha);
      probeMeshes.forEach((mesh) => mesh.removeFromParent());
      target.dispose();
    }
    let visiblePixels = 0;
    let maxAlpha = 0;
    for (let offset = 3; offset < pixels.length; offset += 4) {
      const alpha = pixels[offset];
      if (alpha > 2) visiblePixels += 1;
      if (alpha > maxAlpha) maxAlpha = alpha;
    }
    let sceneChangedPixels = 0;
    let sceneMaxDelta = 0;
    for (let offset = 0; offset < sceneWithOverlay.length; offset += 4) {
      const delta = Math.max(
        Math.abs(sceneWithOverlay[offset] - sceneWithoutOverlay[offset]),
        Math.abs(sceneWithOverlay[offset + 1] - sceneWithoutOverlay[offset + 1]),
        Math.abs(sceneWithOverlay[offset + 2] - sceneWithoutOverlay[offset + 2]),
      );
      if (delta > 1) sceneChangedPixels += 1;
      if (delta > sceneMaxDelta) sceneMaxDelta = delta;
    }
    const result = { visiblePixels, maxAlpha, sceneChangedPixels, sceneMaxDelta };
    document.body.dataset.localRepaintGpuProbe = JSON.stringify(result);
    return result;
  }, [camera, gl, scene]);

  useEffect(() => {
    const target = window as typeof window & {
      LiclickPerfLocalRepaint?: LocalRepaintPerformanceApi;
    };
    const waitForFrame = () =>
      new Promise<number>((resolve) => window.requestAnimationFrame(resolve));
    const wait = (durationMs: number) =>
      new Promise<void>((resolve) => window.setTimeout(resolve, durationMs));

    target.LiclickPerfLocalRepaint = {
      run: async () => {
        const startedAt = performance.now();
        const originalPaintTool = useSceneStore.getState().paintTool;
        const originalMaskSettings = useSceneStore.getState().paintMaskSettings;
        const originalLocalRepaintBrushSettings =
          useSceneStore.getState().localRepaintBrushSettings;
        let source = useSceneStore.getState().localRepaintProjectionSource;
        let sourceImageState = localRepaintSourceImageRef.current;
        const model = getTargetModel();
        if (!model) throw new Error('S6 需要一个已加载并选中的模型。');
        const viewportControls = useSceneStore.getState().viewport?.controls;
        const originalBenchmarkCamera = {
          position: camera.position.clone(),
          quaternion: camera.quaternion.clone(),
          projectionMatrix: camera.projectionMatrix.clone(),
          projectionMatrixInverse: camera.projectionMatrixInverse.clone(),
          near: camera.near,
          far: camera.far,
          zoom: camera.zoom,
          fov: camera instanceof THREE.PerspectiveCamera ? camera.fov : undefined,
          target: viewportControls?.target.clone(),
        };
        const layerState = useLayerStore.getState();
        const belongsToModel = (layer: Layer) =>
          !layer.objectId || layer.objectId === model.objectId;
        const isValidDestination = (layer: Layer | undefined): layer is Layer =>
          Boolean(
            layer &&
            layer.type === 'uv' &&
            belongsToModel(layer) &&
            (!layer.imageUrl || layer.role === 'local-repaint-overlay'),
          );
        let activeLayer = layerState.layers.find(
          (layer) => layer.id === layerState.activeProjectedLayerId,
        );
        if (!isValidDestination(activeLayer)) {
          activeLayer = layerState.layers.find(
            (layer) => layer.id === source?.targetLayerId && isValidDestination(layer),
          );
        }
        if (!isValidDestination(activeLayer)) {
          activeLayer = layerState.layers.find(
            (layer) => isValidDestination(layer) && !layer.imageUrl,
          );
        }
        if (!isValidDestination(activeLayer)) {
          activeLayer = useLayerStore.getState().addEmptyLayer();
          useProjectStore.getState().setProjectLayers(useLayerStore.getState().layers);
        }
        useLayerStore.getState().setActiveLayer(activeLayer.id);
        // Every S6 run represents a fresh button-1 selection. Reusing the prior
        // run's projected mask archives another camera snapshot and measures
        // growing test debris rather than a normal user flow.
        useSceneStore.getState().clearPaintMask();
        await waitForFrame();
        await waitForFrame();

        let sourceWidth = 0;
        let sourceHeight = 0;
        const feedbackSamples: number[] = [];
        const initialCommitRevision = localRepaintLastCommitReportRef.current?.revision ?? 0;
        let maskAddSamples = 0;
        let maskSubtractSamples = 0;
        let maskRestoreSamples = 0;
        let button2MaskCaptureMs = 0;
        let button2MaskProjectionCount = 0;
        let button2MaskUrl = '';
        let button2InputTotalMs = 0;
        let button2InputWorkerMs = 0;
        let applySamples = 0;
        let candidateCount = 0;
        let activationStartedAt = 0;
        let activationReadyMs = 0;
        let projectedBackgroundRevisionAtReady = 0;
        let firstGeneratedCandidateScanMs = 0;
        let falloffReadMs = 0;
        let candidateRaycastMs = 0;
        let candidateFilterMs = 0;
        let gpuProbeDurationMs = 0;
        let firstApplyVisibleAt = 0;
        let gpuProbe = {
          visiblePixels: 0,
          maxAlpha: 0,
          sceneChangedPixels: 0,
          sceneMaxDelta: 0,
        };

        const scaleSimulationHit = (hit: UvPaintHit, scale = 2.15): UvPaintHit => ({
          ...hit,
          worldRadius: hit.worldRadius * scale,
          textureRadius: Math.min(INPAINT_BRUSH_MAX_TEXTURE_RADIUS, hit.textureRadius * scale),
          uvBrush: scaleBrushTransform(hit.uvBrush, scale),
          screenBrush: scaleBrushTransform(hit.screenBrush, scale),
          screenBrushRadiusPx: hit.screenBrushRadiusPx * scale,
        });

        const scanCandidates = async (requireGeneratedSource: boolean) => {
          const scanStartedAt = performance.now();
          model.group.updateMatrixWorld(true);
          const composite =
            requireGeneratedSource && source
              ? ensureLiveLocalRepaintComposite(model, source)
              : undefined;
          if (requireGeneratedSource && !composite) return [];
          const falloffContext = composite?.falloffCanvas.getContext('2d', {
            willReadFrequently: true,
          });
          const falloffReadStartedAt = performance.now();
          const falloffPixels = composite
            ? (composite.benchmarkFalloffPixels ??= falloffContext?.getImageData(
                0,
                0,
                composite.falloffCanvas.width,
                composite.falloffCanvas.height,
              ).data)
            : undefined;
          const currentFalloffReadMs = performance.now() - falloffReadStartedAt;
          falloffReadMs += currentFalloffReadMs;
          const rect = gl.domElement.getBoundingClientRect();
          const candidates: UvPaintHit[] = [];
          let currentRaycastMs = 0;
          let yieldedMs = 0;
          for (let row = 0; row < 15; row += 1) {
            for (let column = 0; column < 19; column += 1) {
              const clientX = rect.left + rect.width * (0.12 + (column / 18) * 0.76);
              const clientY = rect.top + rect.height * (0.1 + (row / 14) * 0.8);
              const raycastStartedAt = performance.now();
              const hit = raycastModel({ clientX, clientY }, rect);
              currentRaycastMs += performance.now() - raycastStartedAt;
              if (!hit || !(hit.hit.object instanceof THREE.Mesh) || !hit.hit.face) continue;
              if (!requireGeneratedSource) {
                candidates.push(scaleSimulationHit(hit));
                continue;
              }
              if (
                !composite ||
                !isLocalRepaintSurfaceFacingProjector(
                  composite,
                  hit.hit.object,
                  hit.hit.face,
                  hit.hit.point,
                )
              ) {
                continue;
              }
              const projectedUv = projectWorldPointToLocalRepaintUv(
                hit.hit.point,
                composite.worldToSourceClip,
              );
              if (!projectedUv) continue;
              const falloffX = THREE.MathUtils.clamp(
                Math.floor(projectedUv.x * composite.falloffCanvas.width),
                0,
                composite.falloffCanvas.width - 1,
              );
              const falloffY = THREE.MathUtils.clamp(
                Math.floor(projectedUv.y * composite.falloffCanvas.height),
                0,
                composite.falloffCanvas.height - 1,
              );
              const falloffOffset = (falloffY * composite.falloffCanvas.width + falloffX) * 4;
              if (
                falloffPixels &&
                Math.max(
                  falloffPixels[falloffOffset],
                  falloffPixels[falloffOffset + 1],
                  falloffPixels[falloffOffset + 2],
                  falloffPixels[falloffOffset + 3],
                ) < 12
              ) {
                continue;
              }
              candidates.push(scaleSimulationHit(hit));
            }
            // The benchmark must not manufacture its own long task while it
            // searches the model. Real users provide these points over many
            // pointer frames, so mirror that scheduling here as well.
            if ((row + 1) % 3 === 0) {
              const yieldStartedAt = performance.now();
              await waitForFrame();
              yieldedMs += performance.now() - yieldStartedAt;
            }
          }
          const currentScanMs = performance.now() - scanStartedAt - yieldedMs;
          candidateRaycastMs += currentRaycastMs;
          candidateFilterMs += Math.max(0, currentScanMs - currentRaycastMs - currentFalloffReadMs);
          if (requireGeneratedSource && firstGeneratedCandidateScanMs === 0) {
            firstGeneratedCandidateScanMs = currentScanMs;
          }
          candidateCount = Math.max(candidateCount, candidates.length);
          return candidates;
        };

        const runStroke = async (
          tool: 'inpaint-add' | 'inpaint-subtract' | 'inpaint-apply',
          hits: UvPaintHit[],
        ) => {
          if (hits.length === 0) return 0;
          const strokeStartedAt = performance.now();
          isPaintingRef.current = true;
          lastPaintActivityAtRef.current = strokeStartedAt;
          lastUvRef.current = undefined;
          lastSampleRef.current = undefined;
          lastPointerClientRef.current = undefined;
          if (tool !== 'inpaint-apply') {
            const maskLayer = syncInpaintMaskProjection(hits[0].model);
            if (!maskLayer.maskDepthReady) {
              scheduleInpaintProjectionDepth(maskLayer, hits[0].model, true);
            }
          }
          beginStrokeHistory(hits[0], tool);
          const selectionLayerAtStart = tool === 'inpaint-apply' ? undefined : layerRef.current;
          const selectionTextureVersionAtStart =
            selectionLayerAtStart?.projectionTexture.version ?? -1;
          for (const hit of hits) {
            const sampleStartedAt = performance.now();
            lastPaintActivityAtRef.current = sampleStartedAt;
            paintAt(hit, 0.82, tool);
            recordSurfacePaintPerf(performance.now() - sampleStartedAt);
            const frameAt = await waitForFrame();
            feedbackSamples.push(frameAt - sampleStartedAt);
            if (tool === 'inpaint-apply' && firstApplyVisibleAt === 0) {
              firstApplyVisibleAt = frameAt;
            }
          }
          if (tool !== 'inpaint-apply') {
            const activeSelectionLayer = layerRef.current;
            if (
              !activeSelectionLayer ||
              activeSelectionLayer.projectionTexture.version <= selectionTextureVersionAtStart
            ) {
              throw new Error(`S6 ${tool} 蒙版纹理没有随画笔输入实时递增。`);
            }
            const visibleOverlayCount = activeSelectionLayer.overlayMeshes.filter(
              (mesh) =>
                mesh.userData.liclickInpaintMaskOverlay && mesh.visible && Boolean(mesh.parent),
            ).length;
            if (visibleOverlayCount === 0) {
              throw new Error(`S6 ${tool} 蒙版纹理已更新，但模型覆盖层没有实时显示。`);
            }
          }
          if (tool === 'inpaint-apply' && localRepaintCompositeRef.current) {
            scheduleTextureUpdate(localRepaintCompositeRef.current.maskTexture);
            if (gpuProbe.visiblePixels === 0) {
              const interactionPhase = document.body.dataset.perfLocalRepaintPhase;
              document.body.dataset.perfLocalRepaintPhase = 's6-quality-gpu-probe';
              const probeStartedAt = performance.now();
              try {
                await waitForFrame();
                gpuProbe = probeLocalRepaintGpuOutput();
                // Frame telemetry is finalized by the next rAF callback. Keep
                // the quality phase active through that callback so the three
                // synchronous readbacks cannot be misreported as brush latency.
                await waitForFrame();
              } finally {
                gpuProbeDurationMs += performance.now() - probeStartedAt;
                if (interactionPhase) {
                  document.body.dataset.perfLocalRepaintPhase = interactionPhase;
                } else {
                  delete document.body.dataset.perfLocalRepaintPhase;
                }
              }
            }
          }
          isPaintingRef.current = false;
          lastPaintActivityAtRef.current = performance.now();
          lastUvRef.current = undefined;
          lastSampleRef.current = undefined;
          lastPointerClientRef.current = undefined;
          commitPaintStroke();
          commitStrokeHistory();
          if (tool !== 'inpaint-apply') commitMaskIfDirty(true);
          markPerformanceEvent('local-repaint', `s6-${tool}-stroke`, {
            samples: hits.length,
            durationMs: performance.now() - strokeStartedAt,
          });
          return hits.length;
        };

        document.body.dataset.perfSimulatedViewportInteraction = '1';
        try {
          useSceneStore.getState().setPaintMaskSettings({
            brushSize: Math.max(originalMaskSettings.brushSize, 36),
          });
          useSceneStore.getState().setLocalRepaintBrushSettings({
            brushSize: Math.max(originalLocalRepaintBrushSettings.brushSize, 36),
            brushFeather: 45,
          });
          useSceneStore.getState().setPaintTool('inpaint-add');
          document.body.dataset.perfLocalRepaintPhase = 's6-interaction-mask-add';
          await waitForFrame();
          await waitForFrame();
          const initialCandidates = await scanCandidates(false);
          if (initialCandidates.length < 8) {
            throw new Error(
              `当前相机只找到 ${initialCandidates.length} 个可重绘采样点；请把模型转回生成图片对应视角。`,
            );
          }
          const maskStartedAt = performance.now();
          const maskPath = initialCandidates.slice(0, Math.min(48, initialCandidates.length));
          maskAddSamples += await runStroke('inpaint-add', maskPath);

          useSceneStore.getState().setPaintTool('inpaint-subtract');
          document.body.dataset.perfLocalRepaintPhase = 's6-interaction-mask-subtract';
          await waitForFrame();
          const subtractPath = maskPath.slice(
            Math.floor(maskPath.length * 0.35),
            Math.max(Math.floor(maskPath.length * 0.35) + 4, Math.floor(maskPath.length * 0.62)),
          );
          maskSubtractSamples += await runStroke('inpaint-subtract', subtractPath);

          useSceneStore.getState().setPaintTool('inpaint-add');
          document.body.dataset.perfLocalRepaintPhase = 's6-interaction-mask-restore';
          await waitForFrame();
          maskRestoreSamples += await runStroke('inpaint-add', subtractPath);
          const maskDurationMs = performance.now() - maskStartedAt;

          // Button 2's local-generation path starts by freezing the accumulated
          // selection. Benchmark that exact operation without submitting an AI
          // job, so a 5-10 second browser stall cannot hide behind network time.
          document.body.dataset.perfLocalRepaintPhase = 's6-interaction-button2-mask-capture';
          await waitForFrame();
          const button2StartedAt = performance.now();
          button2MaskUrl = (await useSceneStore.getState().paintMaskCapture?.()) ?? '';
          button2MaskCaptureMs = performance.now() - button2StartedAt;
          button2MaskProjectionCount = Number(
            document.body.dataset.localRepaintButton2MaskProjectionCount ?? '0',
          );
          if (!button2MaskUrl) throw new Error('S6 按钮2没有捕获到可提交的蒙版。');
          useSceneStore.getState().setPaintMaskDataUrl(button2MaskUrl, true);
          document.body.dataset.localRepaintButton2MaskCaptureMs = button2MaskCaptureMs.toFixed(1);

          document.body.dataset.perfLocalRepaintPhase = 's6-interaction-source-bind';
          const sourceController = (
            window as typeof window & {
              LiclickPerfLocalRepaintSource?: LocalRepaintSourcePerformanceApi;
            }
          ).LiclickPerfLocalRepaintSource;
          if (!sourceController) throw new Error('S6 现成生图绑定器尚未就绪。');
          activationStartedAt = performance.now();
          await sourceController.prepareLatestGeneratedSource();
          activationReadyMs = performance.now() - activationStartedAt;
          const sourceReadyDeadline = performance.now() + 20_000;
          while (performance.now() < sourceReadyDeadline) {
            source = useSceneStore.getState().localRepaintProjectionSource;
            sourceImageState = localRepaintSourceImageRef.current;
            if (source && sourceImageState?.image) break;
            await wait(40);
          }
          if (!source || !sourceImageState?.image) {
            throw new Error('现成局部生图已绑定，但投影图片预热超时。');
          }
          projectedBackgroundRevisionAtReady = Number(
            document.body.dataset.projectedBackgroundMaterialRevision ?? '0',
          );
          sourceWidth = sourceImageState.image.naturalWidth || sourceImageState.image.width;
          sourceHeight = sourceImageState.image.naturalHeight || sourceImageState.image.height;
          document.body.dataset.perfLocalRepaintPhase = 's6-interaction-button2-input-worker';
          const button2Controller = (
            window as typeof window & {
              LiclickPerfLocalRepaintButton2?: LocalRepaintButton2PerformanceApi;
            }
          ).LiclickPerfLocalRepaintButton2;
          if (!button2Controller) throw new Error('S6 按钮2输入处理器尚未就绪。');
          const button2Input = await button2Controller.prepareInput(
            source.imageUrl,
            button2MaskUrl,
            sourceWidth,
            sourceHeight,
          );
          button2InputTotalMs = button2Input.totalMs;
          button2InputWorkerMs = button2Input.workerMs;
          document.body.dataset.perfLocalRepaintPhase = 's6-interaction-apply-prepare';
          // S6 validates the generated task in its own capture space. Depending
          // on the user's current orbit made valid depth rejection on another
          // side look like a repaint dead zone and produced non-repeatable QA.
          camera.position.fromArray(source.camera.position);
          camera.quaternion.fromArray(source.camera.quaternion);
          camera.near = source.camera.near;
          camera.far = source.camera.far;
          camera.zoom = source.camera.zoom;
          if (camera instanceof THREE.PerspectiveCamera && source.camera.fov !== undefined) {
            camera.fov = source.camera.fov;
          }
          camera.projectionMatrix.fromArray(source.camera.projectionMatrix);
          camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
          camera.updateMatrixWorld(true);
          viewportControls?.target.fromArray(source.camera.target);
          invalidate();
          await waitForFrame();
          await waitForFrame();
          const applyStartedAt = performance.now();
          const applyStrokes = 6;
          for (let strokeIndex = 0; strokeIndex < applyStrokes; strokeIndex += 1) {
            document.body.dataset.perfLocalRepaintPhase =
              strokeIndex === 0 ? 's6-interaction-apply-cold' : 's6-interaction-apply-hot';
            const candidates = await scanCandidates(true);
            if (candidates.length < 4) continue;
            const startIndex = (strokeIndex * 5) % candidates.length;
            const strokeHits = Array.from(
              { length: Math.min(10, candidates.length) },
              (_, index) => candidates[(startIndex + index) % candidates.length],
            );
            applySamples += await runStroke('inpaint-apply', strokeHits);
            await wait(70);
          }
          const applyDurationMs = performance.now() - applyStartedAt;
          if (applySamples === 0) throw new Error('现有生图在当前视角没有可应用的蒙版像素。');
          if (gpuProbe.visiblePixels === 0 || gpuProbe.maxAlpha === 0) {
            const overlay = localRepaintGpuOverlayRef.current;
            const maskMap = overlay?.material.uniforms.maskMap?.value as THREE.Texture | undefined;
            const diagnosticUniformNames = [
              'useDepthCheck',
              'useNormalCheck',
              'minimumProjectionFacing',
              'enableBackfaceCulling',
              'useMask',
            ] as const;
            const originalDiagnosticValues = overlay
              ? Object.fromEntries(
                  diagnosticUniformNames.map((name) => [
                    name,
                    overlay.material.uniforms[name]?.value,
                  ]),
                )
              : undefined;
            let relaxedVisibilityProbe: ReturnType<typeof probeLocalRepaintGpuOutput> | undefined;
            let unmaskedProbe: ReturnType<typeof probeLocalRepaintGpuOutput> | undefined;
            if (overlay && originalDiagnosticValues) {
              try {
                overlay.material.uniforms.useDepthCheck.value = 0;
                overlay.material.uniforms.useNormalCheck.value = 0;
                overlay.material.uniforms.minimumProjectionFacing.value = 0;
                overlay.material.uniforms.enableBackfaceCulling.value = 0;
                relaxedVisibilityProbe = probeLocalRepaintGpuOutput();
                overlay.material.uniforms.useMask.value = 0;
                unmaskedProbe = probeLocalRepaintGpuOutput();
              } finally {
                diagnosticUniformNames.forEach((name) => {
                  const uniform = overlay.material.uniforms[name];
                  if (uniform) uniform.value = originalDiagnosticValues[name];
                });
                invalidate();
              }
            }
            throw new Error(
              `S6 GPU 覆盖层没有输出任何可见像素。${JSON.stringify({
                applySamples,
                lastApply: document.body.dataset.localRepaintLastApply,
                overlayReady: document.body.dataset.localRepaintOverlayReady,
                rootAttached: Boolean(overlay?.root.parent),
                rootVisible: overlay?.root.visible,
                meshCount: overlay?.meshes.length ?? 0,
                visibleMeshes: overlay?.meshes.filter((mesh) => mesh.visible).length ?? 0,
                layerOpacity: overlay?.material.uniforms.layerOpacity?.value,
                maskTextureShared: maskMap === localRepaintCompositeRef.current?.maskTexture,
                maskTextureVersion: maskMap?.version,
                maskTextureSize: maskMap?.image
                  ? [maskMap.image.width ?? 0, maskMap.image.height ?? 0]
                  : undefined,
                diagnosticUniforms: originalDiagnosticValues,
                relaxedVisibilityProbe,
                unmaskedProbe,
              })}`,
            );
          }
          if (gpuProbe.sceneChangedPixels === 0 || gpuProbe.sceneMaxDelta === 0) {
            throw new Error('S6 最终模型帧在覆盖层开关前后没有像素变化。');
          }
          const projectedBackgroundRebuilds = Math.max(
            0,
            Number(document.body.dataset.projectedBackgroundMaterialRevision ?? '0') -
              projectedBackgroundRevisionAtReady,
          );
          document.body.dataset.localRepaintProjectedBackgroundRebuilds = String(
            projectedBackgroundRebuilds,
          );
          if (projectedBackgroundRebuilds > 0) {
            throw new Error(
              `S6 局部重绘期间背景投影材质被重建 ${projectedBackgroundRebuilds} 次。`,
            );
          }

          delete document.body.dataset.perfSimulatedViewportInteraction;
          document.body.dataset.perfLocalRepaintPhase = 's6-publish-idle-gate';
          markPerformanceEvent('local-repaint', 's6-interaction-complete', {
            maskAddSamples,
            maskSubtractSamples,
            maskRestoreSamples,
            applySamples,
          });
          const reportDeadline = performance.now() + 45_000;
          let uvCommit = localRepaintLastCommitReportRef.current;
          while (
            (!uvCommit || uvCommit.revision <= initialCommitRevision) &&
            performance.now() < reportDeadline
          ) {
            await wait(100);
            uvCommit = localRepaintLastCommitReportRef.current;
          }
          if (!uvCommit || uvCommit.revision <= initialCommitRevision) {
            throw new Error('S6 等待局部重绘持久化超时；请检查目标图层和控制台错误。');
          }
          // Project persistence and material reconciliation can schedule work
          // after the layer-store write has resolved. Keep the benchmark phase
          // open long enough to catch those late frames instead of reporting a
          // clean result seconds before an asynchronous upload stalls orbiting.
          document.body.dataset.perfLocalRepaintPhase = 's6-publish-settle';
          const settleDeadline = performance.now() + 4_000;
          while (performance.now() < settleDeadline) await waitForFrame();
          const sortedFeedback = [...feedbackSamples].sort((a, b) => a - b);
          const result: LocalRepaintSimulationCoreResult = {
            sourceWidth,
            sourceHeight,
            candidateCount,
            maskAddSamples,
            maskSubtractSamples,
            maskRestoreSamples,
            applyStrokes,
            applySamples,
            maskDurationMs,
            button2MaskCaptureMs,
            button2MaskProjectionCount,
            button2InputTotalMs,
            button2InputWorkerMs,
            applyDurationMs,
            activationReadyMs,
            activationToFirstVisibleMs:
              // Button 3 is clicked after the generated source is ready. Do not
              // charge button 2's worker preparation or camera restore to the
              // first brush sample; measure pointer-to-visible feedback from
              // the start of the apply interaction itself.
              firstApplyVisibleAt > 0 ? firstApplyVisibleAt - applyStartedAt : 0,
            liveFeedbackP95: percentile(sortedFeedback, 0.95),
            liveFeedbackMax: sortedFeedback.length > 0 ? Math.max(...sortedFeedback) : 0,
            gpuVisiblePixels: gpuProbe.visiblePixels,
            gpuMaxAlpha: gpuProbe.maxAlpha,
            gpuSceneChangedPixels: gpuProbe.sceneChangedPixels,
            gpuSceneMaxDelta: gpuProbe.sceneMaxDelta,
            gpuProbeDurationMs,
            projectedBackgroundRebuilds,
            firstGeneratedCandidateScanMs,
            falloffReadMs,
            candidateRaycastMs,
            candidateFilterMs,
            uvCommit,
            totalDurationMs: performance.now() - startedAt,
          };
          markPerformanceEvent('local-repaint', 's6-simulation-complete', result);
          return result;
        } finally {
          camera.position.copy(originalBenchmarkCamera.position);
          camera.quaternion.copy(originalBenchmarkCamera.quaternion);
          camera.near = originalBenchmarkCamera.near;
          camera.far = originalBenchmarkCamera.far;
          camera.zoom = originalBenchmarkCamera.zoom;
          if (
            camera instanceof THREE.PerspectiveCamera &&
            originalBenchmarkCamera.fov !== undefined
          ) {
            camera.fov = originalBenchmarkCamera.fov;
          }
          camera.projectionMatrix.copy(originalBenchmarkCamera.projectionMatrix);
          camera.projectionMatrixInverse.copy(originalBenchmarkCamera.projectionMatrixInverse);
          camera.updateMatrixWorld(true);
          if (viewportControls && originalBenchmarkCamera.target) {
            viewportControls.target.copy(originalBenchmarkCamera.target);
            viewportControls.update();
          }
          invalidate();
          delete document.body.dataset.perfSimulatedViewportInteraction;
          delete document.body.dataset.perfLocalRepaintPhase;
          useSceneStore.getState().setPaintMaskSettings(originalMaskSettings);
          useSceneStore
            .getState()
            .setLocalRepaintBrushSettings(originalLocalRepaintBrushSettings);
          useSceneStore.getState().setPaintTool(originalPaintTool);
          isPaintingRef.current = false;
          setOrbitControlsEnabled(true);
        }
      },
    };
    return () => {
      delete target.LiclickPerfLocalRepaint;
    };
  }, [
    beginStrokeHistory,
    camera,
    commitMaskIfDirty,
    commitPaintStroke,
    commitStrokeHistory,
    ensureLiveLocalRepaintComposite,
    getTargetModel,
    gl.domElement,
    invalidate,
    paintAt,
    probeLocalRepaintGpuOutput,
    raycastModel,
    resolveLocalRepaintStrokeSource,
    scheduleTextureUpdate,
    setOrbitControlsEnabled,
    scheduleInpaintProjectionDepth,
    syncInpaintMaskProjection,
  ]);

  useEffect(() => {
    const canvas = gl.domElement;
    const listenerGeneration = pointerListenerGenerationRef.current + 1;
    pointerListenerGenerationRef.current = listenerGeneration;
    const previousTouchAction = canvas.style.touchAction;
    if (enabled) canvas.style.touchAction = 'none';
    const isMaskStroke = isInpaintMode || isLocalRepaintApplyMode;
    let hoverCursorFrame = 0;
    let pendingHoverPoint: Pick<globalThis.PointerEvent, 'clientX' | 'clientY'> | undefined;
    const cancelPendingHoverCursor = () => {
      pendingHoverPoint = undefined;
      if (hoverCursorFrame === 0) return;
      window.cancelAnimationFrame(hoverCursorFrame);
      hoverCursorFrame = 0;
    };
    const scheduleHoverCursor = (event: globalThis.PointerEvent) => {
      // Raw mouse/pen streams can exceed the display refresh rate by an order
      // of magnitude. Hover feedback only needs the newest point for the next
      // presented frame; raycasting and writing SVG attributes for discarded
      // points made entering local repaint poison otherwise-cheap camera input.
      pendingHoverPoint = { clientX: event.clientX, clientY: event.clientY };
      if (hoverCursorFrame !== 0) return;
      hoverCursorFrame = window.requestAnimationFrame(() => {
        hoverCursorFrame = 0;
        const point = pendingHoverPoint;
        pendingHoverPoint = undefined;
        if (point && !isPaintingRef.current) updateCursor(point);
      });
    };
    // Both selection and generated local-repaint masks use camera projection.
    // One surface hit per frame is enough because the projected segment
    // rasterizer fills the path without touching the model UV layout.
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
      const eraserTool = eraserStrokeToolRef.current;
      const eraserStartedAt = eraserStrokeStartedAtRef.current;
      if (
        eraserStartedAt !== undefined &&
        (eraserTool === 'eraser' || eraserTool === 'inpaint-apply-erase')
      ) {
        measureEraserPerformanceEvent('eraser-stroke-end', eraserStartedAt, {
          tool: eraserTool,
          activeLayerId: activePaintLayerId,
          ...snapshot,
        });
        eraserStrokeStartedAtRef.current = undefined;
        eraserStrokeToolRef.current = undefined;
      }
      // perfLab is frequently used for high-rate manual dot tests. Logging an
      // object synchronously on every pointer-up makes the profiler itself add
      // a stop-stroke hitch. Keep detailed telemetry in memory for the recorder
      // and require an explicit opt-in for console diagnostics.
      if (isVerbosePaintLoggingEnabled()) {
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
      const batchTool = strokePaintToolRef.current;
      const isEraserBatch = batchTool === 'eraser' || batchTool === 'inpaint-apply-erase';
      lastPaintActivityAtRef.current = paintStartedAt;
      const latestResult = paintClientPath(targets);
      if (latestResult) updateCursorFromHit(latestResult);
      const batchDurationMs = performance.now() - paintStartedAt;
      recordSurfacePaintPerf(batchDurationMs);
      if (isEraserBatch) {
        measureEraserPerformanceEvent('eraser-input-batch', paintStartedAt, {
          tool: batchTool,
          activeLayerId: activePaintLayerId,
          samples: targets.length,
          hit: Boolean(latestResult),
        });
        measureEraserNextFrame('eraser-batch-presented', paintStartedAt, {
          tool: batchTool,
          activeLayerId: activePaintLayerId,
          samples: targets.length,
        });
      }
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
    const isPointerContactActive = (event: globalThis.PointerEvent) => {
      if (event.pointerType === 'pen') return event.pressure > 0 || event.buttons !== 0;
      const usesSecondaryButton =
        strokePaintToolRef.current === 'inpaint-subtract' ||
        strokePaintToolRef.current === 'inpaint-apply-erase';
      return (event.buttons & (usesSecondaryButton ? 2 : 1)) !== 0;
    };
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
        const queuedTarget = pendingPaintTargetsRef.current.at(-1);
        const finalReference = queuedTarget ?? previousClient;
        const pointerUpDistance = Math.hypot(
          event.clientX - finalReference.x,
          event.clientY - finalReference.y,
        );
        const maximumPointerUpDistance = Math.max(
          8,
          (lastSampleRef.current?.screenBrushRadiusPx ?? 8) * 1.5,
        );
        const finalPressure = queuedTarget?.pressure ?? previousClient.pressure;
        const telemetry = strokeTelemetryRef.current;
        if (telemetry) {
          telemetry.pointerEvents += 1;
          telemetry.coalescedEvents += 1;
          telemetry.minPressure = Math.min(telemetry.minPressure, finalPressure);
          telemetry.maxPressure = Math.max(telemetry.maxPressure, finalPressure);
        }
        const shouldSamplePointerUp =
          pointerUpDistance >= 0.75 && pointerUpDistance <= maximumPointerUpDistance;
        // A tap/dot ends at the already painted pointer-down coordinate. Avoid a
        // synchronous layout read on that overwhelmingly common short-stroke
        // path; only a genuinely new final sample needs the canvas boundary.
        const pointerUpInsideCanvas = shouldSamplePointerUp
          ? (() => {
              const canvasRect = canvas.getBoundingClientRect();
              return (
                event.clientX >= canvasRect.left &&
                event.clientX <= canvasRect.right &&
                event.clientY >= canvasRect.top &&
                event.clientY <= canvasRect.bottom
              );
            })()
          : false;
        flushPendingPaintTargets(
          shouldSamplePointerUp && pointerUpInsideCanvas
            ? [{ x: event.clientX, y: event.clientY, pressure: finalPressure }]
            : [],
        );
      } else {
        flushPendingPaintTargets();
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
      scheduleHoverCursor(event);
    };
    const handlePointerDown = (event: globalThis.PointerEvent) => {
      if (event.pointerType === 'touch') return;
      if (isPaintingRef.current) {
        if (tryResumeInterruptedStroke(event)) handlePointerMove(event);
        return;
      }
      if (!enabled) return;
      cancelPendingHoverCursor();
      const penEraserContact =
        event.pointerType === 'pen' &&
        (event.button === 2 || event.button === 5) &&
        event.pressure > 0;
      const rightMaskEraseContact = isInpaintMode && event.button === 2;
      const localRepaintEraseContact =
        isLocalRepaintApplyMode &&
        (event.button === 2 ||
          penEraserContact ||
          (isEditingPersistedLocalRepaint && event.button === 0));
      const isPaintButton =
        event.button === 0 ||
        penEraserContact ||
        rightMaskEraseContact ||
        localRepaintEraseContact;
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
      if (isInpaintMode) {
        cancelIdleInpaintArchive();
        const selectionLayer = syncInpaintMaskProjection(result.model);
        if (!selectionLayer.maskDepthReady) {
          // Correctness takes precedence over accepting a first dot with no
          // occlusion buffer. The pass is prewarmed, so this normally adds only
          // one synchronous render after a camera change.
          const depthCaptured = scheduleInpaintProjectionDepth(selectionLayer, result.model, true);
          if (!depthCaptured) {
            event.preventDefault();
            event.stopImmediatePropagation();
            return;
          }
        }
      }
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
        const preparedAssets = localRepaintSourceImageRef.current;
        if (
          !source ||
          preparedAssets?.url !== source.imageUrl ||
          preparedAssets.allowedMaskUrl !== source.allowedMaskUrl ||
          (isEditingPersistedLocalRepaint &&
            !isLocalRepaintSourceForLayer(source, activePaintLayer))
        )
          return;
        const preparedComposite =
          source &&
          localRepaintCompositeRef.current?.sourceKey ===
            createLocalRepaintSourceKey(source, result.model.objectId)
            ? localRepaintCompositeRef.current
            : undefined;
        const composite = source
          ? (preparedComposite ?? ensureLiveLocalRepaintComposite(result.model, source))
          : undefined;
        const overlay = localRepaintGpuOverlayRef.current;
        if (
          source &&
          composite &&
          (!composite.restoredMaskUrl || composite.restoredMaskReady) &&
          composite.gpuOverlayReady &&
          overlay?.sourceKey === createLocalRepaintSourceKey(source, result.model.objectId) &&
          overlay.layerId === composite.layerId
        ) {
          const previewImageUrl = localRepaintSourceImageRef.current?.previewImageUrl;
          const sourceTexture = previewImageUrl
            ? getLiveProjectedTexture(previewImageUrl, THREE.SRGBColorSpace, { flipY: false })
            : undefined;
          const layerVisible = readLocalRepaintGpuOverlayLayerVisibility(overlay);
          const visible = isLocalRepaintOverlayVisible(
            useSceneStore.getState().displayMode,
            layerVisible,
          );
          if (
            syncLocalRepaintGpuOverlayBinding(overlay, {
              modelGroup: result.model.group,
              sourceTexture,
              maskTexture: composite.maskTexture,
              visible,
            })
          ) {
            const repairRevision =
              Number(document.body.dataset.localRepaintOverlayRepairRevision ?? '0') + 1;
            document.body.dataset.localRepaintOverlayRepairRevision = String(repairRevision);
            invalidate();
          }
          // Atomically transfer presentation ownership only after the live
          // overlay has really become visible. Until this point SceneRoot must
          // continue rendering the persisted row restored from the project.
          if (visible) ensureLiveLocalRepaintComposite(result.model, source);
        }
        if (
          !composite ||
          (composite.restoredMaskUrl && !composite.restoredMaskReady) ||
          !composite.gpuOverlayReady
        )
          return;
        const surfaceFacesProjector =
          composite &&
          result.hit.object instanceof THREE.Mesh &&
          result.hit.face &&
          (Boolean(source?.depthUrl) ||
            isLocalRepaintSurfaceFacingProjector(
              composite,
              result.hit.object,
              result.hit.face,
              result.hit.point,
            ));
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
      const strokePaintTool: SurfaceStrokePaintTool = localRepaintEraseContact
        ? 'inpaint-apply-erase'
        : rightMaskEraseContact
          ? 'inpaint-subtract'
          : penEraserContact && (paintTool === 'brush' || paintTool === 'eraser')
            ? 'eraser'
            : paintTool;
      strokePaintToolRef.current = strokePaintTool;
      if (strokePaintTool === 'eraser' || strokePaintTool === 'inpaint-apply-erase') {
        eraserStrokeStartedAtRef.current = paintStartedAt;
        eraserStrokeToolRef.current = strokePaintTool;
        markEraserPerformanceEvent('eraser-stroke-start', {
          tool: strokePaintTool,
          activeLayerId: activePaintLayerId,
          layerToFirstStrokeMs: Math.max(0, paintStartedAt - activePaintLayerChangedAtRef.current),
          pointerType: event.pointerType,
          pressure,
        });
      }
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
      const firstInputDurationMs = performance.now() - paintStartedAt;
      recordSurfacePaintPerf(firstInputDurationMs);
      if (strokePaintTool === 'eraser' || strokePaintTool === 'inpaint-apply-erase') {
        measureEraserPerformanceEvent('eraser-first-input', paintStartedAt, {
          tool: strokePaintTool,
          activeLayerId: activePaintLayerId,
        });
        measureEraserNextFrame('eraser-first-input-presented', paintStartedAt, {
          tool: strokePaintTool,
          activeLayerId: activePaintLayerId,
        });
      }
    };
    const handlePointerUp = (event: globalThis.PointerEvent) =>
      finishPaintStroke(event, 'pointerup');
    const handlePointerCancel = (event: globalThis.PointerEvent) =>
      schedulePointerCancelRecovery(event);
    const handleLostPointerCapture = (event: globalThis.PointerEvent) =>
      schedulePointerCancelRecovery(event);
    const handlePointerLeave = () => {
      cancelPendingHoverCursor();
      cursorCircleRef.current?.setAttribute('visibility', 'hidden');
      if (!isPaintingRef.current) gl.domElement.style.cursor = '';
    };
    const handleContextMenu = (event: MouseEvent) => {
      if (isInpaintMode || isLocalRepaintApplyMode) event.preventDefault();
    };
    canvas.addEventListener('pointermove', handlePointerMove, true);
    canvas.addEventListener('pointerdown', handlePointerDown, true);
    canvas.addEventListener('contextmenu', handleContextMenu);
    window.addEventListener('pointerup', handlePointerUp, true);
    window.addEventListener('pointercancel', handlePointerCancel, true);
    canvas.addEventListener('lostpointercapture', handleLostPointerCapture);
    canvas.addEventListener('pointerleave', handlePointerLeave);
    return () => {
      canvas.removeEventListener('pointermove', handlePointerMove, true);
      canvas.removeEventListener('pointerdown', handlePointerDown, true);
      canvas.removeEventListener('contextmenu', handleContextMenu);
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
        cancelPendingHoverCursor();
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
    activePaintLayer,
    commitMaskIfDirty,
    cancelIdleInpaintArchive,
    beginStrokeHistory,
    commitPaintStroke,
    commitStrokeHistory,
    enabled,
    ensureLiveLocalRepaintComposite,
    gl,
    hasLocalRepaintSourceContent,
    invalidate,
    isEditingPersistedLocalRepaint,
    isInpaintMode,
    isLocalRepaintApplyMode,
    paintAt,
    scheduleProjectionTextureUpdate,
    scheduleIdleInpaintArchive,
    scheduleTextureUpdate,
    paintTool,
    raycastModel,
    resolveLocalRepaintStrokeSource,
    setOrbitControlsEnabled,
    scheduleInpaintProjectionDepth,
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
  importDisabled = false,
  isActive = true,
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
  const storedPerformanceTestModeEnabled = useSettingsStore(
    (state) => state.performanceTestModeEnabled,
  );
  const [queryPerformanceLabOverride] = useState<boolean | undefined>(() => {
    if (typeof window === 'undefined') return undefined;
    const queryValue = new URLSearchParams(window.location.search).get('perfLab');
    return queryValue === '1' ? true : queryValue === '0' ? false : undefined;
  });
  const performanceTestModeEnabled =
    queryPerformanceLabOverride ?? storedPerformanceTestModeEnabled;
  const [performanceAutoOrbitEnabled] = useState(
    () =>
      typeof window !== 'undefined' &&
      new URLSearchParams(window.location.search).get('perfOrbit') === '1',
  );
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
      if (!importDisabled) onImportModels(payload.modelFiles);
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
      onWheelCapture={paintTool === 'none' ? handleWheel : undefined}
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
        frameloop={isActive ? 'always' : 'never'}
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
            document.body.dataset.webglContextLost = '1';
            document.body.dataset.webglContextLostUnixMs = String(Date.now());
            const statusMessage = (event as WebGLContextEvent).statusMessage;
            if (statusMessage) document.body.dataset.webglContextLostReason = statusMessage;
            // Three already owns context restoration for this canvas. The old
            // path mounted a replacement renderer here and mounted another one
            // again on `webglcontextrestored`. Under GPU-memory pressure that
            // briefly kept multiple contexts/resources alive and could turn a
            // recoverable reset into a killed browser tab.
            if (recoveryAttemptsRef.current > 2) {
              setViewportIssue(t('viewportContextLostHelp'));
            }
          };
          const handleContextRestored = () => {
            delete document.body.dataset.webglContextLost;
            delete document.body.dataset.webglContextLostReason;
            document.body.dataset.webglContextRestoredUnixMs = String(Date.now());
            setViewportIssue(undefined);
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
          <PerformanceAutoOrbit enabled={performanceAutoOrbitEnabled} />
          <AcceleratedSceneRoot sceneOverlay={sceneOverlay} />
          <SurfacePaintOverlay />
        </Suspense>
        <CameraController />
      </Canvas>
      {performanceTestModeEnabled ? <PerformanceTestHud /> : <LightweightPerformanceHud />}
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
          disabled={importDisabled}
          className="absolute bottom-4 left-4 rounded-md border border-white/10 bg-black/42 px-3 py-2 text-xs text-white/66 backdrop-blur transition hover:bg-white/10 hover:text-white disabled:cursor-wait disabled:opacity-45"
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
