import { cp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const client = path.join(dist, 'client');
const server = path.join(dist, 'server');
const hostingSource = path.join(root, '.openai', 'hosting.json');
const hostingOutput = path.join(dist, '.openai', 'hosting.json');

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
  `export default {
  async fetch(request, env) {
    const response = await env.ASSETS.fetch(request);
    if (response.status !== 404 || request.method !== 'GET') return response;
    const url = new URL(request.url);
    url.pathname = '/index.html';
    return env.ASSETS.fetch(new Request(url, request));
  },
};
`,
);

await mkdir(path.dirname(hostingOutput), { recursive: true });
await writeFile(hostingOutput, await readFile(hostingSource));
