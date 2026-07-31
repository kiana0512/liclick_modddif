import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const webDist = path.join(root, 'apps', 'web', 'dist');
const clientRoot = path.join(webDist, 'client');
const manifest = JSON.parse(
  await fs.readFile(path.join(clientRoot, 'downloads', 'local-component', 'manifest.json'), 'utf8'),
);
const worker = (await import(pathToFileURL(path.join(webDist, 'server', 'index.js')).href)).default;

const env = {
  ASSETS: {
    async fetch(request) {
      const relative = decodeURIComponent(new URL(request.url).pathname).replace(/^\/+/, '');
      const filePath = path.resolve(clientRoot, relative);
      const withinClient = filePath.startsWith(`${clientRoot}${path.sep}`);
      if (!withinClient) return new Response('Forbidden', { status: 403 });
      try {
        return new Response(await fs.readFile(filePath));
      } catch {
        return new Response('Not found', { status: 404 });
      }
    },
  },
};

const route = 'https://li3d.example/downloads/LIclick-3D-Texture-Local-Component-Setup.exe';
const response = await worker.fetch(new Request(route), env);
if (!response.ok) throw new Error(`Installer route returned ${response.status}.`);
const installer = Buffer.from(await response.arrayBuffer());
const sha256 = crypto.createHash('sha256').update(installer).digest('hex');
if (installer.length !== manifest.bytes || sha256 !== manifest.sha256) {
  throw new Error(`Reassembled installer mismatch: ${installer.length} bytes, ${sha256}.`);
}
if (!response.headers.get('content-disposition')?.includes('.exe')) {
  throw new Error('Installer response is missing the attachment filename.');
}
process.stdout.write(`Installer download smoke passed: ${installer.length} bytes, ${sha256}.\n`);
