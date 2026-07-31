import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const client = path.join(dist, 'client');
const server = path.join(dist, 'server');
const hostingSource = path.join(root, '.openai', 'hosting.json');
const hostingOutput = path.join(dist, '.openai', 'hosting.json');
const installerRoute = '/downloads/LIclick-3D-Texture-Local-Component-Setup.exe';
const installerManifest = JSON.parse(
  await readFile(path.join(root, 'public', 'downloads', 'local-component', 'manifest.json'), 'utf8'),
);
const installerParts = installerManifest.parts.map(
  (part) => `/downloads/local-component/${part.file}`,
);

await mkdir(client, { recursive: true });
for (const entry of await readdir(dist, { withFileTypes: true })) {
  if (entry.name === 'client' || entry.name === 'server' || entry.name === '.openai') continue;
  await cp(path.join(dist, entry.name), path.join(client, entry.name), {
    recursive: true,
    force: true,
  });
  await rm(path.join(dist, entry.name), { recursive: true, force: true });
}

await mkdir(server, { recursive: true });
await writeFile(
  path.join(server, 'index.js'),
  `const installerRoute = ${JSON.stringify(installerRoute)};
const installerFilename = ${JSON.stringify(installerManifest.filename)};
const installerContentType = ${JSON.stringify(installerManifest.contentType)};
const installerBytes = ${JSON.stringify(installerManifest.bytes)};
const installerSha256 = ${JSON.stringify(installerManifest.sha256)};
const installerParts = ${JSON.stringify(installerParts)};

function installerStream(request, env) {
  let partIndex = 0;
  let reader;
  return new ReadableStream({
    async pull(controller) {
      try {
        while (partIndex < installerParts.length) {
          if (!reader) {
            const partUrl = new URL(installerParts[partIndex], request.url);
            const response = await env.ASSETS.fetch(new Request(partUrl));
            if (!response.ok || !response.body) {
              throw new Error(\`Installer part \${partIndex + 1} is unavailable.\`);
            }
            reader = response.body.getReader();
          }
          const result = await reader.read();
          if (!result.done) {
            controller.enqueue(result.value);
            return;
          }
          reader = undefined;
          partIndex += 1;
        }
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel(reason) {
      await reader?.cancel(reason);
    },
  });
}

function serveInstaller(request, env) {
  const headers = new Headers({
    'content-type': installerContentType,
    'content-disposition': \`attachment; filename="LIclick-3D-Texture-Local-Component-Setup.exe"; filename*=UTF-8''\${encodeURIComponent(installerFilename)}\`,
    'content-length': String(installerBytes),
    'cache-control': 'public, max-age=3600',
    'x-li3d-installer-sha256': installerSha256,
  });
  if (request.method === 'HEAD') return new Response(null, { headers });
  return new Response(installerStream(request, env), { headers });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === installerRoute && (request.method === 'GET' || request.method === 'HEAD')) {
      return serveInstaller(request, env);
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
