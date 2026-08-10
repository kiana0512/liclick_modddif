import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';

import { buildContentAwareSurfaceTopology } from '../buildSurfaceTopology.ts';

function createSharpUvSeam() {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    'position',
    new THREE.Float32BufferAttribute(
      [
        0, 0, 0, 1, 0, 0, 0, 1, 0,
        0, 0, 0, 0, 1, 0, 0, 0, 1,
      ],
      3,
    ),
  );
  geometry.setAttribute(
    'uv',
    new THREE.Float32BufferAttribute(
      [
        0.05, 0.05, 0.45, 0.05, 0.05, 0.95,
        0.55, 0.05, 0.55, 0.95, 0.95, 0.05,
      ],
      2,
    ),
  );
  geometry.computeVertexNormals();
  const group = new THREE.Group();
  group.add(new THREE.Mesh(geometry, new THREE.MeshBasicMaterial()));
  return group;
}

test('sharp physical seam is an explicit bridge without merging regular components', async () => {
  const topology = await buildContentAwareSurfaceTopology(createSharpUvSeam(), 64, 64, {
    includeSeamLinks: true,
    seamBandPixels: 2,
    minimumSeamNormalDot: 0.72,
    minimumSeamBridgeNormalDot: -0.12,
  });

  assert.equal(topology.componentCount, 2, 'sharp faces were merged into regular propagation');
  assert.ok(topology.seamLinkCount > 0, 'shared 90-degree edge did not create a repair bridge');
});

test('default seam threshold still rejects the same sharp edge', async () => {
  const topology = await buildContentAwareSurfaceTopology(createSharpUvSeam(), 64, 64, {
    includeSeamLinks: true,
    seamBandPixels: 2,
    minimumSeamNormalDot: 0.72,
  });

  assert.equal(topology.componentCount, 2);
  assert.equal(topology.seamLinkCount, 0);
});
