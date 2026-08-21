import type { RuntimeMode } from '@liclick/contracts';

const configuredMode = import.meta.env.VITE_LICLICK_RUNTIME_MODE?.trim();

export const runtimeMode: RuntimeMode =
  configuredMode === 'cloud' || configuredMode === 'desktop-legacy'
    ? configuredMode
    : 'development';

export const isCloudBuild = runtimeMode === 'cloud';
export const hostExtensionFeaturesAvailable = !isCloudBuild;
export const browserLocalComputeRequired = isCloudBuild;
