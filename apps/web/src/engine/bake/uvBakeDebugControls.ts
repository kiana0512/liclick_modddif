import type { BakeVisibleProjectedLayersInput } from './uvBakeTypes';

export type UvBakeDebugMethod = NonNullable<BakeVisibleProjectedLayersInput['method']>;

export const DEFAULT_UV_BAKE_METHOD: UvBakeDebugMethod = 'gpu';
export const DEFAULT_GPU_PROJECTED_IMAGE_UV_FLIP_Y = true;

const METHOD_KEY = 'liclick-debug-uv-bake-method';
const METHOD_EXPIRES_AT_KEY = 'liclick-debug-uv-bake-method-expires-at';
const VERBOSE_KEY = 'liclick-debug-uv-bake';
const COVERAGE_VALIDATION_KEY = 'liclick-debug-gpu-coverage-validation';
const GPU_PROJECTED_IMAGE_UV_FLIP_Y_KEY = 'liclick-debug-gpu-projected-image-uv-flip-y';

function getStorage() {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

function normalizeMethod(value: string | null): UvBakeDebugMethod | undefined {
  return value === 'cpu' || value === 'gpu' || value === 'auto' ? value : undefined;
}

function clearExpiredMethod(storage: Storage) {
  const expiresAt = Number(storage.getItem(METHOD_EXPIRES_AT_KEY) ?? 0);
  if (expiresAt > 0 && Date.now() > expiresAt) {
    storage.removeItem(METHOD_KEY);
    storage.removeItem(METHOD_EXPIRES_AT_KEY);
  }
}

export function getDebugUvBakeMethod(fallback: UvBakeDebugMethod = DEFAULT_UV_BAKE_METHOD): UvBakeDebugMethod {
  const storage = getStorage();
  if (!storage) return fallback;
  clearExpiredMethod(storage);
  return normalizeMethod(storage.getItem(METHOD_KEY)) ?? fallback;
}

export function setDebugUvBakeMethod(method: UvBakeDebugMethod, options: { ttlMs?: number } = {}) {
  const storage = getStorage();
  if (!storage) return;
  storage.setItem(METHOD_KEY, method);
  if (options.ttlMs && options.ttlMs > 0) {
    storage.setItem(METHOD_EXPIRES_AT_KEY, String(Date.now() + options.ttlMs));
  } else {
    storage.removeItem(METHOD_EXPIRES_AT_KEY);
  }
}

export function clearDebugUvBakeMethod() {
  const storage = getStorage();
  if (!storage) return;
  storage.removeItem(METHOD_KEY);
  storage.removeItem(METHOD_EXPIRES_AT_KEY);
}

export function setDebugUvBakeVerbose(enabled: boolean) {
  const storage = getStorage();
  if (!storage) return;
  storage.setItem(VERBOSE_KEY, enabled ? '1' : '0');
}

export function setDebugGpuCoverageValidation(enabled: boolean) {
  const storage = getStorage();
  if (!storage) return;
  storage.setItem(COVERAGE_VALIDATION_KEY, enabled ? '1' : '0');
}

export function getDebugGpuProjectedImageUvFlipY(fallback = DEFAULT_GPU_PROJECTED_IMAGE_UV_FLIP_Y) {
  const storage = getStorage();
  if (!storage) return fallback;
  const value = storage.getItem(GPU_PROJECTED_IMAGE_UV_FLIP_Y_KEY);
  if (value === '1') return true;
  if (value === '0') return false;
  return fallback;
}

export function setDebugGpuProjectedImageUvFlipY(enabled: boolean) {
  const storage = getStorage();
  if (!storage) return;
  storage.setItem(GPU_PROJECTED_IMAGE_UV_FLIP_Y_KEY, enabled ? '1' : '0');
}

export function getDebugUvBakeStatus() {
  const storage = getStorage();
  if (!storage) {
    return {
      method: DEFAULT_UV_BAKE_METHOD,
      verbose: false,
      gpuCoverageValidation: false,
      gpuProjectedImageUvFlipY: DEFAULT_GPU_PROJECTED_IMAGE_UV_FLIP_Y,
      expiresAt: undefined,
    };
  }
  clearExpiredMethod(storage);
  const expiresAtRaw = Number(storage.getItem(METHOD_EXPIRES_AT_KEY) ?? 0);
  return {
    method: getDebugUvBakeMethod(DEFAULT_UV_BAKE_METHOD),
    verbose: storage.getItem(VERBOSE_KEY) === '1',
    gpuCoverageValidation: storage.getItem(COVERAGE_VALIDATION_KEY) === '1',
    gpuProjectedImageUvFlipY: getDebugGpuProjectedImageUvFlipY(DEFAULT_GPU_PROJECTED_IMAGE_UV_FLIP_Y),
    expiresAt: expiresAtRaw > 0 ? new Date(expiresAtRaw).toISOString() : undefined,
  };
}
