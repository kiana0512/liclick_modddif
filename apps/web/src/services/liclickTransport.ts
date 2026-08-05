import {
  getCachedProviderStatus,
  getProviderStatus,
  type ProviderStatus,
} from "./authApiClient";
import { resolveLiclickAuthStrategy } from "./liclickAuthStrategy";
import { getLocalTextureRuntimeApiBase } from "./localTextureRuntimeClient";
import { getWorkspaceApiBase } from "./workspaceApiBase";

const workspaceApiBase = getWorkspaceApiBase(
  import.meta.env.VITE_LICLICK_WORKSPACE_API,
);
const localComponentApiBase = getLocalTextureRuntimeApiBase();

export type LiclickTransport = {
  kind: "workspace" | "local-component";
  baseUrl: string;
  credentials: RequestCredentials;
  requiresIdentityProof: boolean;
};

export function getLiclickTransportForProvider(
  providerStatus: ProviderStatus | undefined,
  baseUrl?: string,
): LiclickTransport | undefined {
  const strategy = resolveLiclickAuthStrategy(providerStatus);
  if (strategy === "atlas-workspace") {
    return {
      kind: "workspace",
      baseUrl: baseUrl ?? workspaceApiBase,
      credentials: "include",
      requiresIdentityProof: false,
    };
  }
  if (strategy === "personal-local-component") {
    return {
      kind: "local-component",
      baseUrl: baseUrl ?? localComponentApiBase,
      credentials: "omit",
      requiresIdentityProof: true,
    };
  }
  return undefined;
}

export async function resolveLiclickTransport(
  providerStatus?: ProviderStatus,
  baseUrl?: string,
): Promise<LiclickTransport> {
  const currentProviderStatus =
    providerStatus ?? getCachedProviderStatus() ?? (await getProviderStatus());
  const transport = getLiclickTransportForProvider(
    currentProviderStatus,
    baseUrl,
  );
  if (!transport) {
    throw new Error("无法确认当前登录方式，请刷新页面或重新登录后再试。");
  }
  return transport;
}
