import { cp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const client = path.join(dist, 'client');
const server = path.join(dist, 'server');
const hostingSource = path.join(root, '.openai', 'hosting.json');
const hostingOutput = path.join(dist, '.openai', 'hosting.json');
const installerKey = 'windows/LIclick-3D-Texture-Setup-2026.07.22.1130.exe';
const installerFilename = 'LIclick 3D Texture Setup 2026.07.22.1130.exe';

await mkdir(client, { recursive: true });
for (const entry of await readdir(dist, { withFileTypes: true })) {
  if (entry.name === 'client' || entry.name === 'server' || entry.name === '.openai') continue;
  await cp(path.join(dist, entry.name), path.join(client, entry.name), {
    recursive: true,
    force: true,
  });
}

await mkdir(server, { recursive: true });
await writeFile(
  path.join(server, 'index.js'),
  `const installerKey = ${JSON.stringify(installerKey)};
const installerFilename = ${JSON.stringify(installerFilename)};
const uploadRoute = '/api/internal/installers/windows-x64/multipart';

function json(payload, init = {}) {
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json; charset=utf-8');
  return new Response(JSON.stringify(payload), { ...init, headers });
}

function uploadAuthorized(request, env) {
  const configured = env.INSTALLER_UPLOAD_TOKEN;
  if (!configured) return false;
  return request.headers.get('x-li3d-installer-token') === configured;
}

async function serveInstaller(request, env) {
  if (!env.INSTALLERS) {
    return json({ error: 'Installer storage is unavailable.' }, { status: 503 });
  }
  const installer = await env.INSTALLERS.get(installerKey);
  if (!installer) {
    return json({ error: 'Installer has not been published yet.' }, { status: 404 });
  }

  const headers = new Headers();
  installer.writeHttpMetadata(headers);
  headers.set('content-type', 'application/vnd.microsoft.portable-executable');
  headers.set(
    'content-disposition',
    \`attachment; filename="LIclick-3D-Texture-Setup.exe"; filename*=UTF-8''\${encodeURIComponent(installerFilename)}\`,
  );
  headers.set('content-length', String(installer.size));
  headers.set('cache-control', 'public, max-age=3600');
  headers.set('etag', installer.httpEtag);

  if (request.method === 'HEAD') return new Response(null, { headers });
  return new Response(installer.body, { headers });
}

async function handleMultipartUpload(request, env, url) {
  if (!uploadAuthorized(request, env)) {
    return json({ error: 'Unauthorized.' }, { status: 401 });
  }
  if (!env.INSTALLERS) {
    return json({ error: 'Installer storage is unavailable.' }, { status: 503 });
  }

  if (request.method === 'POST' && url.pathname === \`\${uploadRoute}/start\`) {
    const upload = await env.INSTALLERS.createMultipartUpload(installerKey, {
      httpMetadata: {
        contentType: 'application/vnd.microsoft.portable-executable',
        contentDisposition: \`attachment; filename="LIclick-3D-Texture-Setup.exe"\`,
      },
      customMetadata: {
        product: 'LIclick 3D Texture',
        platform: 'windows-x64',
        version: '2026.07.22.1130',
      },
    });
    return json({ key: upload.key, uploadId: upload.uploadId });
  }

  if (request.method === 'PUT' && url.pathname.startsWith(\`\${uploadRoute}/part/\`)) {
    const segments = url.pathname.slice(\`\${uploadRoute}/part/\`.length).split('/');
    const uploadId = decodeURIComponent(segments[0] ?? '');
    const partNumber = Number.parseInt(segments[1] ?? '', 10);
    if (!uploadId || !Number.isInteger(partNumber) || partNumber < 1) {
      return json({ error: 'Invalid multipart upload part.' }, { status: 400 });
    }
    const upload = env.INSTALLERS.resumeMultipartUpload(installerKey, uploadId);
    const part = await upload.uploadPart(partNumber, request.body);
    return json({ partNumber: part.partNumber, etag: part.etag });
  }

  if (request.method === 'POST' && url.pathname === \`\${uploadRoute}/complete\`) {
    const payload = await request.json();
    if (!payload?.uploadId || !Array.isArray(payload.parts)) {
      return json({ error: 'Invalid multipart completion payload.' }, { status: 400 });
    }
    const upload = env.INSTALLERS.resumeMultipartUpload(installerKey, payload.uploadId);
    const object = await upload.complete(payload.parts);
    return json({ ok: true, key: object.key, size: object.size, etag: object.etag });
  }

  if (request.method === 'POST' && url.pathname === \`\${uploadRoute}/abort\`) {
    const payload = await request.json();
    if (!payload?.uploadId) {
      return json({ error: 'Missing uploadId.' }, { status: 400 });
    }
    const upload = env.INSTALLERS.resumeMultipartUpload(installerKey, payload.uploadId);
    await upload.abort();
    return json({ ok: true });
  }

  return json({ error: 'Not found.' }, { status: 404 });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (
      url.pathname === '/api/runtime/download/windows-x64' &&
      (request.method === 'GET' || request.method === 'HEAD')
    ) {
      return serveInstaller(request, env);
    }
    if (url.pathname.startsWith(uploadRoute)) {
      return handleMultipartUpload(request, env, url);
    }

    const response = await env.ASSETS.fetch(request);
    if (response.status !== 404 || request.method !== 'GET') return response;
    url.pathname = '/index.html';
    return env.ASSETS.fetch(new Request(url, request));
  },
};
`,
);

await mkdir(path.dirname(hostingOutput), { recursive: true });
await writeFile(hostingOutput, await readFile(hostingSource));
