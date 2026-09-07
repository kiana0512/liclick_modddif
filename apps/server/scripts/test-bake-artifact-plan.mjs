import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
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

// Run the compiled production roughness stage with controlled asynchronous I/O.
// No remote service or user project is involved.
const service = await fs.readFile(
  new URL('../dist/services/substanceBakeService.js', import.meta.url), 'utf8',
);
const stageStart = service.lastIndexOf(
  'if (job.settings.generateRoughnessFromBakedBaseColor)',
  service.indexOf('const bakedBaseColorPath = job.outputPaths.baseColor'),
);
const stageEnd = service.indexOf('job.outputs = outputs;', stageStart);
assert(stageStart >= 0 && stageEnd > stageStart);
const runStage = new (Object.getPrototypeOf(async function () {}).constructor)(
  'job', 'outputs', 'fs', 'path', 'generateRemoteRoughness', 'pngSize', 'appendLog', 'persist',
  service.slice(stageStart, stageEnd),
);
for (const failure of [undefined, 'read', 'remote', 'mime', 'write', 'dimensions']) {
  const events = [];
  const job = {
    id: 'test-job', progress: 90, remote: {},
    settings: { generateRoughnessFromBakedBaseColor: true, resolution: 4096 },
    outputPaths: { baseColor: 'base.png', roughness: 'roughness.png' },
  };
  const outputs = { baseColor: {} };
  const source = Buffer.from('original input bytes');
  const result = Buffer.from('original output bytes');
  let wrote = false;
  const promise = runStage(job, outputs, {
    existsSync: () => true,
    promises: {
      async readFile(file) {
        assert.equal(file, 'base.png');
        events.push('read');
        await new Promise((resolve) => setImmediate(resolve));
        events.push('read-finished');
        if (failure === 'read') throw new Error('read');
        return source;
      },
      async writeFile(file, bytes) {
        assert.equal(file, 'roughness.png');
        assert.equal(bytes, result);
        assert.equal(outputs.roughness, undefined);
        events.push('write');
        await new Promise((resolve) => setImmediate(resolve));
        if (failure === 'write') throw new Error('write');
        wrote = true;
        events.push('write-finished');
      },
    },
  }, path, async (input) => {
    assert.equal(input.data, source, 'The remote service receives the original bytes');
    assert(events.includes('read-finished'));
    events.push('remote');
    if (failure === 'remote') throw new Error('remote');
    return { data: result, contentType: failure === 'mime' ? 'text/plain' : 'image/png' };
  }, () => {
    assert(wrote, 'Dimensions must be checked only after the entire write completes');
    events.push('dimensions');
    return { width: failure === 'dimensions' ? 2048 : 4096, height: 4096 };
  }, () => {}, () => {});
  if (failure) {
    await assert.rejects(promise);
    assert.equal(outputs.roughness, undefined, 'A failed stage cannot publish an output');
    assert.notEqual(job.remote.stage, 'roughness-finished');
  } else {
    assert.deepEqual(events, ['read'], 'The main loop regains control while reading');
    await promise;
    assert.deepEqual(events, ['read', 'read-finished', 'remote', 'write', 'write-finished', 'dimensions']);
    assert.equal(outputs.roughness.width, 4096);
    assert.equal(job.remote.stage, 'roughness-finished');
  }
}
process.stdout.write('Bake artifact plan and asynchronous roughness I/O regression passed.\n');
