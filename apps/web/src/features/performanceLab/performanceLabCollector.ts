import {
  subscribePerformanceTimeline,
  type PerformanceTimelineEvent,
} from '@/engine/performance/performanceTimeline';

export const PERFORMANCE_LAB_REPORT_SCHEMA_VERSION = 2 as const;
export const PERFORMANCE_LAB_COLLECTOR_VERSION = '2.1.0';

const CHUNK_INTERVAL_MS = 5_000;
const MEMORY_INTERVAL_MS = 2_000;
const STRICT_FRAME_BUDGET_MS = 1_000 / 60;
const MAX_SUMMARY_FRAME_SAMPLES = 216_000;
const MAX_RESOURCE_NAME_LENGTH = 240;
const MAX_TIMELINE_EVENTS_PER_CHUNK = 2_000;
const MAX_REACT_COMMIT_SAMPLES = 50_000;
const MAX_SCRIPT_RESOURCE_SAMPLES = 50_000;

const allowedTimelineStringDetailKeys = new Set([
  'backend',
  'milestone',
  'priority',
  'profilerId',
  'reactPhase',
  'scenario',
  'status',
]);

type NumericTuple = [elapsedMs: number, durationMs: number];

type PerformanceTimelineChunkEvent = {
  elapsedMs: number;
  category: PerformanceTimelineEvent['category'];
  name: string;
  phase: PerformanceTimelineEvent['phase'];
  durationMs?: number;
  detail?: Record<string, number | string | boolean>;
};

export type PerformanceLabChunk = {
  schemaVersion: typeof PERFORMANCE_LAB_REPORT_SCHEMA_VERSION;
  collectorVersion: string;
  sessionId: string;
  sequence: number;
  startedAtUnixMs: number;
  endedAtUnixMs: number;
  frames: NumericTuple[];
  framePhases: Array<[elapsedMs: number, phase: string]>;
  longTasks: Array<[elapsedMs: number, durationMs: number, attribution: string]>;
  longAnimationFrames: Array<{
    elapsedMs: number;
    durationMs: number;
    blockingDurationMs: number;
    renderDurationMs: number;
    styleAndLayoutDurationMs: number;
    scripts: Array<{ durationMs: number; invoker?: string; sourceFunctionName?: string }>;
  }>;
  eventTimings: Array<{
    elapsedMs: number;
    name: string;
    durationMs: number;
    inputDelayMs: number;
    processingMs: number;
    presentationDelayMs: number;
    interactionId?: number;
  }>;
  inputs: Array<{
    elapsedMs: number;
    type: string;
    pointerType?: string;
    button?: number;
    pressure?: number;
    normalizedX?: number;
    normalizedY?: number;
    deltaX?: number;
    deltaY?: number;
    rawEventCount?: number;
  }>;
  layoutShifts: Array<[elapsedMs: number, value: number, hadRecentInput: boolean]>;
  resources: Array<{
    elapsedMs: number;
    name: string;
    initiatorType: string;
    durationMs: number;
    dnsMs: number;
    connectMs: number;
    requestMs: number;
    responseMs: number;
    transferSize: number;
    encodedBodySize: number;
    decodedBodySize: number;
    nextHopProtocol: string;
    responseStatus?: number;
  }>;
  memory: Array<{
    elapsedMs: number;
    usedJsHeapMb?: number;
    totalJsHeapMb?: number;
    jsHeapLimitMb?: number;
  }>;
  timelineEvents: PerformanceTimelineChunkEvent[];
  timelineEventsDropped: number;
  diagnostics: Array<[elapsedMs: number, key: string, value?: string]>;
  visibility: Array<[elapsedMs: number, state: DocumentVisibilityState]>;
  runtimeErrors: Array<[elapsedMs: number, type: 'error' | 'unhandledrejection', message: string]>;
  collectorOverheadMs: number[];
};

export type PerformanceLabClientContext = {
  schemaVersion: typeof PERFORMANCE_LAB_REPORT_SCHEMA_VERSION;
  collectorVersion: string;
  capturedAt: string;
  page: { origin: string; pathname: string; title: string };
  projectId: string;
  browser: {
    userAgent: string;
    language: string;
    languages: string[];
    platform: string;
    hardwareConcurrency?: number;
    deviceMemoryGb?: number;
    maxTouchPoints: number;
    crossOriginIsolated: boolean;
  };
  display: {
    viewportWidth: number;
    viewportHeight: number;
    screenWidth: number;
    screenHeight: number;
    colorDepth: number;
    devicePixelRatio: number;
    refreshRateHz: 'not-exposed-by-browser';
  };
  network?: {
    effectiveType?: string;
    downlinkMbps?: number;
    rttMs?: number;
    saveData?: boolean;
  };
  navigation?: Record<string, number | string>;
  webgl: ReturnType<typeof captureWebGlCapabilitySnapshot>;
  unsupportedWithoutNativeComponent: string[];
};

