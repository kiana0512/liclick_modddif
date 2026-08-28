import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('../', import.meta.url));
const server = await createServer({ root, logLevel: 'silent', server: { middlewareMode: true } });

const normal = (id) => ({ type: 'projected', id, imageUrl: `asset:${id}`, blendMode: 'normal' });
const feathered = (id) => ({
  type: 'projected',
  id,
  imageUrl: `asset:${id}`,
  blendMode: 'overlay',
});
const repaint = (id) => ({
  type: 'projected',
  id: `local-repaint-${id}`,
  imageUrl: `surface-edit:local-repaint:${id}`,
  blendMode: 'normal',
});

try {
  const { getBatchedLiteralOverlaySuffix } = await server.ssrLoadModule(
    '/src/engine/bake/projectedOverlayComposition.ts',
  );
  const ids = (layers) => getBatchedLiteralOverlaySuffix(layers).map((layer) => layer.id);

  assert.deepEqual(ids([normal('base'), repaint('one')]), [], 'one repaint keeps exact path');
  assert.deepEqual(
    ids([normal('base'), repaint('one'), repaint('two')]),
    ['local-repaint-one', 'local-repaint-two'],
    'adjacent repaint overlays should batch',
  );
  assert.deepEqual(
    ids([repaint('one'), normal('later-normal'), repaint('two')]),
    ['local-repaint-one', 'local-repaint-two'],
    'normal layers do not interrupt the overlay composition sequence',
  );
  assert.deepEqual(
    ids([repaint('old'), feathered('boundary'), repaint('one'), repaint('two')]),
    ['local-repaint-one', 'local-repaint-two'],
    'batching must not cross a feathered overlay boundary',
  );
  assert.deepEqual(
    ids([repaint('one'), repaint('two'), feathered('top')]),
    [],
    'a top feathered overlay keeps the preceding literal run on the exact path',
  );
  console.log('Local repaint bake batching invariants passed.');
} finally {
  await server.close();
}
