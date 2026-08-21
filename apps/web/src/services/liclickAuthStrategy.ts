import type { ProviderStatus } from "./authApiClient";

export type LiclickAuthStrategy =
  | "atlas-workspace"
  | "unresolved";

export function resolveLiclickAuthStrategy(
  providerStatus: ProviderStatus | undefined,
): LiclickAuthStrategy {
  if (providerStatus?.feishuLoginProvider === "atlas-cli") {
    return "atlas-workspace";
  }
  if (
    providerStatus?.feishuLoginProvider === "web-oauth" ||
    providerStatus?.feishuLoginProvider === "idaas-jwt" ||
    (providerStatus?.devLoginEnabled === true &&
      providerStatus.feishuOAuthEnabled === false)
  ) {
    return "atlas-workspace";
  }
  return "unresolved";
}

export function usesLocalAtlasLogin(
  providerStatus: ProviderStatus | undefined,
) {
  return providerStatus?.feishuLoginProvider === "atlas-cli";
}
