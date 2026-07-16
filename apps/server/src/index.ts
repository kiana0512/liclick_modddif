import fs from 'node:fs';
import path from 'node:path';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { serverConfig } from './config.js';
import { handleAssetsRoute } from './routes/assets.js';
import { handleAuthRoute } from './routes/auth.js';
import { handleComfyuiRoute } from './routes/comfyui.js';
import { handleExportRoute } from './routes/export.js';
import { handleFoldersRoute } from './routes/folders.js';
import { handleLiclickRoute } from './routes/liclick.js';
import { handleLocalSettingsRoute } from './routes/localSettings.js';
import { corsHeaders, isAllowedRequestOrigin, sendJson, sendNoContent } from './routes/httpUtils.js';
import { handleProjectsRoute } from './routes/projects.js';
import { initializeWorkspace } from './services/workspaceService.js';

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

const publicWorkspaceFilePattern = /^((?:users\/[^/]+\/projects\/[^/]+|projects\/[^/]+)\/(?:assets|thumbnails|exports))\/(.+)$/;

function isWithinDirectory(root: string, candidate: string) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function serveWorkspaceFile(request: IncomingMessage, response: ServerResponse, url: URL) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    sendJson(response, 405, { error: 'Method not allowed.' });
    return true;
  }
  if (!isAllowedRequestOrigin(request)) {
    sendJson(response, 403, { error: 'Origin is not allowed.' });
    return true;
  }

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
  if (!publicPath || url.pathname === publicPath || !url.pathname.startsWith(`${publicPath}/`)) return url;
  const stripped = new URL(url.href);
  stripped.pathname = stripped.pathname.slice(publicPath.length) || '/';
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
      workspaceDir: serverConfig.workspaceDir,
      workspaceVersion: '0.6.0',
      host: serverConfig.host,
      features: {
        webOAuthCookieSession:
          serverConfig.feishuWebOAuthEnabled || serverConfig.idaasJwtSsoEnabled || serverConfig.atlasLocalLoginEnabled,
        atlasCliLogin: serverConfig.atlasLocalLoginEnabled,
        browserHttpUuidFallback: true,
      },
    });
    return;
  }
  if (url.pathname.startsWith('/workspace/')) {
    serveWorkspaceFile(request, response, url);
    return;
  }
  if (url.pathname.startsWith('/api/auth') && (await handleAuthRoute(request, response, url))) return;
  if (url.pathname === '/api/local-settings' && (await handleLocalSettingsRoute(request, response, url))) return;
  if (url.pathname.startsWith('/api/comfyui') && (await handleComfyuiRoute(request, response, url))) return;
  if (
    (url.pathname.startsWith('/api/liclick') || url.pathname === '/api/generate-image') &&
    (await handleLiclickRoute(request, response, url))
  ) return;
  if (url.pathname.startsWith('/api/projects') && (await handleAssetsRoute(request, response, url))) return;
  if (url.pathname.startsWith('/api/projects') && (await handleExportRoute(request, response, url))) return;
  if (url.pathname.startsWith('/api/projects') && (await handleProjectsRoute(request, response, url))) return;
  if (url.pathname.startsWith('/api/folders') && (await handleFoldersRoute(request, response, url))) return;
  sendJson(response, 404, { error: 'Route not found.' });
}

async function startServer() {
  await initializeWorkspace();

  const server = createServer(async (request, response) => {
    try {
      await handleWorkspaceRequest(request, response);
    } catch (error) {
      console.error('[Liclick Workspace Server]', error);
      sendJson(response, 500, { error: error instanceof Error ? error.message : 'Internal server error.' });
    }
  });

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