export type PerformanceLabSessionSummary = {
  schemaVersion: typeof PERFORMANCE_LAB_REPORT_SCHEMA_VERSION;
  collectorVersion: string;
  startedAtUnixMs: number;
  endedAtUnixMs: number;
  durationMs: number;
  chunkCount: number;
  frameCount: number;
  averageFps: number;
  frameP50Ms: number;
  frameP95Ms: number;
  frameP99Ms: number;
  frameMaximumMs: number;
  droppedFrameCount: number;
  droppedFramePercent: number;
  longTaskCount: number;
  longTaskMaximumMs: number;
  longAnimationFrameCount: number;
  eventTimingCount: number;
  resourceTimingCount: number;
  scriptResourceCount: number;
  scriptTransferBytes: number;
  scriptDecodedBodyBytes: number;
  scriptDurationP95Ms: number;
  scriptDurationMaximumMs: number;
  timelineEventCount: number;
  timelineEventDroppedCount: number;
  reactCommitCount: number;
  reactCommitTotalMs: number;
  reactCommitP95Ms: number;
  reactCommitMaximumMs: number;
  collectorOverheadP95Ms: number;
  collectorOverheadMaximumMs: number;
  summaryFrameRetentionLimit: number;
  summaryFrameSamplesRetained: number;
};

type ChunkBuffers = Omit<
  PerformanceLabChunk,
  | 'schemaVersion'
  | 'collectorVersion'
  | 'sessionId'
  | 'sequence'
  | 'startedAtUnixMs'
  | 'endedAtUnixMs'
>;

function createChunkBuffers(): ChunkBuffers {
  return {
    frames: [],
    framePhases: [],
    longTasks: [],
    longAnimationFrames: [],
    eventTimings: [],
    inputs: [],
    layoutShifts: [],
    resources: [],
    memory: [],
    timelineEvents: [],
    timelineEventsDropped: 0,
    diagnostics: [],
    visibility: [],
    runtimeErrors: [],
    collectorOverheadMs: [],
  };
}

function percentile(values: readonly number[], ratio: number) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)] ?? 0;
}

