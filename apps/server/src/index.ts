import fs from 'node:fs';
import path from 'node:path';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { serverConfig } from './config.js';
import { handleAssetsRoute } from './routes/assets.js';
import { handleAuthRoute } from './routes/auth.js';
import { handleExportRoute } from './routes/export.js';
import { handleFoldersRoute } from './routes/folders.js';
import { handleLiclickRoute } from './routes/liclick.js';
import { sendJson, sendNoContent } from './routes/httpUtils.js';
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

function serveWorkspaceFile(response: ServerResponse, url: URL) {
  const relative = decodeURIComponent(url.pathname.replace(/^\/workspace\/?/, ''));
  const absolute = path.resolve(serverConfig.workspaceDir, relative);
  if (!absolute.startsWith(serverConfig.workspaceDir)) {
    sendJson(response, 403, { error: 'Forbidden.' });
    return true;
  }
  if (!fs.existsSync(absolute) || fs.statSync(absolute).isDirectory()) {
    sendJson(response, 404, { error: 'File not found.' });
    return true;
  }
  response.writeHead(200, {
    'content-type': mimeTypes[path.extname(absolute).toLowerCase()] ?? 'application/octet-stream',
    'access-control-allow-origin': '*',
  });
  fs.createReadStream(absolute).pipe(response);
  return true;
}

async function handleWorkspaceRequest(
  request: IncomingMessage,
  response: ServerResponse,
) {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`);
  const routeUrl =
    url.pathname === '/callback'
      ? new URL(`/api/auth/feishu/callback${url.search}`, `${url.protocol}//${url.host}`)
      : url;
  if (request.method === 'OPTIONS') {
    sendNoContent(response);
    return;
  }
  if (routeUrl.pathname === '/api/health') {
    sendJson(response, 200, {
      ok: true,
      workspaceDir: serverConfig.workspaceDir,
      workspaceVersion: '0.6.0',
    });
    return;
  }
  if (routeUrl.pathname.startsWith('/workspace/')) {
    serveWorkspaceFile(response, routeUrl);
    return;
  }
  if (routeUrl.pathname.startsWith('/api/auth') && (await handleAuthRoute(request, response, routeUrl))) return;
  if (routeUrl.pathname.startsWith('/api/liclick') && (await handleLiclickRoute(request, response, routeUrl))) return;
  if (routeUrl.pathname.startsWith('/api/projects') && (await handleAssetsRoute(request, response, routeUrl))) return;
  if (routeUrl.pathname.startsWith('/api/projects') && (await handleExportRoute(request, response, routeUrl))) return;
  if (routeUrl.pathname.startsWith('/api/projects') && (await handleProjectsRoute(request, response, routeUrl))) return;
  if (routeUrl.pathname.startsWith('/api/folders') && (await handleFoldersRoute(request, response, routeUrl))) return;
  sendJson(response, 404, { error: 'Route not found.' });
}

function shouldStartFeishuLocalCallbackServer() {
  try {
    const redirectUrl = new URL(serverConfig.feishu.redirectUri);
    return (
      redirectUrl.hostname === 'localhost' &&
      redirectUrl.pathname === '/callback' &&
      Number(redirectUrl.port) !== serverConfig.port
    );
  } catch {
    return false;
  }
}

function startFeishuLocalCallbackServer() {
  if (!shouldStartFeishuLocalCallbackServer()) return;
  const callbackServer = createServer(async (request, response) => {
    try {
      await handleWorkspaceRequest(request, response);
    } catch (error) {
      console.error('[Liclick Feishu OAuth Callback]', error);
      sendJson(response, 500, { error: error instanceof Error ? error.message : 'Internal server error.' });
    }
  });
  callbackServer.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EADDRINUSE') {
      console.warn(
        `[Liclick Feishu OAuth Callback] localhost:${serverConfig.feishu.localCallbackPort} is already in use. Feishu login can still open, but callback may be handled by that process.`,
      );
      return;
    }
    console.error('[Liclick Feishu OAuth Callback]', error);
  });
  callbackServer.listen(serverConfig.feishu.localCallbackPort, '127.0.0.1', () => {
    console.log(
      `Liclick Feishu OAuth callback listening at http://localhost:${serverConfig.feishu.localCallbackPort}/callback`,
    );
  });
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

  server.listen(serverConfig.port, '127.0.0.1', () => {
    console.log(`Liclick workspace server running at http://127.0.0.1:${serverConfig.port}`);
    console.log(`Workspace: ${serverConfig.workspaceDir}`);
    startFeishuLocalCallbackServer();
  });
}

void startServer();
