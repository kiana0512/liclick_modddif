import fs from 'node:fs';
import path from 'node:path';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { requireAuth } from './auth/authMiddleware.js';
import { materializeGpuControlLanCa } from './certs/gpuControlLanCa.js';
import { serverConfig } from './config.js';
import { handleAssetsRoute } from './routes/assets.js';
import { handleAssetProcessingRoute } from './routes/assetProcessing.js';
import { handleAuthRoute } from './routes/auth.js';
import { handleBakeRoute } from './routes/bake.js';
import { handleComfyuiRoute } from './routes/comfyui.js';
import { handleEventsRoute } from './routes/events.js';
import { handleExportRoute } from './routes/export.js';
import { handleFoldersRoute } from './routes/folders.js';
import { handleHistoryRoute } from './routes/history.js';
import { handleIdentityRoute } from './routes/identity.js';
import { handleLiclickRoute } from './routes/liclick.js';
import { handleLocalSettingsRoute } from './routes/localSettings.js';
import { handleModelviewRoute } from './routes/modelview.js';
import { handlePerformanceRoute } from './routes/performance.js';
import { handlePhotoshopRoute } from './routes/photoshop.js';
import { photoshopBridge } from './photoshop/photoshopBridgeService.js';
import { corsHeaders, isAllowedRequestOrigin, sendJson, sendNoContent } from './routes/httpUtils.js';
import { handleProjectsRoute } from './routes/projects.js';
import { initializeWorkspace } from './services/workspaceService.js';
import { identityTelemetryStorage } from './services/identityTelemetryService.js';
import { syncTelemetryAggregateToBitable } from './services/feishuPlatformService.js';
import { publicWorkspaceFilePattern } from './services/publicWorkspaceFile.js';
import { serveWebFrontend } from './services/webFrontendService.js';

const mimeTypes: Record<string, string> = {
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.fbx': 'application/octet-stream',
  '.obj': 'text/plain',
};

function isWithinDirectory(root: string, candidate: string) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function serveWorkspaceFile(request: IncomingMessage, response: ServerResponse, url: URL) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    sendJson(response, 405, { error: 'Method not allowed.' });
    return true;
  }
  if (!isAllowedRequestOrigin(request)) {
    sendJson(response, 403, { error: 'Origin is not allowed.' });
    return true;
  }
  const user = await requireAuth(request, response);
  if (!user) return true;

  let relative: string;
  try {
    relative = decodeURIComponent(url.pathname.replace(/^\/workspace\/?/, '')).replaceAll('\\', '/');
  } catch {
    sendJson(response, 400, { error: 'Invalid workspace path.' });
    return true;
  }
  const publicPathMatch = publicWorkspaceFilePattern.exec(relative);
  if (!publicPathMatch) {
    sendJson(response, 403, { error: 'Workspace file is not public.' });
    return true;
  }
  const userOwnedPath = /^users\/([^/]+)\//i.exec(publicPathMatch[1]);
  if (userOwnedPath && userOwnedPath[1] !== user.id) {
    sendJson(response, 403, { error: 'Forbidden.' });
    return true;
  }

  const workspaceRoot = path.resolve(serverConfig.workspaceDir);
  const publicRoot = path.resolve(workspaceRoot, publicPathMatch[1]);
  const absolute = path.resolve(publicRoot, publicPathMatch[2]);
  if (!isWithinDirectory(workspaceRoot, publicRoot) || !isWithinDirectory(publicRoot, absolute)) {
    sendJson(response, 403, { error: 'Forbidden.' });
    return true;
  }
  if (!fs.existsSync(absolute) || fs.statSync(absolute).isDirectory()) {
    sendJson(response, 404, { error: 'File not found.' });
    return true;
  }
  const realWorkspaceRoot = fs.realpathSync(workspaceRoot);
  const realPublicRoot = fs.realpathSync(publicRoot);
  const realAbsolute = fs.realpathSync(absolute);
  if (!isWithinDirectory(realWorkspaceRoot, realPublicRoot) || !isWithinDirectory(realPublicRoot, realAbsolute)) {
    sendJson(response, 403, { error: 'Forbidden.' });
    return true;
  }
  response.writeHead(200, {
    'content-type': mimeTypes[path.extname(absolute).toLowerCase()] ?? 'application/octet-stream',
    ...corsHeaders(response),
    'cache-control': 'no-cache, no-store, must-revalidate',
    'x-content-type-options': 'nosniff',
  });
  if (request.method === 'HEAD') response.end();
  else fs.createReadStream(realAbsolute).pipe(response);
  return true;
}

