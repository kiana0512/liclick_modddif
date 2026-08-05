import assert from "node:assert/strict";
import path from "node:path";
import { env, stdout } from "node:process";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

env.VITE_LICLICK_WORKSPACE_API = "http://127.0.0.1:4518";
env.VITE_LICLICK_LOCAL_COMPONENT_PORT = "4618";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const server = await createServer({
  root,
  appType: "custom",
  logLevel: "silent",
  server: { middlewareMode: true },
});

const atlasProvider = {
  authMode: "feishu-oauth",
  devLoginEnabled: false,
  feishuOAuthEnabled: true,
  feishuConfigured: true,
  feishuLoginProvider: "atlas-cli",
  missingConfigKeys: [],
};
const webProvider = {
  ...atlasProvider,
  feishuLoginProvider: "web-oauth",
};
const idaasProvider = {
  ...atlasProvider,
  feishuLoginProvider: "idaas-jwt",
};
const user = {
  id: "local-user",
  displayName: "Local User",
  email: "local.user@example.com",
  role: "user",
  authSource: "feishu-oauth",
};

const originalWindow = globalThis.window;
const originalLocalStorage = globalThis.localStorage;
const originalFetch = globalThis.fetch;

function jsonResponse(payload, status = 200) {
  return new globalThis.Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function requestRecord(url, init = {}) {
  return {
    url: String(url),
    method: init.method ?? "GET",
    credentials: init.credentials,
    headers: Object.fromEntries(new globalThis.Headers(init.headers).entries()),
  };
}

try {
  globalThis.window = {
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    location: {
      hostname: '127.0.0.1',
      port: '5173',
      protocol: 'http:',
      origin: 'http://127.0.0.1:5173',
    },
  };
  globalThis.localStorage = {
    getItem: () => null,
    setItem: () => undefined,
    removeItem: () => undefined,
  };
  globalThis.fetch = async () =>
    jsonResponse({
      version: 1,
      activeUserId: "anonymous",
      performanceTestModeEnabled: false,
      performanceTestModeConfigured: false,
      profile: { customId: "" },
      shortcutOverrides: {},
      shortcutOverridesConfigured: false,
    });

  const { getWorkspaceApiBase } = await server.ssrLoadModule(
    "/src/services/workspaceApiBase.ts",
  );
  assert.equal(getWorkspaceApiBase(), "http://127.0.0.1:4518");
  globalThis.window.location = {
    hostname: "127.0.0.1",
    port: "4517",
    protocol: "http:",
    origin: "http://127.0.0.1:4517",
  };
  assert.equal(getWorkspaceApiBase(), "http://127.0.0.1:4517");
  globalThis.window.location = {
    hostname: "127.0.0.1",
    port: "5173",
    protocol: "http:",
    origin: "http://127.0.0.1:5173",
  };

  const workspaceClient = await server.ssrLoadModule(
    "/src/services/workspaceApiClient.ts",
  );
  const localAssetUrl =
    "http://127.0.0.1:4618/workspace/users/local-device/projects/demo/assets/generations/result.png";
  const generationRecoveryUrl =
    "http://127.0.0.1:4518/workspace/users/atlas-user/recoveries/modelview-inpaint/result.png";
  assert.equal(workspaceClient.isWorkspaceAssetUrl(localAssetUrl), true);
  assert.equal(
    workspaceClient.isWorkspaceAssetUrl(generationRecoveryUrl),
    false,
    "A 4518 generation result must not be mistaken for a 4618 local project asset.",
  );
  assert.equal(workspaceClient.isTrustedGenerationWorkspaceAssetUrl(generationRecoveryUrl), true);
  assert.equal(
    workspaceClient.isTrustedGenerationWorkspaceAssetUrl(
      "http://127.0.0.1:4518/api/health?next=/workspace/users/x/recoveries/modelview-inpaint/x.png",
    ),
    false,
  );
  let assetFetch;
  globalThis.fetch = async (url, init = {}) => {
    assetFetch = requestRecord(url, init);
    assetFetch.redirect = init.redirect;
    return new globalThis.Response(new Uint8Array([137, 80, 78, 71]), {
      status: 200,
      headers: { "content-type": "image/png" },
    });
  };
  await workspaceClient.urlToBlob(generationRecoveryUrl);
  assert.equal(assetFetch.credentials, "include");
  assert.equal(assetFetch.redirect, "error");

  const strategyModule = await server.ssrLoadModule(
    "/src/services/liclickAuthStrategy.ts",
  );
  const transportModule = await server.ssrLoadModule(
    "/src/services/liclickTransport.ts",
  );
  const { resolveLiclickAuthStrategy } = strategyModule;
  const { getLiclickTransportForProvider } = transportModule;

  assert.equal(resolveLiclickAuthStrategy(atlasProvider), "atlas-workspace");
  assert.equal(
    resolveLiclickAuthStrategy(webProvider),
    "personal-local-component",
  );
  assert.equal(
    resolveLiclickAuthStrategy(idaasProvider),
    "personal-local-component",
  );
  assert.equal(resolveLiclickAuthStrategy(undefined), "unresolved");
  assert.equal(
    resolveLiclickAuthStrategy({
      ...webProvider,
      feishuLoginProvider: "not-configured",
    }),
    "unresolved",
  );

  const atlasTransport = getLiclickTransportForProvider(atlasProvider);
  assert.deepEqual(atlasTransport, {
    kind: "workspace",
    baseUrl: "http://127.0.0.1:4518",
    credentials: "include",
    requiresIdentityProof: false,
  });
  assert.equal(atlasTransport.baseUrl.includes("4517"), false);
  assert.deepEqual(getLiclickTransportForProvider(webProvider), {
    kind: "local-component",
    baseUrl: "http://127.0.0.1:4618",
    credentials: "omit",
    requiresIdentityProof: true,
  });
  assert.equal(getLiclickTransportForProvider(undefined), undefined);

  const { useAuthStore } = await server.ssrLoadModule(
    "/src/stores/authStore.ts",
  );
  useAuthStore.getState().setAnonymous("feishu-oauth", atlasProvider);
  assert.equal(
    useAuthStore.getState().providerStatus.feishuLoginProvider,
    "atlas-cli",
  );
  useAuthStore.getState().setAuthenticated(user, "feishu-oauth");
  assert.equal(
    useAuthStore.getState().providerStatus.feishuLoginProvider,
    "atlas-cli",
  );
  useAuthStore.getState().setAnonymous();
  assert.equal(useAuthStore.getState().authMode, "feishu-oauth");
  assert.equal(
    useAuthStore.getState().providerStatus.feishuLoginProvider,
    "atlas-cli",
  );
  useAuthStore.getState().setAuthenticated(user, "feishu-oauth");
  assert.equal(
    useAuthStore.getState().providerStatus.feishuLoginProvider,
    "atlas-cli",
  );

  const { createLiclickApiClient } = await server.ssrLoadModule(
    "/src/services/liclickApiClient.ts",
  );
  const { LiClickImageEditProvider } = await server.ssrLoadModule(
    "/src/services/imageEditProvider.ts",
  );
  const generationInput = {
    clientGenerationId: "client-generation",
    projectId: "project",
    mode: "single",
    prompt: "test",
    referenceIds: [],
    referenceImages: [],
    visibleOnly: true,
    upscale: false,
    resolution: "2K",
  };

  let requests = [];
  globalThis.fetch = async (url, init = {}) => {
    requests.push(requestRecord(url, init));
    return jsonResponse({ id: "atlas-job", status: "running" }, 202);
  };
  await createLiclickApiClient({
    providerStatus: atlasProvider,
  }).generateTextureSingleView(generationInput);
  assert.equal(requests.length, 1);
  assert.equal(
    requests[0].url,
    "http://127.0.0.1:4518/api/liclick/generate-image",
  );
  assert.equal(requests[0].credentials, "include");
  assert.equal("x-li3d-identity-proof" in requests[0].headers, false);

  requests = [];
  globalThis.fetch = async (url, init = {}) => {
    const request = requestRecord(url, init);
    requests.push(request);
    if (request.url.endsWith("/api/auth/local-proof"))
      return jsonResponse({ proof: "proof-1" });
    return jsonResponse({ id: "server-job", status: "running" }, 202);
  };
  await createLiclickApiClient({
    providerStatus: webProvider,
  }).generateTextureSingleView(generationInput);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, "http://127.0.0.1:4518/api/auth/local-proof");
  assert.equal(requests[0].credentials, "include");
  assert.equal(
    requests[1].url,
    "http://127.0.0.1:4618/api/liclick/generate-image",
  );
  assert.equal(requests[1].credentials, "omit");
  assert.equal(requests[1].headers["x-li3d-identity-proof"], "proof-1");

  requests = [];
  globalThis.fetch = async (url, init = {}) => {
    requests.push(requestRecord(url, init));
    return jsonResponse({ id: "atlas-edit", status: "running" });
  };
  await new LiClickImageEditProvider(undefined, atlasProvider).getEditImageJob(
    "atlas-edit",
  );
  assert.equal(requests.length, 1);
  assert.equal(
    requests[0].url,
    "http://127.0.0.1:4518/api/liclick/edit-image/atlas-edit",
  );
  assert.equal(requests[0].credentials, "include");
  assert.equal("x-li3d-identity-proof" in requests[0].headers, false);

  requests = [];
  globalThis.fetch = async (url, init = {}) => {
    const request = requestRecord(url, init);
    requests.push(request);
    if (request.url.endsWith("/api/auth/local-proof"))
      return jsonResponse({ proof: "proof-2" });
    return jsonResponse({ id: "server-edit", status: "running" });
  };
  await new LiClickImageEditProvider(undefined, webProvider).getEditImageJob(
    "server-edit",
  );
  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, "http://127.0.0.1:4518/api/auth/local-proof");
  assert.equal(
    requests[1].url,
    "http://127.0.0.1:4618/api/liclick/edit-image/server-edit",
  );
  assert.equal(requests[1].credentials, "omit");
  assert.equal(requests[1].headers["x-li3d-identity-proof"], "proof-2");

  stdout.write(
    "Liclick local/server auth separation regression test passed.\n",
  );
} finally {
  globalThis.window = originalWindow;
  globalThis.localStorage = originalLocalStorage;
  globalThis.fetch = originalFetch;
  await server.close();
}