function safeFinite(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function limitedText(value: unknown, maximum = 160) {
  return typeof value === 'string' ? value.replace(/[\r\n\t]+/g, ' ').slice(0, maximum) : '';
}

export function isJavaScriptPerformanceResource(
  entry: Pick<PerformanceResourceTiming, 'initiatorType' | 'name'>,
) {
  return entry.initiatorType === 'script' || /\.m?js(?:$|[?#])/i.test(entry.name);
}

export function sanitizePerformanceTimelineDetail(detail: unknown) {
  if (!detail || typeof detail !== 'object' || Array.isArray(detail)) return undefined;
  const output: Record<string, number | string | boolean> = {};
  for (const [rawKey, value] of Object.entries(detail).slice(0, 24)) {
    const key = limitedText(rawKey, 60);
    if (
      !key ||
      /(?:prompt|text|url|path|email|token|cookie|asset|project|layer|generation)/i.test(key) ||
      (key !== 'profilerId' && /id$/i.test(key))
    ) {
      continue;
    }
    if (typeof value === 'number' && Number.isFinite(value)) output[key] = value;
    else if (typeof value === 'boolean') output[key] = value;
    else if (typeof value === 'string' && allowedTimelineStringDetailKeys.has(key)) {
      output[key] = limitedText(value, 80);
    }
  }
  return Object.keys(output).length > 0 ? output : undefined;
}

export function createPerformanceLabSessionId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `perf_${crypto.randomUUID()}`;
  }
  const bytes = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const value = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `perf_${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

export function detectAngleBackend(renderer: string) {
  const normalized = renderer.toLowerCase();
  if (normalized.includes('direct3d12') || normalized.includes('d3d12')) return 'd3d12';
  if (normalized.includes('direct3d11') || normalized.includes('d3d11')) return 'd3d11';
  if (normalized.includes('direct3d9') || normalized.includes('d3d9')) return 'd3d9';
  if (normalized.includes('vulkan')) return 'vulkan';
  if (normalized.includes('metal')) return 'metal';
  if (normalized.includes('opengl')) return 'opengl';
  return renderer ? 'unknown' : 'unavailable';
}

function generalizedPath(pathname: string) {
  return pathname
    .split('/')
    .map((segment) => {
      if (!segment) return segment;
      if (/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(segment)) return ':uuid';
      if (
        /^(project|asset|task|job|generation|revision|command|perf)[-_][a-z0-9_-]{8,}$/i.test(
          segment,
        )
      ) {
        return ':id';
      }
      if (segment.length > 80) return ':opaque';
      return segment;
    })
    .join('/');
}

export function sanitizePerformanceResourceName(rawName: string) {
  try {
    const url = new URL(rawName, window.location.href);
    const sameOrigin = url.origin === window.location.origin;
    const safePath = generalizedPath(url.pathname);
    if (sameOrigin) return safePath.slice(0, MAX_RESOURCE_NAME_LENGTH) || '/';
    const extension = /\.[a-z0-9]{1,8}$/i.exec(url.pathname)?.[0] ?? '';
    return `${url.origin}/:cross-origin-resource${extension}`.slice(0, MAX_RESOURCE_NAME_LENGTH);
  } catch {
    return ':invalid-resource';
  }
}

export function captureWebGlCapabilitySnapshot() {
  const canvas = document.querySelector('canvas');
  const context = canvas?.getContext('webgl2') as WebGL2RenderingContext | null | undefined;
  if (!context) {
    return {
      available: false as const,
      reason: 'The active viewport WebGL2 context was not available.',
      angleBackend: 'unavailable',
    };
  }
  const debugRenderer = context.getExtension('WEBGL_debug_renderer_info');
  const renderer = limitedText(
    debugRenderer
      ? context.getParameter(debugRenderer.UNMASKED_RENDERER_WEBGL)
      : context.getParameter(context.RENDERER),
    300,
  );
  const vendor = limitedText(
    debugRenderer
      ? context.getParameter(debugRenderer.UNMASKED_VENDOR_WEBGL)
      : context.getParameter(context.VENDOR),
    200,
  );
  const attributes = context.getContextAttributes();
  return {
    available: true as const,
    vendor,
    renderer,
    angleBackend: detectAngleBackend(renderer),
    version: limitedText(context.getParameter(context.VERSION), 160),
    shadingLanguageVersion: limitedText(
      context.getParameter(context.SHADING_LANGUAGE_VERSION),
      160,
    ),
    contextAttributes: attributes
      ? {
          alpha: attributes.alpha,
          antialias: attributes.antialias,
          depth: attributes.depth,
          desynchronized: attributes.desynchronized,
          failIfMajorPerformanceCaveat: attributes.failIfMajorPerformanceCaveat,
          powerPreference: attributes.powerPreference,
          premultipliedAlpha: attributes.premultipliedAlpha,
          preserveDrawingBuffer: attributes.preserveDrawingBuffer,
          stencil: attributes.stencil,
          xrCompatible: attributes.xrCompatible,
        }
      : undefined,
    limits: {
      maxTextureSize: safeFinite(context.getParameter(context.MAX_TEXTURE_SIZE)),
      maxCubeMapTextureSize: safeFinite(context.getParameter(context.MAX_CUBE_MAP_TEXTURE_SIZE)),
      maxRenderbufferSize: safeFinite(context.getParameter(context.MAX_RENDERBUFFER_SIZE)),
      maxArrayTextureLayers: safeFinite(context.getParameter(context.MAX_ARRAY_TEXTURE_LAYERS)),
      maxCombinedTextureImageUnits: safeFinite(
        context.getParameter(context.MAX_COMBINED_TEXTURE_IMAGE_UNITS),
      ),
      maxVertexTextureImageUnits: safeFinite(
        context.getParameter(context.MAX_VERTEX_TEXTURE_IMAGE_UNITS),
      ),
      maxTextureImageUnits: safeFinite(context.getParameter(context.MAX_TEXTURE_IMAGE_UNITS)),
      maxColorAttachments: safeFinite(context.getParameter(context.MAX_COLOR_ATTACHMENTS)),
      maxDrawBuffers: safeFinite(context.getParameter(context.MAX_DRAW_BUFFERS)),
      maxSamples: safeFinite(context.getParameter(context.MAX_SAMPLES)),
    },
    extensions: (context.getSupportedExtensions() ?? []).sort(),
    timerQuerySupported: Boolean(context.getExtension('EXT_disjoint_timer_query_webgl2')),
    parallelShaderCompileSupported: Boolean(context.getExtension('KHR_parallel_shader_compile')),
    debugRendererInfoAvailable: Boolean(debugRenderer),
  };
}

function navigationSnapshot() {
  const entry = performance.getEntriesByType('navigation')[0] as
    | PerformanceNavigationTiming
    | undefined;
  if (!entry) return undefined;
  return {
    type: entry.type,
    redirectMs: entry.redirectEnd - entry.redirectStart,
    dnsMs: entry.domainLookupEnd - entry.domainLookupStart,
    connectMs: entry.connectEnd - entry.connectStart,
    tlsMs: entry.secureConnectionStart > 0 ? entry.connectEnd - entry.secureConnectionStart : 0,
    requestMs: entry.responseStart - entry.requestStart,
    responseMs: entry.responseEnd - entry.responseStart,
    domInteractiveMs: entry.domInteractive,
    domContentLoadedMs: entry.domContentLoadedEventEnd,
    loadEventMs: entry.loadEventEnd,
    transferSize: entry.transferSize,
    decodedBodySize: entry.decodedBodySize,
  };
}

export function capturePerformanceLabClientContext(projectId: string): PerformanceLabClientContext {
  const navigatorWithHardware = navigator as Navigator & {
    deviceMemory?: number;
    connection?: {
      effectiveType?: string;
      downlink?: number;
      rtt?: number;
      saveData?: boolean;
    };
  };
  const connection = navigatorWithHardware.connection;
  return {
    schemaVersion: PERFORMANCE_LAB_REPORT_SCHEMA_VERSION,
    collectorVersion: PERFORMANCE_LAB_COLLECTOR_VERSION,
    capturedAt: new Date().toISOString(),
    page: {
      origin: window.location.origin,
      pathname: window.location.pathname,
      title: document.title,
    },
    projectId,
    browser: {
      userAgent: navigator.userAgent,
      language: navigator.language,
      languages: [...navigator.languages],
      platform: navigator.platform,
      hardwareConcurrency: navigator.hardwareConcurrency,
      deviceMemoryGb: navigatorWithHardware.deviceMemory,
      maxTouchPoints: navigator.maxTouchPoints,
      crossOriginIsolated: window.crossOriginIsolated,
    },
    display: {
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      screenWidth: window.screen.width,
      screenHeight: window.screen.height,
      colorDepth: window.screen.colorDepth,
      devicePixelRatio: window.devicePixelRatio,
      refreshRateHz: 'not-exposed-by-browser',
    },
    ...(connection
      ? {
          network: {
            effectiveType: connection.effectiveType,
            downlinkMbps: connection.downlink,
            rttMs: connection.rtt,
            saveData: connection.saveData,
          },
        }
      : {}),
    navigation: navigationSnapshot(),
    webgl: captureWebGlCapabilitySnapshot(),
    unsupportedWithoutNativeComponent: [
      'Windows ETW/DXGI/D3DKMT hardware queue scheduling counters',
      'system-wide client CPU utilization by core',
      'system-wide client GPU utilization, VRAM budget, temperature, and power',
      'other-process CPU/GPU contention attribution',
    ],
  };
}

function activePerformancePhase() {
  const dataset = document.body.dataset;
  return (
    dataset.perfLocalRepaintPhase ??
    dataset.perfLayerTogglePhase ??
    dataset.perfUvBakePhase ??
    dataset.perfContentAwareRepairPhase ??
    dataset.perfViewportStressPhase ??
    dataset.perfScenarioPhase ??
    'interactive'
  );
}

function isDiagnosticDatasetKey(key: string) {
  return (
    key.startsWith('perf') ||
    key.startsWith('localRepaint') ||
    key.startsWith('projected') ||
    key.startsWith('textureRestore') ||
    key.startsWith('uvComposite') ||
    key.startsWith('webgl')
  );
}

function errorMessage(value: unknown) {
  if (value instanceof Error) return limitedText(`${value.name}: ${value.message}`, 300);
  return limitedText(String(value), 300);
}

export class PerformanceLabCollector {
  private buffers = createChunkBuffers();
  private observers: PerformanceObserver[] = [];
  private disposers: Array<() => void> = [];
  private animationFrame = 0;
  private chunkTimer = 0;
  private memoryTimer = 0;
  private sequence = 0;
  private startedAtUnixMs = 0;
  private startedAtMonotonicMs = 0;
  private chunkStartedAtUnixMs = 0;
  private previousFrameAt = 0;
  private previousPhase = '';
  private frameIndex = 0;
  private totalFrameCount = 0;
  private frameDurations: number[] = [];
  private totalFrameDurationMs = 0;
  private frameMaximumMs = 0;
  private droppedFrameCount = 0;
  private longTaskCount = 0;
  private longTaskMaximumMs = 0;
  private longAnimationFrameCount = 0;
  private eventTimingCount = 0;
  private resourceTimingCount = 0;
  private scriptResourceCount = 0;
  private scriptTransferBytes = 0;
  private scriptDecodedBodyBytes = 0;
  private scriptDurations: number[] = [];
  private scriptDurationMaximumMs = 0;
  private timelineEventCount = 0;
  private timelineEventDroppedCount = 0;
  private reactCommitCount = 0;
  private reactCommitDurations: number[] = [];
  private reactCommitTotalMs = 0;
  private reactCommitMaximumMs = 0;
  private collectorOverheadSamples: number[] = [];
  private stopped = false;

  constructor(
    readonly sessionId: string,
    private readonly onChunk: (chunk: PerformanceLabChunk) => void,
  ) {}

  start() {
    this.startedAtUnixMs = Date.now();
    this.chunkStartedAtUnixMs = this.startedAtUnixMs;
    this.startedAtMonotonicMs = performance.now();
    this.previousFrameAt = this.startedAtMonotonicMs;
    this.previousPhase = activePerformancePhase();
    this.buffers.framePhases.push([0, this.previousPhase]);
    this.buffers.visibility.push([0, document.visibilityState]);
    this.installFrameSampler();
    this.installPerformanceObservers();
    this.installInputObservers();
    this.installTimelineObserver();
    this.installDiagnosticObservers();
    this.sampleMemory();
    this.memoryTimer = window.setInterval(() => this.sampleMemory(), MEMORY_INTERVAL_MS);
    this.chunkTimer = window.setInterval(() => this.flushChunk(), CHUNK_INTERVAL_MS);
    return this.startedAtUnixMs;
  }

  private elapsed(unixMs = Date.now()) {
    return Math.max(0, unixMs - this.startedAtUnixMs);
  }

  private installFrameSampler() {
    const sample = (now: number) => {
      const shouldMeasureOverhead = this.frameIndex % 60 === 0;
      const overheadStartedAt = shouldMeasureOverhead ? performance.now() : 0;
      const durationMs = now - this.previousFrameAt;
      this.previousFrameAt = now;
      if (durationMs > 0 && durationMs < 60_000) {
        this.totalFrameCount += 1;
        this.buffers.frames.push([now - this.startedAtMonotonicMs, durationMs]);
        this.totalFrameDurationMs += durationMs;
        this.frameMaximumMs = Math.max(this.frameMaximumMs, durationMs);
        if (durationMs > STRICT_FRAME_BUDGET_MS) this.droppedFrameCount += 1;
        if (this.frameDurations.length < MAX_SUMMARY_FRAME_SAMPLES) {
          this.frameDurations.push(durationMs);
        }
        const phase = activePerformancePhase();
        if (phase !== this.previousPhase) {
          this.previousPhase = phase;
          this.buffers.framePhases.push([now - this.startedAtMonotonicMs, phase]);
        }
      }
      if (shouldMeasureOverhead) {
        const overhead = performance.now() - overheadStartedAt;
        this.buffers.collectorOverheadMs.push(overhead);
        this.collectorOverheadSamples.push(overhead);
      }
      this.frameIndex += 1;
      this.animationFrame = window.requestAnimationFrame(sample);
    };
    this.animationFrame = window.requestAnimationFrame(sample);
  }

  private observe(
    type: string,
    callback: (entries: PerformanceEntryList) => void,
    options: Record<string, unknown> = {},
  ) {
    if (
      typeof PerformanceObserver === 'undefined' ||
      !PerformanceObserver.supportedEntryTypes.includes(type)
    ) {
      return;
    }
    const observer = new PerformanceObserver((list) => callback(list.getEntries()));
    try {
      observer.observe({ type, buffered: true, ...options } as PerformanceObserverInit);
      this.observers.push(observer);
    } catch {
      observer.disconnect();
    }
  }

  private installPerformanceObservers() {
    this.observe('longtask', (entries) => {
      for (const entry of entries) {
        if (entry.startTime < this.startedAtMonotonicMs) continue;
        const attribution = (
          entry as PerformanceEntry & { attribution?: Array<{ name?: string }> }
        ).attribution
          ?.map((item) => item.name)
          .filter(Boolean)
          .join(',');
        this.buffers.longTasks.push([
          entry.startTime - this.startedAtMonotonicMs,
          entry.duration,
          limitedText(attribution || 'unknown', 120),
        ]);
        this.longTaskCount += 1;
        this.longTaskMaximumMs = Math.max(this.longTaskMaximumMs, entry.duration);
      }
    });

    this.observe('long-animation-frame', (entries) => {
      for (const rawEntry of entries) {
        if (rawEntry.startTime < this.startedAtMonotonicMs || rawEntry.duration <= 20) continue;
        const entry = rawEntry as PerformanceEntry & {
          blockingDuration?: number;
          renderStart?: number;
          styleAndLayoutStart?: number;
          scripts?: Array<{ duration?: number; invoker?: string; sourceFunctionName?: string }>;
        };
        this.buffers.longAnimationFrames.push({
          elapsedMs: entry.startTime - this.startedAtMonotonicMs,
          durationMs: entry.duration,
          blockingDurationMs: entry.blockingDuration ?? 0,
          renderDurationMs:
            entry.renderStart === undefined
              ? 0
              : entry.startTime + entry.duration - entry.renderStart,
          styleAndLayoutDurationMs:
            entry.styleAndLayoutStart === undefined
              ? 0
              : entry.startTime + entry.duration - entry.styleAndLayoutStart,
          scripts: (entry.scripts ?? []).slice(0, 12).map((script) => ({
            durationMs: script.duration ?? 0,
            invoker: limitedText(script.invoker, 160) || undefined,
            sourceFunctionName: limitedText(script.sourceFunctionName, 160) || undefined,
          })),
        });
        this.longAnimationFrameCount += 1;
      }
    });

    this.observe(
      'event',
      (entries) => {
        for (const rawEntry of entries) {
          if (rawEntry.startTime < this.startedAtMonotonicMs || rawEntry.duration < 8) continue;
          const entry = rawEntry as PerformanceEntry & {
            processingStart?: number;
            processingEnd?: number;
            interactionId?: number;
          };
          const processingStart = entry.processingStart ?? entry.startTime;
          const processingEnd = entry.processingEnd ?? processingStart;
          this.buffers.eventTimings.push({
            elapsedMs: entry.startTime - this.startedAtMonotonicMs,
            name: limitedText(entry.name, 80),
            durationMs: entry.duration,
            inputDelayMs: Math.max(0, processingStart - entry.startTime),
            processingMs: Math.max(0, processingEnd - processingStart),
            presentationDelayMs: Math.max(0, entry.startTime + entry.duration - processingEnd),
            interactionId: entry.interactionId,
          });
          this.eventTimingCount += 1;
        }
      },
      { durationThreshold: 8 },
    );

    this.observe('layout-shift', (entries) => {
      for (const rawEntry of entries) {
        if (rawEntry.startTime < this.startedAtMonotonicMs) continue;
        const entry = rawEntry as PerformanceEntry & { value?: number; hadRecentInput?: boolean };
        this.buffers.layoutShifts.push([
          entry.startTime - this.startedAtMonotonicMs,
          entry.value ?? 0,
          entry.hadRecentInput ?? false,
        ]);
      }
    });

    this.observe('resource', (entries) => {
      for (const rawEntry of entries) {
        if (rawEntry.startTime < this.startedAtMonotonicMs) continue;
        const entry = rawEntry as PerformanceResourceTiming & { responseStatus?: number };
        this.buffers.resources.push({
          elapsedMs: entry.startTime - this.startedAtMonotonicMs,
          name: sanitizePerformanceResourceName(entry.name),
          initiatorType: limitedText(entry.initiatorType, 40),
          durationMs: entry.duration,
          dnsMs: Math.max(0, entry.domainLookupEnd - entry.domainLookupStart),
          connectMs: Math.max(0, entry.connectEnd - entry.connectStart),
          requestMs: Math.max(0, entry.responseStart - entry.requestStart),
          responseMs: Math.max(0, entry.responseEnd - entry.responseStart),
          transferSize: entry.transferSize,
          encodedBodySize: entry.encodedBodySize,
          decodedBodySize: entry.decodedBodySize,
          nextHopProtocol: limitedText(entry.nextHopProtocol, 40),
          responseStatus: entry.responseStatus,
        });
        this.resourceTimingCount += 1;
        if (isJavaScriptPerformanceResource(entry)) {
          this.scriptResourceCount += 1;
          this.scriptTransferBytes += safeFinite(entry.transferSize);
          this.scriptDecodedBodyBytes += safeFinite(entry.decodedBodySize);
          this.scriptDurationMaximumMs = Math.max(this.scriptDurationMaximumMs, entry.duration);
          if (this.scriptDurations.length < MAX_SCRIPT_RESOURCE_SAMPLES) {
            this.scriptDurations.push(entry.duration);
          }
        }
      }
    });
  }

  private installInputObservers() {
    const position = (event: PointerEvent) => ({
      normalizedX: window.innerWidth > 0 ? event.clientX / window.innerWidth : 0,
      normalizedY: window.innerHeight > 0 ? event.clientY / window.innerHeight : 0,
    });
    const onPointer = (event: PointerEvent) => {
      this.buffers.inputs.push({
        elapsedMs: this.elapsed(),
        type: event.type,
        pointerType: limitedText(event.pointerType, 24),
        button: event.button,
        pressure: event.pressure,
        ...position(event),
      });
    };
    let wheelFrame = 0;
    let wheelSample: { deltaX: number; deltaY: number; rawEventCount: number } | undefined;
    const onWheel = (event: WheelEvent) => {
      if (wheelSample) {
        wheelSample.deltaX += event.deltaX;
        wheelSample.deltaY += event.deltaY;
        wheelSample.rawEventCount += 1;
      } else {
        wheelSample = { deltaX: event.deltaX, deltaY: event.deltaY, rawEventCount: 1 };
      }
      if (wheelFrame) return;
      wheelFrame = window.requestAnimationFrame(() => {
        wheelFrame = 0;
        if (!wheelSample) return;
        this.buffers.inputs.push({ elapsedMs: this.elapsed(), type: 'wheel', ...wheelSample });
        wheelSample = undefined;
      });
    };
    window.addEventListener('pointerdown', onPointer, { capture: true, passive: true });
    window.addEventListener('pointerup', onPointer, { capture: true, passive: true });
    window.addEventListener('wheel', onWheel, { capture: true, passive: true });
    this.disposers.push(() => {
      window.removeEventListener('pointerdown', onPointer, true);
      window.removeEventListener('pointerup', onPointer, true);
      window.removeEventListener('wheel', onWheel, true);
      if (wheelFrame) window.cancelAnimationFrame(wheelFrame);
    });
  }

  private installTimelineObserver() {
    this.disposers.push(
      subscribePerformanceTimeline((event) => {
        if (event.monotonicMs < this.startedAtMonotonicMs) return;
        this.timelineEventCount += 1;
        if (event.category === 'react' && event.name === 'react-commit') {
          const durationMs = event.detail?.actualDurationMs;
          if (typeof durationMs === 'number' && Number.isFinite(durationMs)) {
            this.reactCommitCount += 1;
            this.reactCommitTotalMs += durationMs;
            this.reactCommitMaximumMs = Math.max(this.reactCommitMaximumMs, durationMs);
            if (this.reactCommitDurations.length < MAX_REACT_COMMIT_SAMPLES) {
              this.reactCommitDurations.push(durationMs);
            }
          }
        }
        if (this.buffers.timelineEvents.length >= MAX_TIMELINE_EVENTS_PER_CHUNK) {
          this.buffers.timelineEventsDropped += 1;
          this.timelineEventDroppedCount += 1;
          return;
        }
        this.buffers.timelineEvents.push({
          elapsedMs: event.monotonicMs - this.startedAtMonotonicMs,
          category: event.category,
          name: limitedText(event.name, 120),
          phase: event.phase,
          durationMs: event.durationMs,
          detail: sanitizePerformanceTimelineDetail(event.detail),
        });
      }),
    );
  }

  private installDiagnosticObservers() {
    const bodyObserver = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        const attributeName = mutation.attributeName;
        if (!attributeName?.startsWith('data-')) continue;
        const key = attributeName
          .slice(5)
          .replace(/-([a-z])/g, (_match, character: string) => character.toUpperCase());
        if (!isDiagnosticDatasetKey(key)) continue;
        this.buffers.diagnostics.push([
          this.elapsed(),
          key,
          limitedText(document.body.dataset[key], 500) || undefined,
        ]);
      }
    });
    bodyObserver.observe(document.body, { attributes: true });
    const onVisibility = () =>
      this.buffers.visibility.push([this.elapsed(), document.visibilityState]);
    const onError = (event: ErrorEvent) =>
      this.buffers.runtimeErrors.push([
        this.elapsed(),
        'error',
        errorMessage(event.error ?? event.message),
      ]);
    const onUnhandledRejection = (event: PromiseRejectionEvent) =>
      this.buffers.runtimeErrors.push([
        this.elapsed(),
        'unhandledrejection',
        errorMessage(event.reason),
      ]);
    const canvas = document.querySelector('canvas');
    const onContextLost = () =>
      this.buffers.diagnostics.push([this.elapsed(), 'webglContextLost', '1']);
    const onContextRestored = () =>
      this.buffers.diagnostics.push([this.elapsed(), 'webglContextRestored', '1']);
    document.addEventListener('visibilitychange', onVisibility, { passive: true });
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onUnhandledRejection);
    canvas?.addEventListener('webglcontextlost', onContextLost);
    canvas?.addEventListener('webglcontextrestored', onContextRestored);
    this.disposers.push(() => {
      bodyObserver.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onUnhandledRejection);
      canvas?.removeEventListener('webglcontextlost', onContextLost);
      canvas?.removeEventListener('webglcontextrestored', onContextRestored);
    });
  }

  private sampleMemory() {
    const memory = (
      performance as Performance & {
        memory?: {
          usedJSHeapSize?: number;
          totalJSHeapSize?: number;
          jsHeapSizeLimit?: number;
        };
      }
    ).memory;
    this.buffers.memory.push({
      elapsedMs: this.elapsed(),
      usedJsHeapMb:
        memory?.usedJSHeapSize === undefined ? undefined : memory.usedJSHeapSize / 1024 / 1024,
      totalJsHeapMb:
        memory?.totalJSHeapSize === undefined ? undefined : memory.totalJSHeapSize / 1024 / 1024,
      jsHeapLimitMb:
        memory?.jsHeapSizeLimit === undefined ? undefined : memory.jsHeapSizeLimit / 1024 / 1024,
    });
  }

  private flushChunk() {
    if (this.stopped) return;
    const endedAtUnixMs = Date.now();
    const buffers = this.buffers;
    this.buffers = createChunkBuffers();
    const sampleCount =
      buffers.frames.length +
      buffers.longTasks.length +
      buffers.longAnimationFrames.length +
      buffers.eventTimings.length +
      buffers.inputs.length +
      buffers.resources.length +
      buffers.timelineEvents.length;
    if (sampleCount === 0 && buffers.diagnostics.length === 0 && buffers.memory.length === 0) {
      this.chunkStartedAtUnixMs = endedAtUnixMs;
      return;
    }
    this.onChunk({
      schemaVersion: PERFORMANCE_LAB_REPORT_SCHEMA_VERSION,
      collectorVersion: PERFORMANCE_LAB_COLLECTOR_VERSION,
      sessionId: this.sessionId,
      sequence: this.sequence++,
      startedAtUnixMs: this.chunkStartedAtUnixMs,
      endedAtUnixMs,
      ...buffers,
    });
    this.chunkStartedAtUnixMs = endedAtUnixMs;
  }

  stop(): PerformanceLabSessionSummary {
    if (this.stopped) throw new Error('Performance recording has already ended.');
    window.cancelAnimationFrame(this.animationFrame);
    window.clearInterval(this.chunkTimer);
    window.clearInterval(this.memoryTimer);
    this.observers.forEach((observer) => observer.disconnect());
    this.disposers.forEach((dispose) => dispose());
    this.sampleMemory();
    this.flushChunk();
    this.stopped = true;
    const endedAtUnixMs = Date.now();
    const frameCount = this.totalFrameCount;
    return {
      schemaVersion: PERFORMANCE_LAB_REPORT_SCHEMA_VERSION,
      collectorVersion: PERFORMANCE_LAB_COLLECTOR_VERSION,
      startedAtUnixMs: this.startedAtUnixMs,
      endedAtUnixMs,
      durationMs: Math.max(0, endedAtUnixMs - this.startedAtUnixMs),
      chunkCount: this.sequence,
      frameCount,
      averageFps:
        this.totalFrameDurationMs > 0 ? (frameCount * 1_000) / this.totalFrameDurationMs : 0,
      frameP50Ms: percentile(this.frameDurations, 0.5),
      frameP95Ms: percentile(this.frameDurations, 0.95),
      frameP99Ms: percentile(this.frameDurations, 0.99),
      frameMaximumMs: this.frameMaximumMs,
      droppedFrameCount: this.droppedFrameCount,
      droppedFramePercent: frameCount > 0 ? (this.droppedFrameCount / frameCount) * 100 : 0,
      longTaskCount: this.longTaskCount,
      longTaskMaximumMs: this.longTaskMaximumMs,
      longAnimationFrameCount: this.longAnimationFrameCount,
      eventTimingCount: this.eventTimingCount,
      resourceTimingCount: this.resourceTimingCount,
      scriptResourceCount: this.scriptResourceCount,
      scriptTransferBytes: this.scriptTransferBytes,
      scriptDecodedBodyBytes: this.scriptDecodedBodyBytes,
      scriptDurationP95Ms: percentile(this.scriptDurations, 0.95),
      scriptDurationMaximumMs: this.scriptDurationMaximumMs,
      timelineEventCount: this.timelineEventCount,
      timelineEventDroppedCount: this.timelineEventDroppedCount,
      reactCommitCount: this.reactCommitCount,
      reactCommitTotalMs: this.reactCommitTotalMs,
      reactCommitP95Ms: percentile(this.reactCommitDurations, 0.95),
      reactCommitMaximumMs: this.reactCommitMaximumMs,
      collectorOverheadP95Ms: percentile(this.collectorOverheadSamples, 0.95),
      collectorOverheadMaximumMs:
        this.collectorOverheadSamples.length > 0 ? Math.max(...this.collectorOverheadSamples) : 0,
      summaryFrameRetentionLimit: MAX_SUMMARY_FRAME_SAMPLES,
      summaryFrameSamplesRetained: this.frameDurations.length,
    };
  }
}
