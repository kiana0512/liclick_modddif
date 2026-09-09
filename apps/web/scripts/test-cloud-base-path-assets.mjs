import assert from 'node:assert/strict';
import path from 'node:path';
import { stdout } from 'node:process';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const originalWindow = globalThis.window;

globalThis.window = {
  setTimeout: globalThis.setTimeout,
  clearTimeout: globalThis.clearTimeout,
  location: {
    href: 'http://127.0.0.1:5646/li3d/',
    hostname: '127.0.0.1',
    port: '5646',
    protocol: 'http:',
    origin: 'http://127.0.0.1:5646',
  },
};

const server = await createServer({
  root,
  appType: 'custom',
  logLevel: 'silent',
  server: { middlewareMode: true, watch: { ignored: () => true } },
});

try {
  const { directAssetPathAtBase, workspacePathAtBase } = await server.ssrLoadModule(
    '/src/services/workspaceApiClient.ts',
  );
  const base = 'http://127.0.0.1:5646/li3d';
  const directPath = '/api/projects/project-1/assets/asset-1/content';
  const workspacePath = '/workspace/users/user-1/projects/project-1/assets/result.png';

  assert.equal(directAssetPathAtBase(`${base}${directPath}`, base), directPath);
  assert.equal(
    directAssetPathAtBase(`http://127.0.0.1:5646${directPath}`, base),
    directPath,
    'A same-origin asset written before /li3d was introduced must remain a local Cloud asset.',
  );
  assert.equal(
    directAssetPathAtBase(`http://127.0.0.1:5647${directPath}`, base),
    undefined,
    'A different origin must never be reclassified as a workspace asset.',
  );
  assert.equal(workspacePathAtBase(`${base}${workspacePath}`, base), workspacePath);
  assert.equal(
    workspacePathAtBase(`http://127.0.0.1:5646${workspacePath}`, base),
    workspacePath,
  );

  stdout.write('Cloud public-base asset compatibility checks passed.\n');
} finally {
  await server.close();
  if (originalWindow === undefined) delete globalThis.window;
  else globalThis.window = originalWindow;
}
