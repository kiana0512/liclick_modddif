import type { ProviderStatus } from './authApiClient';
import { getWorkspaceApiBase } from './workspaceApiBase.cloud';

const workspaceApiBase = getWorkspaceApiBase(import.meta.env.VITE_LICLICK_WORKSPACE_API);

export type LiclickTransport = {
  kind: 'workspace' | 'local-component';
  baseUrl: string;
  credentials: RequestCredentials;
  requiresIdentityProof: boolean;
};

export function getLiclickTransportForProvider(
  _providerStatus: ProviderStatus | undefined,
  baseUrl?: string,
): LiclickTransport {
  return {
    kind: 'workspace',
    baseUrl: baseUrl ?? workspaceApiBase,
    credentials: 'include',
    requiresIdentityProof: false,
  };
}

export async function resolveLiclickTransport(
  providerStatus?: ProviderStatus,
  baseUrl?: string,
): Promise<LiclickTransport> {
  return getLiclickTransportForProvider(providerStatus, baseUrl);
}
