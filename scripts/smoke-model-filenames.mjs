import assert from 'node:assert/strict';
import {
  displayFilename,
  englishSafeFilename,
  englishSafeStem,
} from '../apps/server/src/services/modelFilenameService.ts';

const chinese = '测试模型合集_scene (11).FBX';
const chineseSafe = englishSafeFilename(chinese, 'asset.fbx');
assert.equal(displayFilename(`../../目录\\${chinese}`, 'asset.fbx'), chinese);
assert.match(chineseSafe, /^test-model-collection-scene-11-[a-f0-9]{8}\.fbx$/);
assert.equal(englishSafeStem(chinese, 'asset'), chineseSafe.replace(/\.fbx$/, ''));

assert.equal(
  englishSafeFilename('Chair_High-v2.FBX', 'asset.fbx'),
  'chair_high-v2.fbx',
  'Already-safe ASCII names should remain readable and must not gain a hash.',
);

const properNoun = englishSafeFilename('湘子高模.fbx', 'asset.fbx');
assert.match(properNoun, /^xiang-zi-high-poly-[a-f0-9]{8}\.fbx$/);

const unsafeDisplay = displayFilename(
  '..\\folder\\\u202e测\r\n试模型.fbx',
  'asset.fbx',
);
assert.equal(unsafeDisplay, '测试模型.fbx');
assert.match(englishSafeFilename(unsafeDisplay, 'asset.fbx'), /^test-model-[a-f0-9]{8}\.fbx$/);

const firstCollision = englishSafeFilename('测试模型.fbx', 'asset.fbx');
const secondCollision = englishSafeFilename('测试-模型.fbx', 'asset.fbx');
assert.notEqual(firstCollision, secondCollision, 'Cleaned-name collisions need distinct hashes.');
assert.match(firstCollision, /^[\x20-\x7e]+$/);
assert.match(secondCollision, /^[\x20-\x7e]+$/);

assert.equal(englishSafeFilename('CON.FBX', 'asset.fbx'), 'asset-con.fbx');
assert.equal(englishSafeFilename('..\\AUX.txt', 'asset.bin'), 'asset-aux.txt');

const emoji = englishSafeFilename('🙂.FBX', 'asset.fbx');
assert.match(emoji, /^asset-[a-f0-9]{8}\.fbx$/);
assert.equal(englishSafeFilename('', 'asset.fbx'), 'asset.fbx');

const longSafe = englishSafeFilename(`${'超长模型'.repeat(80)}.FBX`, 'asset.fbx');
assert(Buffer.byteLength(longSafe, 'ascii') <= 120, 'Safe names must stay within 120 bytes.');
assert.match(longSafe, /-[a-f0-9]{8}\.fbx$/);

for (const value of [chineseSafe, properNoun, firstCollision, secondCollision, emoji, longSafe]) {
  assert.match(value, /^[a-z0-9][a-z0-9._-]*$/);
  assert(!value.includes('/') && !value.includes('\\'));
  assert(!/[\r\n]/.test(value));
}

process.stdout.write('Model filename smoke passed: display names preserved; remote names are ASCII-safe.\n');
