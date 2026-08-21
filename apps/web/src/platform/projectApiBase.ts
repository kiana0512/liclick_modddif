import { getLocalTextureRuntimeApiBase } from '@/services/localTextureRuntimeClient';

/** Desktop compatibility adapter. Cloud builds replace this module at bundle time. */
export function getProjectApiBase() {
  return getLocalTextureRuntimeApiBase();
}
