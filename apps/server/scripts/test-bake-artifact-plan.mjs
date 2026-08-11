import assert from 'node:assert/strict';
import {
  bakeArtifactChannel,
  selectBakeArtifactFileNames,
} from '../dist/services/bakeArtifactPlan.js';

const fullProfile = [
  'asset_base_color.png',
  'asset_roughness.png',
  'asset_metallic.png',
  'asset_ao.png',
  'asset_normal_dx.png',
  'asset_normal_gl.png',
  'asset_world_normal.png',
  'asset_curvature.png',
  'asset_thickness.png',
  'asset_position.png',
  'baker_result.json',
  'baker.log',
];

assert.equal(bakeArtifactChannel('asset_normal_dx.png', 'directx'), 'normal');
assert.equal(bakeArtifactChannel('asset_normal_gl.png', 'directx'), undefined);
assert.equal(bakeArtifactChannel('asset_normal_gl.png', 'opengl'), 'normal');

assert.deepEqual(
  selectBakeArtifactFileNames({
    availableFileNames: fullProfile,
    channels: ['baseColor', 'normal', 'ambientOcclusion'],
    normalOrientation: 'directx',
  }),
  [
    'asset_base_color.png',
    'asset_ao.png',
    'asset_normal_dx.png',
    'baker_result.json',
    'baker.log',
  ],
);

assert.deepEqual(
  selectBakeArtifactFileNames({
    availableFileNames: fullProfile,
    channels: ['baseColor', 'normal', 'ambientOcclusion'],
    normalOrientation: 'opengl',
  }),
  [
    'asset_base_color.png',
    'asset_ao.png',
    'asset_normal_gl.png',
    'baker_result.json',
    'baker.log',
  ],
);

assert.deepEqual(
  selectBakeArtifactFileNames({
    availableFileNames: fullProfile,
    channels: ['baseColor', 'roughness'],
    normalOrientation: 'directx',
    generateRoughnessFromBakedBaseColor: true,
  }),
  ['asset_base_color.png', 'baker_result.json', 'baker.log'],
);

assert.equal(
  selectBakeArtifactFileNames({
    availableFileNames: fullProfile,
    channels: [
      'baseColor',
      'normal',
      'ambientOcclusion',
      'curvature',
      'worldNormal',
      'thickness',
      'position',
      'roughness',
      'metallic',
    ],
    normalOrientation: 'directx',
  }).length,
  11,
);

process.stdout.write('Bake artifact plan regression test passed.\n');
