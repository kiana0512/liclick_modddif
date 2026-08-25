import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { stdout } from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sceneRootSource = readFileSync(path.join(root, 'src/engine/viewport/SceneRoot.tsx'), 'utf8');
const previewTextureCacheSource = readFileSync(
  path.join(root, 'src/engine/viewport/previewTextureCache.ts'),
  'utf8',
);
const projectedMaterialSource = readFileSync(
  path.join(root, 'src/engine/projection/ProjectedLayerMaterial.ts'),
  'utf8',
);
const projectedWorkerSource = readFileSync(
  path.join(root, 'src/engine/projection/projectedTextureArrayWorker.ts'),
  'utf8',
);

assert.doesNotMatch(
  sceneRootSource,
  /const isViewportInteractionBusy = \(\) => \{[\s\S]*?paintTool === 'inpaint-apply'/,
  'Selecting a repaint tool must not indefinitely block projected material publication.',
);
assert.match(
  previewTextureCacheSource,
  /PREVIEW_BITMAP_DECODE_TIMEOUT_MS[\s\S]*?resetBitmapWorker\(new Error\('Preview texture decode timed out\.'\)\)/,
  'Preview bitmap decoding must reset a stalled worker instead of retaining a pending cache promise.',
);
assert.match(
  previewTextureCacheSource,
  /PREVIEW_BITMAP_STRIPE_TIMEOUT_MS[\s\S]*?Preview texture upload stripe timed out/,
  'Preview GPU stripe preparation must have a recovery timeout.',
);
assert.match(
  projectedMaterialSource,
  /PROJECTED_TEXTURE_REQUEST_TIMEOUT_MS[\s\S]*?Projected texture fallback load timed out/,
  'Projected texture compatibility loading must terminate stalled requests.',
);
assert.match(
  projectedMaterialSource,
  /const controller = new AbortController\(\);[\s\S]*?controller\.abort\(\)[\s\S]*?signal: controller\.signal/,
  'Projected texture fetch must abort a stalled network request.',
);
assert.match(
  projectedWorkerSource,
  /PROJECTED_ARRAY_WORKER_TIMEOUT_MS[\s\S]*?Projected texture-array worker timed out/,
  'Projected texture-array packing must restart a stalled worker slot.',
);

stdout.write('Texture load recovery regression test passed.\n');
