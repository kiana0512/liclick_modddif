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
const pngSizeStart = service.indexOf('async function pngSize');
const pngSizeEnd = service.indexOf('function multipartFileHeader', pngSizeStart);
assert(pngSizeStart >= 0 && pngSizeEnd > pngSizeStart);
assert.doesNotMatch(
  service.slice(pngSizeStart, pngSizeEnd),
  /\b(?:openSync|readSync|closeSync)\b/,
  'PNG header verification must use asynchronous file handles.',
);
const downloadStart = service.indexOf('async function downloadArtifacts');
const downloadEnd = service.indexOf('async function monitorRemoteJob', downloadStart);
assert(downloadStart >= 0 && downloadEnd > downloadStart);
assert.doesNotMatch(
  service.slice(downloadStart, downloadEnd),
  /\b(?:existsSync|statSync|openSync|readSync)\b/,
  'Artifact download and verification must not block on synchronous filesystem calls.',
);
const stageStart = service.lastIndexOf(
  'if (job.settings.generateRoughnessFromBakedBaseColor)',
  service.indexOf('const bakedBaseColorPath = job.outputPaths.baseColor'),
);
const stageEnd = service.indexOf('job.outputs = outputs;', stageStart);
assert(stageStart >= 0 && stageEnd > stageStart);
assert.doesNotMatch(
  service.slice(stageStart, stageEnd),
  /\b(?:existsSync|statSync|openSync|readSync)\b/,
  'The asynchronous artifact stage must not block the Node event loop with synchronous file I/O.',
);
const runStage = new (Object.getPrototypeOf(async function () {}).constructor)(
  'job', 'outputs', 'fs', 'path', 'generateRemoteRoughness', 'pngSize', 'appendLog', 'persist',
  service.slice(stageStart, stageEnd),
);
for (const failure of [undefined, 'access', 'read', 'remote', 'mime', 'write', 'dimensions']) {
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
    promises: {
      async access(file) {
        assert.equal(file, 'base.png');
        events.push('access');
        await new Promise((resolve) => setImmediate(resolve));
        if (failure === 'access') throw new Error('access');
        events.push('access-finished');
      },
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
  }, async () => {
    assert(wrote, 'Dimensions must be checked only after the entire write completes');
    events.push('dimensions');
    return { width: failure === 'dimensions' ? 2048 : 4096, height: 4096 };
  }, () => {}, () => {});
  if (failure) {
    await assert.rejects(promise);
    assert.equal(outputs.roughness, undefined, 'A failed stage cannot publish an output');
    assert.notEqual(job.remote.stage, 'roughness-finished');
  } else {
    assert.deepEqual(events, ['access'], 'The main loop regains control while checking the input file');
    await promise;
    assert.deepEqual(events, [
      'access', 'access-finished', 'read', 'read-finished', 'remote',
      'write', 'write-finished', 'dimensions',
    ]);
    assert.equal(outputs.roughness.width, 4096);
    assert.equal(job.remote.stage, 'roughness-finished');
  }
}
process.stdout.write('Bake artifact plan and asynchronous roughness I/O regression passed.\n');
