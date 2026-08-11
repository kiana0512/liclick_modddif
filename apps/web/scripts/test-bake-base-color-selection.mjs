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

function layer(overrides) {
  return {
    id: overrides.id,
    name: overrides.name,
    type: 'uv',
    imageUrl: overrides.imageUrl,
    objectId: 'object-1',
    visible: true,
    opacity: 1,
    blendMode: 'normal',
    order: 0,
    createdAt: '2026-08-11T00:00:00.000Z',
    ...overrides,
  };
}

try {
  const {
    findMergedUvBakeLayer,
    findVisibleProjectedLayerIdsForBake,
    hasWorkflowBakeBaseColor,
    isBakeMergeModelReady,
    requiresTextureUvMergeBeforeBake,
    selectBakeBaseColor,
  } = await server.ssrLoadModule('/src/features/workflow/selectBakeBaseColor.ts');

  const project = {
    layers: [
      layer({ id: 'base', name: 'Base texture', imageUrl: '/base.png', role: 'base-color', order: 2 }),
      layer({ id: 'merged-old', name: '旧合并 UV', imageUrl: '/merged-old.png', role: 'merged-uv', order: 1 }),
      layer({ id: 'merged-current', name: '合并 UV 图层', imageUrl: '/merged-current.png', role: 'merged-uv', order: 0 }),
      layer({ id: 'projection', name: '投影贴图', imageUrl: '/projection.png', type: 'projected', order: 0 }),
    ],
    bakedTextures: [
      { id: 'stale-bake', objectId: 'object-1', imageUrl: '/stale-bake.png', createdAt: '2026-08-11T01:00:00.000Z' },
    ],
  };

  assert.equal(findMergedUvBakeLayer(project.layers, 'object-1').id, 'merged-current');
  assert.equal(hasWorkflowBakeBaseColor(project.layers, 'object-1'), true);
  assert.equal(hasWorkflowBakeBaseColor(project.layers, 'missing-object'), false);
  assert.equal(
    requiresTextureUvMergeBeforeBake({ ...project, activeObjectId: 'object-1' }),
    false,
  );
  assert.equal(
    requiresTextureUvMergeBeforeBake(
      { ...project, activeObjectId: 'missing-object' },
      { objectId: 'missing-object' },
    ),
    true,
  );
  assert.equal(
    requiresTextureUvMergeBeforeBake(
      { ...project, activeObjectId: 'missing-object' },
      {
        objectId: 'missing-object',
        baseColor: { name: 'UV Base Color', imageUrl: '/handoff.png' },
      },
    ),
    false,
  );
  assert.deepEqual(
    findVisibleProjectedLayerIdsForBake(
      [
        { ...project.layers[3], camera: { position: [0, 0, 1] } },
        { ...project.layers[3], id: 'hidden', visible: false, camera: { position: [0, 0, 1] } },
        { ...project.layers[3], id: 'other', objectId: 'object-2', camera: { position: [0, 0, 1] } },
      ],
      'object-1',
    ),
    ['projection'],
  );
  assert.equal(isBakeMergeModelReady(undefined, 'object-1'), false);
  assert.equal(
    isBakeMergeModelReady({ objectId: 'object-1', restoreStage: 'bounds' }, 'object-1'),
    false,
  );
  assert.equal(
    isBakeMergeModelReady({ objectId: 'object-1', restoreStage: 'outline' }, 'object-1'),
    false,
  );
  assert.equal(
    isBakeMergeModelReady({ objectId: 'object-1', restoreStage: 'full' }, 'object-1'),
    true,
  );
  assert.equal(isBakeMergeModelReady({ objectId: 'object-1' }, 'object-1'), true);
  assert.equal(
    isBakeMergeModelReady({ objectId: 'object-2', restoreStage: 'full' }, 'object-1'),
    false,
  );
  assert.deepEqual(selectBakeBaseColor(project, 'object-1'), {
    name: '合并 UV 图层',
    imageUrl: '/merged-current.png',
  });
  assert.deepEqual(
    selectBakeBaseColor(project, 'object-1', {
      objectId: 'object-1',
      baseColor: { name: '本次传入的合并 UV', imageUrl: '/handoff.png' },
    }),
    { name: '本次传入的合并 UV', imageUrl: '/handoff.png' },
  );

  const withoutMerged = {
    ...project,
    layers: project.layers.filter((item) => item.role !== 'merged-uv'),
  };
  assert.deepEqual(selectBakeBaseColor(withoutMerged, 'object-1'), {
    name: 'Base Color',
    imageUrl: '/stale-bake.png',
  });
  assert.deepEqual(selectBakeBaseColor({ ...withoutMerged, bakedTextures: [] }, 'object-1'), {
    name: 'Base texture',
    imageUrl: '/base.png',
  });
  assert.equal(selectBakeBaseColor(project, 'missing-object'), undefined);

  stdout.write('Bake Base Color selection regression test passed.\n');
} finally {
  await server.close();
}
