import type { ProviderStatus } from './authApiClient';
import { getWorkspaceApiBase } from './workspaceApiBase.cloud';

const workspaceApiBase = getWorkspaceApiBase(import.meta.env.VITE_LICLICK_WORKSPACE_API);

export type LiclickTransport = {
  kind: 'workspace';
  baseUrl: string;
  credentials: 'include';
};

export function getLiclickTransportForProvider(
  _providerStatus: ProviderStatus | undefined,
  baseUrl?: string,
): LiclickTransport {
  return {
    kind: 'workspace',
    baseUrl: baseUrl ?? workspaceApiBase,
    credentials: 'include',
  };
}

export async function resolveLiclickTransport(
  providerStatus?: ProviderStatus,
  baseUrl?: string,
): Promise<LiclickTransport> {
  return getLiclickTransportForProvider(providerStatus, baseUrl);
}
