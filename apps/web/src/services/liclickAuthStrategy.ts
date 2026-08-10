import type { ProviderStatus } from "./authApiClient";

export type LiclickAuthStrategy =
  | "atlas-workspace"
  | "personal-local-component"
  | "unresolved";

export function resolveLiclickAuthStrategy(
  providerStatus: ProviderStatus | undefined,
): LiclickAuthStrategy {
  if (providerStatus?.feishuLoginProvider === "atlas-cli") {
    // Interactive Atlas is only the employee-identity provider. Generation
    // credentials belong to the current Windows user and must be handled by
    // the loopback local component. A service-token deployment is the only
    // Atlas mode allowed to submit through the shared workspace server.
    return providerStatus.atlasLoginMode === "interactive"
      ? "personal-local-component"
      : "atlas-workspace";
  }
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
  return providerStatus?.feishuLoginProvider === "atlas-cli";
}

export function usesPersonalLiclickAccount(
  providerStatus: ProviderStatus | undefined,
) {
  return (
    resolveLiclickAuthStrategy(providerStatus) === "personal-local-component"
  );
}
