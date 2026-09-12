import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { stdout } from 'node:process';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const server = await createServer({
  root,
  appType: 'custom',
  logLevel: 'silent',
  server: { middlewareMode: true, watch: { ignored: () => true } },
});

try {
  const appSource = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8');
  const { nextRetainedTextureProjectId, persistentTextureProjectId } =
    await server.ssrLoadModule('/src/features/workflow/persistentTextureEditor.ts');

  assert.equal(nextRetainedTextureProjectId(undefined, { name: 'editor', projectId: 'p1' }), 'p1');
  assert.equal(persistentTextureProjectId('p1', { name: 'autoUv', projectId: 'p1' }), 'p1');
  assert.equal(persistentTextureProjectId('p1', { name: 'bake', projectId: 'p1' }), 'p1');
  assert.equal(
    persistentTextureProjectId('p1', { name: 'autoRetopology', projectId: 'p1' }),
    'p1',
  );
  assert.equal(
    persistentTextureProjectId('p1', { name: 'bake', projectId: 'p2' }),
    undefined,
    'A different project must not reuse the previous renderer.',
  );
  assert.equal(
    nextRetainedTextureProjectId('p1', { name: 'home' }),
    undefined,
    'Leaving the project workflow must release the retained renderer.',
  );
  assert.match(appSource, /nextRetainedTextureProjectId\(/);
  assert.match(appSource, /route\.name === 'autoRetopology'/);
  assert.match(appSource, /route\.name === 'autoUv'/);
  assert.match(appSource, /route\.name === 'bake'/);
  assert.doesNotMatch(appSource, /\shidden=\{!textureWorkspaceActive\}/);
  assert.match(appSource, /pointer-events-none fixed inset-0 -z-10 h-screen w-screen opacity-0/);

  stdout.write('Persistent texture editor regression test passed.\n');
} finally {
  await server.close();
}
