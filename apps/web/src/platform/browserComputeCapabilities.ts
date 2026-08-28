import {
  selectLocalComputePlan,
  type BrowserComputeCapabilities,
  type LocalComputePlan,
} from '@liclick/contracts';

type NavigatorWithBrowserCompute = Navigator & {
  deviceMemory?: number;
  gpu?: { requestAdapter(options?: { powerPreference?: string }): Promise<unknown | null> };
  storage?: StorageManager & { getDirectory?: () => Promise<unknown> };
};

export type BrowserComputeState = {
  capabilities: BrowserComputeCapabilities;
  plan: LocalComputePlan;
};

export const browserComputeCapabilitiesEventName = 'li3d:browser-compute-capabilities';
let browserComputeStatePromise: Promise<BrowserComputeState> | undefined;

async function hasWebGpu(navigatorWithCompute: NavigatorWithBrowserCompute) {
  if (!navigatorWithCompute.gpu || !window.isSecureContext) return false;
  try {
    return Boolean(
      await navigatorWithCompute.gpu.requestAdapter({ powerPreference: 'high-performance' }),
    );
  } catch {
    return false;
  }
}

function hasWebGl2() {
  try {
    return Boolean(document.createElement('canvas').getContext('webgl2'));
  } catch {
    return false;
  }
}

export async function detectBrowserComputeState(): Promise<BrowserComputeState> {
  const browserNavigator = navigator as NavigatorWithBrowserCompute;
  const capabilities: BrowserComputeCapabilities = {
    webGpu: await hasWebGpu(browserNavigator),
    webGl2: hasWebGl2(),
    workers: typeof Worker !== 'undefined',
    offscreenCanvas: typeof OffscreenCanvas !== 'undefined',
    wasm: typeof WebAssembly !== 'undefined',
    sharedMemory:
      window.crossOriginIsolated && typeof SharedArrayBuffer !== 'undefined',
    opfs: typeof browserNavigator.storage?.getDirectory === 'function',
    indexedDb: typeof indexedDB !== 'undefined',
    logicalProcessors: Math.max(1, browserNavigator.hardwareConcurrency || 1),
    deviceMemoryGb: browserNavigator.deviceMemory,
  };
  return { capabilities, plan: selectLocalComputePlan(capabilities) };
}

export function getBrowserComputeState() {
  browserComputeStatePromise ??= detectBrowserComputeState();
  return browserComputeStatePromise;
}

export async function initializeBrowserComputeCapabilities() {
  const state = await getBrowserComputeState();
  const root = document.documentElement;
  root.dataset.li3dTextureBackend = state.plan.textureBackend;
  root.dataset.li3dCpuBackend = state.plan.cpuBackend;
  root.dataset.li3dComputeQuality = state.plan.qualityTier;
  root.dataset.li3dServerComputeFallback = 'forbidden';
  window.dispatchEvent(
    new CustomEvent(browserComputeCapabilitiesEventName, { detail: state }),
  );
  return state;
}
