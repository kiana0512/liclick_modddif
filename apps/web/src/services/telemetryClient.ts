import packageMetadata from '../../package.json';
import { createEventId, getClientIdentity } from './clientIdentity';
import { getWorkspaceApiBase } from './workspaceApiBase';

const workspaceApiBase = getWorkspaceApiBase(import.meta.env.VITE_LICLICK_WORKSPACE_API);
const queueStorageKey = 'li3d.telemetry.queue.v1';
const maxQueueSize = 200;
const batchSize = 20;
const sendTimeoutMs = 8_000;
const uuidPattern = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const eventIdPattern = new RegExp(`^evt_${uuidPattern}$`, 'i');
const machineIdPattern = new RegExp(`^machine_${uuidPattern}$`, 'i');
const installIdPattern = new RegExp(`^install_${uuidPattern}$`, 'i');
const sessionIdPattern = new RegExp(`^sess_${uuidPattern}$`, 'i');

export const homeTelemetryModules = [
  'texture_painting',
  'model_baking',
  'toolbox',
  'auto_retopology',
  'auto_uv',
] as const;

export type HomeTelemetryModule = (typeof homeTelemetryModules)[number];

type ModuleActionEvent = {
  event_id: string;
  event_type: 'module_action';
  ts: string;
  machine_id: string;
  install_id: string;
  session_id: string;
  version: string;
  host_version: 'browser';
  data: {
    module: HomeTelemetryModule;
    action: 'open';
  };
};

let memoryQueue: ModuleActionEvent[] = [];
let flushTimer: number | undefined;
let retryAttempt = 0;
let activeFlush: Promise<void> | undefined;
let initialized = false;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isModuleActionEvent(value: unknown): value is ModuleActionEvent {
  if (!isRecord(value) || !isRecord(value.data)) return false;
  const dataKeys = Object.keys(value.data);
  return (
    typeof value.event_id === 'string' &&
    eventIdPattern.test(value.event_id) &&
    value.event_type === 'module_action' &&
    typeof value.ts === 'string' &&
    !Number.isNaN(Date.parse(value.ts)) &&
    typeof value.machine_id === 'string' &&
    machineIdPattern.test(value.machine_id) &&
    typeof value.install_id === 'string' &&
    installIdPattern.test(value.install_id) &&
    typeof value.session_id === 'string' &&
    sessionIdPattern.test(value.session_id) &&
    typeof value.version === 'string' &&
    value.host_version === 'browser' &&
    dataKeys.length === 2 &&
    dataKeys.every((key) => key === 'module' || key === 'action') &&
    homeTelemetryModules.includes(value.data.module as HomeTelemetryModule) &&
    value.data.action === 'open'
  );
}

function deduplicateAndLimit(events: ModuleActionEvent[]) {
  const byId = new Map<string, ModuleActionEvent>();
  for (const event of events) byId.set(event.event_id, event);
  return [...byId.values()].slice(-maxQueueSize);
}

function readQueue() {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(queueStorageKey) ?? '[]') as unknown;
    if (!Array.isArray(parsed)) return memoryQueue;
    memoryQueue = deduplicateAndLimit(parsed.filter(isModuleActionEvent));
  } catch {
    // Restricted storage falls back to an in-memory queue for this page.
  }
  return memoryQueue;
}

function writeQueue(events: ModuleActionEvent[]) {
  memoryQueue = deduplicateAndLimit(events);
  try {
    window.localStorage.setItem(queueStorageKey, JSON.stringify(memoryQueue));
  } catch {
    // Telemetry must never block the product when storage is unavailable.
  }
}

function removeEvents(eventIds: Set<string>) {
  writeQueue(readQueue().filter((event) => !eventIds.has(event.event_id)));
}

function scheduleFlush(delayMs: number) {
  if (flushTimer !== undefined) window.clearTimeout(flushTimer);
  flushTimer = window.setTimeout(() => {
    flushTimer = undefined;
    void flushTelemetry();
  }, delayMs);
}

function retryDelayMs() {
  const exponential = Math.min(60_000, 1_000 * 2 ** Math.min(retryAttempt, 6));
  return exponential + Math.floor(Math.random() * 500);
}

async function sendBatch(events: ModuleActionEvent[], keepalive: boolean) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), sendTimeoutMs);
  try {
    const response = await fetch(`${workspaceApiBase}/api/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ events }),
      keepalive,
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Event upload failed: ${response.status}`);
  } finally {
    window.clearTimeout(timeout);
  }
}

export function flushTelemetry(options: { keepalive?: boolean } = {}) {
  if (activeFlush) return activeFlush;
  activeFlush = (async () => {
    if (!navigator.onLine) {
      retryAttempt += 1;
      scheduleFlush(retryDelayMs());
      return;
    }
    const batch = readQueue().slice(0, batchSize);
    if (batch.length === 0) {
      retryAttempt = 0;
      return;
    }
    try {
      await sendBatch(batch, options.keepalive === true);
      removeEvents(new Set(batch.map((event) => event.event_id)));
      retryAttempt = 0;
      if (readQueue().length > 0) scheduleFlush(50);
    } catch {
      // Keep the exact same event IDs in the durable queue so retries are
      // idempotent on the server.
      retryAttempt += 1;
      scheduleFlush(retryDelayMs());
    }
  })().finally(() => {
    activeFlush = undefined;
  });
  return activeFlush;
}

export function trackHomeModuleEntry(module: HomeTelemetryModule) {
  const identity = getClientIdentity();
  const event: ModuleActionEvent = {
    event_id: createEventId(),
    event_type: 'module_action',
    ts: new Date().toISOString(),
    ...identity,
    version: packageMetadata.version,
    host_version: 'browser',
    data: { module, action: 'open' },
  };
  writeQueue([...readQueue(), event]);
  scheduleFlush(500);
}

export function initializeTelemetry() {
  if (initialized) return () => undefined;
  initialized = true;

  const handleOnline = () => scheduleFlush(0);
  const handleVisibility = () => {
    if (document.visibilityState === 'hidden') void flushTelemetry({ keepalive: true });
  };
  const handlePageHide = () => void flushTelemetry({ keepalive: true });

  window.addEventListener('online', handleOnline);
  document.addEventListener('visibilitychange', handleVisibility);
  window.addEventListener('pagehide', handlePageHide);
  scheduleFlush(250);

  return () => {
    initialized = false;
    if (flushTimer !== undefined) window.clearTimeout(flushTimer);
    flushTimer = undefined;
    window.removeEventListener('online', handleOnline);
    document.removeEventListener('visibilitychange', handleVisibility);
    window.removeEventListener('pagehide', handlePageHide);
  };
}
