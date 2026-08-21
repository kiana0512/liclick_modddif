export const LOCAL_COMPUTE_POLICY_VERSION = 1 as const;

export type BrowserComputeCapabilities = {
  webGpu: boolean;
  webGl2: boolean;
  workers: boolean;
  offscreenCanvas: boolean;
  wasm: boolean;
  sharedMemory: boolean;
  opfs: boolean;
  indexedDb: boolean;
  logicalProcessors: number;
  deviceMemoryGb?: number;
};

export type LocalTextureBackend =
  | 'webgpu-worker'
  | 'webgpu-main-cooperative'
  | 'webgl2-main'
  | 'cpu-worker'
  | 'cpu-main-limited';

export type LocalCpuBackend = 'wasm-worker' | 'js-worker' | 'js-main-limited';
export type BrowserPersistenceBackend = 'opfs' | 'indexeddb' | 'memory';

export type LocalComputePlan = {
  policyVersion: typeof LOCAL_COMPUTE_POLICY_VERSION;
  textureBackend: LocalTextureBackend;
  cpuBackend: LocalCpuBackend;
  persistenceBackend: BrowserPersistenceBackend;
  qualityTier: 'high' | 'standard' | 'limited';
  maxHeavyTaskConcurrency: number;
  serverFallbackAllowed: false;
  limitations: string[];
};

/**
 * Selects only browser-local backends. Missing capability reduces quality or
 * concurrency; it never changes the execution plane to an LI3D server.
 */
export function selectLocalComputePlan(
  capabilities: BrowserComputeCapabilities,
): LocalComputePlan {
  const limitations: string[] = [];
  let textureBackend: LocalTextureBackend;
  if (capabilities.webGpu && capabilities.workers) textureBackend = 'webgpu-worker';
  else if (capabilities.webGpu) textureBackend = 'webgpu-main-cooperative';
  else if (capabilities.webGl2) textureBackend = 'webgl2-main';
  else if (capabilities.workers) textureBackend = 'cpu-worker';
  else textureBackend = 'cpu-main-limited';

  let cpuBackend: LocalCpuBackend;
  if (capabilities.workers && capabilities.wasm) cpuBackend = 'wasm-worker';
  else if (capabilities.workers) cpuBackend = 'js-worker';
  else cpuBackend = 'js-main-limited';

  const persistenceBackend: BrowserPersistenceBackend = capabilities.opfs
    ? 'opfs'
    : capabilities.indexedDb
      ? 'indexeddb'
      : 'memory';

  const memoryGb = capabilities.deviceMemoryGb ?? 4;
  const qualityTier =
    capabilities.webGpu && capabilities.logicalProcessors >= 8 && memoryGb >= 8
      ? 'high'
      : (capabilities.webGpu || capabilities.webGl2) &&
          capabilities.logicalProcessors >= 4 &&
          memoryGb >= 4
        ? 'standard'
        : 'limited';

  if (!capabilities.webGpu) limitations.push('WebGPU unavailable; using a local compatibility backend.');
  if (!capabilities.workers) limitations.push('Workers unavailable; heavy tasks must yield on the UI thread.');
  if (!capabilities.opfs) limitations.push('OPFS unavailable; local cache durability is reduced.');
  if (!capabilities.sharedMemory) limitations.push('Shared memory unavailable; threaded WASM is disabled.');

  const concurrencyBudget = Math.max(1, Math.floor(capabilities.logicalProcessors / 2));
  const maxHeavyTaskConcurrency = Math.min(qualityTier === 'high' ? 4 : qualityTier === 'standard' ? 2 : 1, concurrencyBudget);

  return {
    policyVersion: LOCAL_COMPUTE_POLICY_VERSION,
    textureBackend,
    cpuBackend,
    persistenceBackend,
    qualityTier,
    maxHeavyTaskConcurrency,
    serverFallbackAllowed: false,
    limitations,
  };
}
