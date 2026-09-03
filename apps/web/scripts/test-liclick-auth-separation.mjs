import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { stdout } from 'node:process';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const server = await createServer({
  root,
  appType: 'custom',
  logLevel: 'silent',
  server: { middlewareMode: true },
});

const webProvider = {
  authMode: 'feishu-oauth',
  devLoginEnabled: false,
  feishuOAuthEnabled: true,
  feishuConfigured: true,
  feishuLoginProvider: 'web-oauth',
  missingConfigKeys: [],
};
const idaasProvider = {
  ...webProvider,
  feishuLoginProvider: 'idaas-jwt',
};
const user = {
  id: 'cloud-user',
  displayName: 'Cloud User',
  email: 'cloud.user@example.com',
  role: 'user',
  authSource: 'feishu-oauth',
};
const cloudApiBase = 'http://127.0.0.1:4518';
const removedLocalComponentBase = 'http://127.0.0.1:4618';

const originalWindow = globalThis.window;
const originalLocalStorage = globalThis.localStorage;
const originalFetch = globalThis.fetch;

function jsonResponse(payload, status = 200) {
  return new globalThis.Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function requestRecord(url, init = {}) {
  return {
    url: String(url),
    method: init.method ?? 'GET',
    credentials: init.credentials,
    headers: Object.fromEntries(new globalThis.Headers(init.headers).entries()),
  };
}

function assertCloudOnlyRequest(request, pathName) {
  assert.equal(request.url, `${cloudApiBase}${pathName}`);
  assert.equal(request.credentials, 'include');
  assert.equal(request.url.startsWith(removedLocalComponentBase), false);
  assert.equal(request.url.endsWith('/api/auth/local-proof'), false);
  assert.equal('x-li3d-identity-proof' in request.headers, false);
}

try {
  const userMenuSource = await fs.readFile(path.join(root, 'src/components/auth/UserMenu.tsx'), 'utf8');
  for (const requiredLabel of ['当前用户的莉刻账号', '更换', '解除当前用户的莉刻账号']) {
    assert.match(userMenuSource, new RegExp(requiredLabel));
  }
  assert.match(userMenuSource, /测试共享莉刻账号/);
  assert.match(userMenuSource, /liclickAccount\?\.sharedTestAccount/);
  assert.doesNotMatch(userMenuSource, /startAtlasLogin|pollAtlasLogin|localhost:20265/);
  assert.match(userMenuSource, /\/api\/liclick\/account-binding\/start/);
  assert.match(userMenuSource, /credentials:\s*'include'/);

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

  const { getWorkspaceApiBase } = await server.ssrLoadModule('/src/services/workspaceApiBase.ts');
  assert.equal(getWorkspaceApiBase(), 'http://127.0.0.1:5173');
  assert.equal(getWorkspaceApiBase(`${cloudApiBase}/`), cloudApiBase);

  const strategyModule = await server.ssrLoadModule('/src/services/liclickAuthStrategy.ts');
  const transportModule = await server.ssrLoadModule('/src/services/liclickTransport.ts');
  const { resolveLiclickAuthStrategy } = strategyModule;
  const { getLiclickTransportForProvider } = transportModule;

  for (const provider of [webProvider, idaasProvider]) {
    assert.equal(resolveLiclickAuthStrategy(provider), 'atlas-workspace');
    assert.deepEqual(getLiclickTransportForProvider(provider, cloudApiBase), {
      kind: 'workspace',
      baseUrl: cloudApiBase,
      credentials: 'include',
    });
  }
  assert.equal(resolveLiclickAuthStrategy(undefined), 'unresolved');
  assert.equal(
    resolveLiclickAuthStrategy({
      ...webProvider,
      feishuLoginProvider: 'not-configured',
    }),
    'unresolved',
  );
  assert.deepEqual(getLiclickTransportForProvider(undefined, cloudApiBase), {
    kind: 'workspace',
    baseUrl: cloudApiBase,
    credentials: 'include',
  });

  const { useAuthStore } = await server.ssrLoadModule('/src/stores/authStore.ts');
  useAuthStore.getState().setAnonymous('feishu-oauth', webProvider);
  assert.equal(useAuthStore.getState().providerStatus.feishuLoginProvider, 'web-oauth');
  useAuthStore.getState().setAuthenticated(user, 'feishu-oauth');
  assert.equal(useAuthStore.getState().providerStatus.feishuLoginProvider, 'web-oauth');
  useAuthStore.getState().setAnonymous();
  assert.equal(useAuthStore.getState().authMode, 'feishu-oauth');
  assert.equal(useAuthStore.getState().providerStatus.feishuLoginProvider, 'web-oauth');

  const { createLiclickApiClient } = await server.ssrLoadModule(
    '/src/services/liclickApiClient.ts',
  );
  const { LiClickImageEditProvider } = await server.ssrLoadModule(
    '/src/services/imageEditProvider.ts',
  );
  const generationInput = {
    clientGenerationId: 'client-generation',
    projectId: 'project',
    mode: 'single',
    prompt: 'test',
    referenceIds: [],
    referenceImages: [],
    visibleOnly: true,
    upscale: false,
    resolution: '2K',
  };

  for (const providerStatus of [webProvider, idaasProvider]) {
    const requests = [];
    globalThis.fetch = async (url, init = {}) => {
      requests.push(requestRecord(url, init));
      return jsonResponse({ id: 'cloud-job', status: 'running' }, 202);
    };
    await createLiclickApiClient({
      baseUrl: cloudApiBase,
      providerStatus,
    }).generateTextureSingleView(generationInput);
    assert.equal(requests.length, 1);
    assertCloudOnlyRequest(requests[0], '/api/liclick/generate-image');
  }

  for (const providerStatus of [webProvider, idaasProvider]) {
    const requests = [];
    globalThis.fetch = async (url, init = {}) => {
      requests.push(requestRecord(url, init));
      return jsonResponse({ id: 'cloud-edit', status: 'running' });
    };
    await new LiClickImageEditProvider(cloudApiBase, providerStatus).getEditImageJob('cloud-edit');
    assert.equal(requests.length, 1);
    assertCloudOnlyRequest(requests[0], '/api/liclick/edit-image/cloud-edit');
  }

  stdout.write('Liclick zero-install cloud auth regression test passed.\n');
} finally {
  globalThis.window = originalWindow;
  globalThis.localStorage = originalLocalStorage;
  globalThis.fetch = originalFetch;
  await server.close();
}
