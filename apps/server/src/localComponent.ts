import fs from 'node:fs';
import path from 'node:path';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { serverConfig } from './config.js';
import { photoshopBridge } from './photoshop/photoshopBridgeService.js';
import { handleAssetsRoute } from './routes/assets.js';
import { handleExportRoute } from './routes/export.js';
import { handleFoldersRoute } from './routes/folders.js';
import { corsHeaders, isAllowedRequestOrigin, sendJson, sendNoContent } from './routes/httpUtils.js';
import { handleLocalLiclickRoute } from './routes/localLiclick.js';
import { handleLocalLiclickAccountRoute } from './routes/localLiclickAccount.js';
import { handleLocalSettingsRoute } from './routes/localSettings.js';
import { handlePerformanceRoute } from './routes/performance.js';
import { handlePhotoshopRoute } from './routes/photoshop.js';
import { handleProjectsRoute } from './routes/projects.js';
import { publicWorkspaceFilePattern } from './services/publicWorkspaceFile.js';
import { initializeWorkspace } from './services/workspaceService.js';

const runtimeVersion = '0.1.10';
const workspaceVersion = '0.6.0';
const capabilities = [
  'texture-painting',
  'local-files',
  'project-storage',
  'dcc-bridge',
  'photoshop-bridge',
  'atlas-personal-auth',
  'liclick-generation',
  'performance-telemetry',
] as const;

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

function serveWorkspaceFile(request: IncomingMessage, response: ServerResponse, url: URL) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    sendJson(response, 405, { error: 'Method not allowed.' });
    return;
  }

  let relative: string;
  try {
    relative = decodeURIComponent(url.pathname.replace(/^\/workspace\/?/, '')).replaceAll('\\', '/');
  } catch {
    sendJson(response, 400, { error: 'Invalid workspace path.' });
    return;
  }
  const publicPathMatch = publicWorkspaceFilePattern.exec(relative);
  if (!publicPathMatch) {
    sendJson(response, 403, { error: 'Workspace file is not public.' });
    return;
  }

  const workspaceRoot = path.resolve(serverConfig.workspaceDir);
  const publicRoot = path.resolve(workspaceRoot, publicPathMatch[1]);
  const absolute = path.resolve(publicRoot, publicPathMatch[2]);
  if (!isWithinDirectory(workspaceRoot, publicRoot) || !isWithinDirectory(publicRoot, absolute)) {
    sendJson(response, 403, { error: 'Forbidden.' });
    return;
  }
  if (!fs.existsSync(absolute) || fs.statSync(absolute).isDirectory()) {
    sendJson(response, 404, { error: 'File not found.' });
    return;
  }

  const realWorkspaceRoot = fs.realpathSync(workspaceRoot);
  const realPublicRoot = fs.realpathSync(publicRoot);
  const realAbsolute = fs.realpathSync(absolute);
  if (!isWithinDirectory(realWorkspaceRoot, realPublicRoot) || !isWithinDirectory(realPublicRoot, realAbsolute)) {
    sendJson(response, 403, { error: 'Forbidden.' });
    return;
  }

  response.writeHead(200, {
    'content-type': mimeTypes[path.extname(realAbsolute).toLowerCase()] ?? 'application/octet-stream',
    ...corsHeaders(response),
    'cache-control': 'no-cache, no-store, must-revalidate',
    'x-content-type-options': 'nosniff',
  });
  if (request.method === 'HEAD') response.end();
  else fs.createReadStream(realAbsolute).pipe(response);
}

async function handleRequest(request: IncomingMessage, response: ServerResponse) {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`);
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
      name: 'LIclick 3D Texture Local Component',
      runtimeVersion,
      contentVersion: workspaceVersion,
      workspaceVersion,
      capabilities,
    });
    return;
  }
  if (url.pathname.startsWith('/workspace/')) {
    serveWorkspaceFile(request, response, url);
    return;
  }
  if (
    url.pathname.startsWith('/api/local-liclick-account') &&
    (await handleLocalLiclickAccountRoute(request, response, url))
  )
    return;
  if (
    (url.pathname.startsWith('/api/liclick') || url.pathname === '/api/generate-image') &&
    (await handleLocalLiclickRoute(request, response, url))
  )
    return;
  if (url.pathname === '/api/local-settings' && (await handleLocalSettingsRoute(request, response, url))) return;
  if (url.pathname.startsWith('/api/performance') && (await handlePerformanceRoute(request, response, url))) return;
  if (url.pathname.startsWith('/api/photoshop') && (await handlePhotoshopRoute(request, response, url))) return;
  if (url.pathname.startsWith('/api/projects') && (await handleAssetsRoute(request, response, url))) return;
  if (url.pathname.startsWith('/api/projects') && (await handleExportRoute(request, response, url))) return;
  if (url.pathname.startsWith('/api/projects') && (await handleProjectsRoute(request, response, url))) return;
  if (url.pathname.startsWith('/api/folders') && (await handleFoldersRoute(request, response, url))) return;
  sendJson(response, 404, { error: 'Route not found.' });
}

async function startServer() {
  process.env.LICLICK_LOCAL_COMPONENT_MODE = '1';
  await initializeWorkspace();

  const server = createServer(async (request, response) => {
    try {
      await handleRequest(request, response);
    } catch (error) {
      console.error('[LIclick Local Component]', error);
      sendJson(response, 500, {
        error: error instanceof Error ? error.message : 'Internal server error.',
      });
    }
  });
  photoshopBridge.attach(server);
  server.on('error', (error: NodeJS.ErrnoException) => {
    console.error('[LIclick Local Component]', error);
    process.exitCode = 1;
  });
  server.listen(serverConfig.port, serverConfig.host, () => {
    console.log(`LIclick local component running at http://${serverConfig.host}:${serverConfig.port}`);
    console.log(`Workspace: ${serverConfig.workspaceDir}`);
  });
}

void startServer();
