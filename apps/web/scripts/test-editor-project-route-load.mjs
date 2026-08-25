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
  server: { middlewareMode: true },
});

try {
  const { isEditorProjectViewportReady } = await server.ssrLoadModule(
    '/src/services/editorProjectRouteLoad.ts',
  );

  assert.equal(
    isEditorProjectViewportReady({
      routeProjectId: 'new-project',
      serverReadyProjectId: 'new-project',
      objectCount: 0,
    }),
    true,
    'An empty newly-created project must not wait for a model-frame event.',
  );
  assert.equal(
    isEditorProjectViewportReady({
      routeProjectId: 'model-project',
      serverReadyProjectId: 'model-project',
      objectCount: 1,
    }),
    false,
    'A project with a model must keep the cover until its first WebGL frame.',
  );
  assert.equal(
    isEditorProjectViewportReady({
      routeProjectId: 'model-project',
      serverReadyProjectId: 'model-project',
      presentedViewportProjectId: 'model-project',
      objectCount: 1,
    }),
    true,
    'A model project is ready after the matching viewport frame is presented.',
  );
  assert.equal(
    isEditorProjectViewportReady({
      routeProjectId: 'model-project',
      serverReadyProjectId: 'model-project',
      presentationTimedOutProjectId: 'model-project',
      objectCount: 1,
    }),
    true,
    'A failed model presentation must eventually release the route cover.',
  );
  assert.equal(
    isEditorProjectViewportReady({
      routeProjectId: 'next-project',
      serverReadyProjectId: 'next-project',
      presentationTimedOutProjectId: 'previous-project',
      objectCount: 1,
    }),
    false,
    'A stale timeout from another route must not release the route cover.',
  );
  assert.equal(
    isEditorProjectViewportReady({
      routeProjectId: 'next-project',
      serverReadyProjectId: 'previous-project',
      presentedViewportProjectId: 'next-project',
      objectCount: 0,
    }),
    false,
    'A stale server response must never release the route cover.',
  );

  stdout.write('Editor project route loading regression test passed.\n');
} finally {
  await server.close();
}
