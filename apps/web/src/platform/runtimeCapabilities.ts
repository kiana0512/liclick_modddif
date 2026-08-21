import type { RuntimeMode } from '@liclick/contracts';

/** The modernization branch has one runtime: browser + cloud control plane. */
export const runtimeMode: RuntimeMode = 'cloud';
export const isCloudBuild = true;
export const hostExtensionFeaturesAvailable = false;
export const browserLocalComputeRequired = true;