function stripPublicPath(url: URL) {
  const publicPath = serverConfig.publicPath;
  if (!publicPath || !url.pathname.startsWith(`${publicPath}/`) && url.pathname !== publicPath) return url;
  const stripped = new URL(url.href);
  stripped.pathname = url.pathname === publicPath ? '/' : stripped.pathname.slice(publicPath.length) || '/';
  return stripped;
}

async function handleWorkspaceRequest(
  request: IncomingMessage,
  response: ServerResponse,
) {
  const rawUrl = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`);
  const url = stripPublicPath(rawUrl);
  if (!isAllowedRequestOrigin(request)) {
    sendJson(response, 403, { error: 'Origin is not allowed.' });
    return;
  }
  if (request.method === 'OPTIONS') {
    sendNoContent(response);
    return;
  }
  if (url.pathname === '/api/health') {
    sendJson(response, 200, {
      ok: true,
      workspaceVersion: '0.6.0',
      host: serverConfig.host,
      features: {
        webOAuthCookieSession:
          serverConfig.feishuWebOAuthEnabled || serverConfig.idaasJwtSsoEnabled || serverConfig.atlasLocalLoginEnabled,
        atlasCliLogin: serverConfig.atlasLocalLoginEnabled,
        browserHttpUuidFallback: true,
        integratedWeb: serverConfig.serveWeb,
        identityBinding: true,
        usageTelemetry: true,
        feishuDirectoryEnrichment: serverConfig.feishuPlatform.directory.enabled,
        feishuBitableSync: serverConfig.feishuPlatform.bitable.enabled,
      },
    });
    return;
  }
  if (url.pathname.startsWith('/workspace/')) {
    await serveWorkspaceFile(request, response, url);
    return;
  }
  if (url.pathname.startsWith('/api/auth') && (await handleAuthRoute(request, response, url))) return;
  if (url.pathname.startsWith('/api/identity') && (await handleIdentityRoute(request, response, url))) return;
  if (url.pathname === '/api/events' && (await handleEventsRoute(request, response, url))) return;
  if (url.pathname === '/api/local-settings' && (await handleLocalSettingsRoute(request, response, url))) return;
  if (url.pathname.startsWith('/api/performance') && (await handlePerformanceRoute(request, response, url))) return;
  if (url.pathname === '/api/history' && (await handleHistoryRoute(request, response, url))) return;
  if (
    url.pathname.startsWith('/api/asset-processing') &&
    (await handleAssetProcessingRoute(request, response, url))
  ) return;
  if (url.pathname.startsWith('/api/bake') && (await handleBakeRoute(request, response, url))) return;
  if (url.pathname.startsWith('/api/photoshop')) {
    // Photoshop/DCC control belongs to the separately installed loopback-only
    // local component. Never expose those launch/session endpoints on the
    // public LI3D web server.
    if (process.env.LICLICK_LOCAL_COMPONENT_MODE !== '1') {
      sendJson(response, 404, { error: 'Not found.' });
      return;
    }
    if (await handlePhotoshopRoute(request, response, url)) return;
  }
  if (url.pathname.startsWith('/api/modelview') && (await handleModelviewRoute(request, response, url))) return;
  if (url.pathname.startsWith('/api/comfyui') && (await handleComfyuiRoute(request, response, url))) return;
  if (
    (url.pathname.startsWith('/api/liclick') || url.pathname === '/api/generate-image') &&
    (await handleLiclickRoute(request, response, url))
  ) return;
  if (url.pathname.startsWith('/api/projects') && (await handleAssetsRoute(request, response, url))) return;
  if (url.pathname.startsWith('/api/projects') && (await handleExportRoute(request, response, url))) return;
  if (url.pathname.startsWith('/api/projects') && (await handleProjectsRoute(request, response, url))) return;
  if (url.pathname.startsWith('/api/folders') && (await handleFoldersRoute(request, response, url))) return;
  if (!url.pathname.startsWith('/api/') && (await serveWebFrontend(request, response, url))) return;
  sendJson(response, 404, { error: 'Route not found.' });
}

let telemetrySyncRunning = false;
let telemetrySyncFailureStreak = 0;

async function syncPendingTelemetryAggregates() {
  if (!serverConfig.feishuPlatform.bitable.enabled || telemetrySyncRunning) return;
  telemetrySyncRunning = true;
  let hadFailure = false;
  try {
    const pending = await identityTelemetryStorage.listPendingAggregates(100);
    for (const aggregate of pending) {
      try {
        const result = await syncTelemetryAggregateToBitable(aggregate);
        await identityTelemetryStorage.markAggregateSynced({
          aggregate_key: aggregate.aggregate_key,
          sync_hash: aggregate.sync_hash,
          record_id: result.recordId,
        });
      } catch (error) {
        hadFailure = true;
        await identityTelemetryStorage.markAggregateSyncFailed({
          aggregate_key: aggregate.aggregate_key,
          sync_hash: aggregate.sync_hash,
          error: error instanceof Error ? error.message : 'Feishu Bitable sync failed.',
        }).catch(() => undefined);
      }
    }
  } catch (error) {
    hadFailure = true;
    console.warn(
      '[LI3D telemetry sync] Pending aggregate scan failed:',
      error instanceof Error ? error.message : 'unknown error',
    );
  } finally {
    telemetrySyncFailureStreak = hadFailure
      ? Math.min(telemetrySyncFailureStreak + 1, 6)
      : 0;
    telemetrySyncRunning = false;
  }
}

function startTelemetryAggregateWorker() {
  if (!serverConfig.feishuPlatform.bitable.enabled) return;
  const baseInterval = serverConfig.feishuPlatform.bitable.syncIntervalMs;
  const scheduleNext = () => {
    const backoff = 2 ** telemetrySyncFailureStreak;
    const timer = setTimeout(() => {
      void syncPendingTelemetryAggregates().finally(scheduleNext);
    }, Math.min(baseInterval * backoff, 30 * 60_000));
    timer.unref();
  };
  void syncPendingTelemetryAggregates().finally(scheduleNext);
}

async function startServer() {
  await materializeGpuControlLanCa(
    serverConfig.modelviewInpaintCaPath,
    serverConfig.modelviewInpaintCaManaged,
  );
  await materializeGpuControlLanCa(
    serverConfig.substanceBakerCaPath,
    serverConfig.substanceBakerCaManaged,
  );
  await materializeGpuControlLanCa(
    serverConfig.assetServiceCaCertPath,
    serverConfig.assetServiceCaCertManaged,
  );
  await initializeWorkspace();
  await identityTelemetryStorage.initialize();
  startTelemetryAggregateWorker();

  const server = createServer(async (request, response) => {
    try {
      await handleWorkspaceRequest(request, response);
    } catch (error) {
      console.error('[Liclick Workspace Server]', error);
      sendJson(response, 500, { error: error instanceof Error ? error.message : 'Internal server error.' });
    }
  });

  if (process.env.LICLICK_LOCAL_COMPONENT_MODE === '1') {
    photoshopBridge.attach(server);
  }

  server.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code !== 'EADDRINUSE') {
      console.error('[Liclick Workspace Server]', error);
      process.exitCode = 1;
      return;
    }

    void fetch(`http://127.0.0.1:${serverConfig.port}/api/health`)
      .then((response) => {
        if (!response.ok) throw new Error(`Health check failed: ${response.status}`);
        console.log(`Liclick workspace server already running at http://127.0.0.1:${serverConfig.port}`);
        console.log('Keeping this process alive so the workspace dev script stays healthy.');
        setInterval(() => undefined, 60_000);
      })
      .catch((healthError) => {
        console.error(
          `[Liclick Workspace Server] Port ${serverConfig.port} is already in use, but it is not a healthy Liclick server.`,
        );
        console.error(healthError);
        process.exitCode = 1;
      });
  });

  server.listen(serverConfig.port, serverConfig.host, () => {
    console.log(`Liclick workspace server running at http://${serverConfig.host}:${serverConfig.port}`);
    console.log(`Workspace: ${serverConfig.workspaceDir}`);
  });
}

void startServer();
