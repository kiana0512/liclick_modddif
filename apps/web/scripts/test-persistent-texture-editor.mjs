import assert from 'node:assert/strict';
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

  stdout.write('Persistent texture editor regression test passed.\n');
} finally {
  await server.close();
}
