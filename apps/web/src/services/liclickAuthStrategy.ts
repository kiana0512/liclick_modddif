import type { ProviderStatus } from "./authApiClient";

export type LiclickAuthStrategy =
  | "atlas-workspace"
  | "personal-local-component"
  | "unresolved";

export function resolveLiclickAuthStrategy(
  providerStatus: ProviderStatus | undefined,
): LiclickAuthStrategy {
  if (providerStatus?.feishuLoginProvider === "atlas-cli")
    return "atlas-workspace";
  if (
    providerStatus?.feishuLoginProvider === "web-oauth" ||
    providerStatus?.feishuLoginProvider === "idaas-jwt" ||
    (providerStatus?.devLoginEnabled === true &&
      providerStatus.feishuOAuthEnabled === false)
  ) {
    return "personal-local-component";
  }
  return "unresolved";
}

export function usesLocalAtlasLogin(
  providerStatus: ProviderStatus | undefined,
) {
  return resolveLiclickAuthStrategy(providerStatus) === "atlas-workspace";
}

export function usesPersonalLiclickAccount(
  providerStatus: ProviderStatus | undefined,
) {
  return (
    resolveLiclickAuthStrategy(providerStatus) === "personal-local-component"
  );
}
