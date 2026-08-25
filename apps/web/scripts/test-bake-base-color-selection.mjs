import assert from 'node:assert/strict';
import path from 'node:path';
import { stdout } from 'node:process';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import * as THREE from 'three';

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
    resolveBakeUvMergePlan,
    requiresTextureUvMergeBeforeBake,
    selectBakeBaseColor,
  } = await server.ssrLoadModule('/src/features/workflow/selectBakeBaseColor.ts');
  const { bakePbrPreviewLightingIntoUv, UV_MERGE_COMPOSITION_VERSION } = await server.ssrLoadModule(
    '/src/engine/layers/mergeUvComposition.ts',
  );

  const lightingGeometry = new THREE.BufferGeometry();
  lightingGeometry.setAttribute(
    'position',
    new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3),
  );
  lightingGeometry.setAttribute(
    'normal',
    new THREE.Float32BufferAttribute([0, 1, 0, 0, 1, 0, 0, 1, 0], 3),
  );
  lightingGeometry.setAttribute(
    'uv',
    new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1], 2),
  );
  const lightingRoot = new THREE.Group();
  lightingRoot.add(new THREE.Mesh(lightingGeometry));
  const ordinaryPixels = new Uint8ClampedArray(4 * 4).fill(128);
  for (let offset = 3; offset < ordinaryPixels.length; offset += 4) ordinaryPixels[offset] = 255;
  await bakePbrPreviewLightingIntoUv({
    rgba: ordinaryPixels,
    width: 2,
    height: 2,
    root: lightingRoot,
    settings: {
      exposure: 1.25,
      pbrEnvironmentIntensity: 0.84,
      pbrKeyLightIntensity: 2,
      pbrLightAzimuth: 38,
      environmentPreset: 'studio',
    },
  });
  assert(
    ordinaryPixels[0] > 128,
    'An ordinary BaseColor texel should receive the current PBR preview light.',
  );
  const renderedPixels = new Uint8ClampedArray(ordinaryPixels.length).fill(128);
  for (let offset = 3; offset < renderedPixels.length; offset += 4) renderedPixels[offset] = 255;
  await bakePbrPreviewLightingIntoUv({
    rgba: renderedPixels,
    width: 2,
    height: 2,
    root: lightingRoot,
    renderedColorMask: new Uint8Array(4).fill(255),
    settings: {
      exposure: 1.25,
      pbrEnvironmentIntensity: 0.84,
      pbrKeyLightIntensity: 2,
      pbrLightAzimuth: 38,
      environmentPreset: 'studio',
    },
  });
  assert.equal(
    renderedPixels[0],
    128,
    'A local-repaint display-color texel must not receive PBR light twice.',
  );

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
  assert.equal(
    findMergedUvBakeLayer(
      [
        ...project.layers,
        layer({
          id: 'hidden-merged',
          name: 'Hidden merged UV',
          imageUrl: '/hidden-merged.png',
          role: 'merged-uv',
          visible: false,
          order: -1,
        }),
      ],
      'object-1',
    ).id,
    'merged-current',
  );
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

  const mergePlanLayers = [
    layer({
      id: 'merged',
      name: 'Merged UV',
      imageUrl: '/merged.png',
      role: 'merged-uv',
      order: 0,
    }),
    layer({
      id: 'projection-delta',
      name: 'Projected delta',
      type: 'projected',
      imageUrl: '/projection-delta.png',
      camera: { position: [0, 0, 1] },
      order: 1,
    }),
    layer({
      id: 'global-projection-delta',
      name: 'Global projected delta',
      type: 'projected',
      objectId: undefined,
      imageUrl: '/global-projection-delta.png',
      camera: { position: [0, 0, 1] },
      order: 2,
    }),
    layer({
      id: 'hidden-projection',
      name: 'Hidden projection',
      type: 'projected',
      imageUrl: '/hidden-projection.png',
      camera: { position: [0, 0, 1] },
      visible: false,
    }),
    layer({
      id: 'other-projection',
      name: 'Other object projection',
      type: 'projected',
      objectId: 'object-2',
      imageUrl: '/other-projection.png',
      camera: { position: [0, 0, 1] },
    }),
    layer({
      id: 'camera-less-projection',
      name: 'Incomplete projection',
      type: 'projected',
      imageUrl: '/camera-less-projection.png',
    }),
    layer({
      id: 'content-aware-delta',
      name: 'Content-aware underlay',
      role: 'content-aware-underlay',
      imageUrl: '/repair.png',
    }),
    layer({
      id: 'hidden-content-aware',
      name: 'Hidden content-aware underlay',
      role: 'content-aware-underlay',
      imageUrl: '/hidden-repair.png',
      visible: false,
    }),
    layer({
      id: 'other-content-aware',
      name: 'Other object content-aware underlay',
      role: 'content-aware-underlay',
      objectId: 'object-2',
      imageUrl: '/other-repair.png',
    }),
  ];
  assert.deepEqual(resolveBakeUvMergePlan(mergePlanLayers, 'object-1'), {
    action: 'merge',
    objectId: 'object-1',
    mergedLayer: mergePlanLayers[0],
    baseUvLayerId: 'merged',
    sourceLayerIds: [
      'projection-delta',
      'global-projection-delta',
      'content-aware-delta',
    ],
    projectedLayerIds: ['projection-delta', 'global-projection-delta'],
    uvUnderlayLayerIds: ['content-aware-delta'],
    reason: 'visible-layer-delta',
  });
  assert.equal(hasWorkflowBakeBaseColor(mergePlanLayers, 'object-1'), false);
  assert.equal(
    requiresTextureUvMergeBeforeBake({ layers: mergePlanLayers, activeObjectId: 'object-1' }),
    true,
  );

  const reusableLayers = mergePlanLayers.filter(
    (item) =>
      item.id === 'merged' ||
      item.id === 'hidden-projection' ||
      item.id === 'other-projection' ||
      item.id === 'camera-less-projection' ||
      item.id === 'hidden-content-aware' ||
      item.id === 'other-content-aware',
  );
  assert.deepEqual(resolveBakeUvMergePlan(reusableLayers, 'object-1'), {
    action: 'reuse',
    objectId: 'object-1',
    mergedLayer: reusableLayers[0],
    baseUvLayerId: 'merged',
    sourceLayerIds: [],
    projectedLayerIds: [],
    uvUnderlayLayerIds: [],
  });

  const legacyRepaintLayer = layer({
    id: 'local-repaint-projection-legacy',
    name: 'Legacy local repaint',
    type: 'projected',
    imageUrl: '/local-repaint.png',
    camera: { position: [0, 0, 1] },
    visible: false,
  });
  const legacyRepaintPlanLayers = [
    reusableLayers[0],
    legacyRepaintLayer,
    layer({
      id: 'local-repaint-projection-other-object',
      name: 'Other object local repaint',
      type: 'projected',
      objectId: 'object-2',
      imageUrl: '/other-local-repaint.png',
      camera: { position: [0, 0, 1] },
      visible: false,
    }),
    layer({
      id: 'local-repaint-projection-without-camera',
      name: 'Incomplete local repaint',
      type: 'projected',
      imageUrl: '/incomplete-local-repaint.png',
      visible: false,
    }),
  ];
  assert.deepEqual(resolveBakeUvMergePlan(legacyRepaintPlanLayers, 'object-1'), {
    action: 'merge',
    objectId: 'object-1',
    mergedLayer: reusableLayers[0],
    baseUvLayerId: 'merged',
    sourceLayerIds: ['local-repaint-projection-legacy'],
    projectedLayerIds: ['local-repaint-projection-legacy'],
    uvUnderlayLayerIds: [],
    reason: 'visible-layer-delta',
  });
  assert.equal(resolveBakeUvMergePlan([legacyRepaintLayer], 'object-1').action, 'missing');
  assert.deepEqual(
    resolveBakeUvMergePlan(
      [
        { ...reusableLayers[0], uvMergeVersion: UV_MERGE_COMPOSITION_VERSION },
        legacyRepaintLayer,
      ],
      'object-1',
    ),
    {
      action: 'reuse',
      objectId: 'object-1',
      mergedLayer: {
        ...reusableLayers[0],
        uvMergeVersion: UV_MERGE_COMPOSITION_VERSION,
      },
      baseUvLayerId: 'merged',
      sourceLayerIds: [],
      projectedLayerIds: [],
      uvUnderlayLayerIds: [],
    },
  );

  const projectedWithoutMerged = mergePlanLayers.filter(
    (item) => item.id === 'projection-delta' || item.id === 'content-aware-delta',
  );
  assert.deepEqual(resolveBakeUvMergePlan(projectedWithoutMerged, 'object-1'), {
    action: 'merge',
    objectId: 'object-1',
    mergedLayer: undefined,
    baseUvLayerId: undefined,
    sourceLayerIds: ['projection-delta', 'content-aware-delta'],
    projectedLayerIds: ['projection-delta'],
    uvUnderlayLayerIds: ['content-aware-delta'],
    reason: 'missing-merged-uv',
  });
  assert.equal(
    resolveBakeUvMergePlan(
      mergePlanLayers.filter((item) => item.id === 'content-aware-delta'),
      'object-1',
    ).action,
    'missing',
  );
  assert.equal(
    resolveBakeUvMergePlan(
      [
        layer({
          id: 'hidden-only-merged',
          name: 'Hidden merged UV',
          imageUrl: '/hidden-only-merged.png',
          role: 'merged-uv',
          visible: false,
        }),
      ],
      'object-1',
    ).action,
    'missing',
  );
  assert.equal(resolveBakeUvMergePlan(mergePlanLayers, undefined).reason, 'missing-object');
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
