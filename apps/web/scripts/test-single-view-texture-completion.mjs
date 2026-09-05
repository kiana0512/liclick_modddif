import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const [panel, workerClient, worker] = await Promise.all([
  fs.readFile(path.join(root, 'src/components/panels/GeneratePanel.tsx'), 'utf8'),
  fs.readFile(
    path.join(root, 'src/engine/generation/singleViewTextureCompletionWorker.ts'),
    'utf8',
  ),
  fs.readFile(path.join(root, 'src/workers/singleViewTextureCompletion.worker.ts'), 'utf8'),
]);

assert.match(
  panel,
  /!isMultiviewRequest\s*&&\s*!usesRemoteSingleView\s*&&\s*hasVisibleTextureLayerCandidate\(objectId\)/,
  'existing-texture completion must be limited to GPT single-view generation',
);
assert.match(
  panel,
  /captureCurrentColorPreview\(\{[\s\S]*?colorMode: 'flat-target-coverage'[\s\S]*?cameraSnapshot: singleViewCameraSnapshot/,
  'the current BaseColor effect must use the frozen single-view camera',
);
assert.match(
  panel,
  /prepareSingleViewTextureCompletion\(\{[\s\S]*?currentEffectUrl:[\s\S]*?clayPreviewUrl:[\s\S]*?objectMaskUrl:/,
  'the guide must combine current effect, clay and the exact object silhouette',
);
assert.match(
  panel,
  /colorUrl: singleViewCompletion!\.imageUrl![\s\S]*?maskUrl: singleViewCompletion!\.completionMaskUrl!/
,
  'the generated guide and its local paintback mask must stay paired',
);
assert.match(
  panel,
  /texturePrompt = buildTextureMapCompletionPrompt\(prompt\)/,
  'partial coverage must select the white-model completion prompt',
);
assert.match(
  panel,
  /referenceIds: \[modelViewReference\.id, materialReference\.id\][\s\S]*?referenceImages: \[modelViewReference, materialReference\]/,
  'Atlas must still receive exactly the guide and material reference',
);
assert.match(panel, /图一中已经具有颜色、纹理和材质的区域属于锁定内容/);
assert.match(panel, /输出应接近用于3D投影的Base Color \/ Albedo/);

assert.match(worker, /inferProjectionGapMask\(currentPixels, targetMask, 1\)/);
assert.match(worker, /minimumVisiblePixels = Math\.max\(64, Math\.round\(objectPixelCount \* 0\.0005\)\)/);
assert.match(worker, /compositePixels\[offset\] = clayPixels\.data\[offset\]/);
assert.match(worker, /maskToImageData\(gapMask\.data, width, height\)/);
assert.doesNotMatch(worker, /white|gray|grey.*threshold/i, 'coverage must not use a white/grey color heuristic');

assert.match(workerClient, /new Worker\([\s\S]*?singleViewTextureCompletion\.worker\.ts/);
assert.match(workerClient, /createRegisteredObjectUrl\(event\.data\.compositeBlob\)/);
assert.match(workerClient, /createRegisteredObjectUrl\(event\.data\.completionMaskBlob\)/);
assert.match(
  await fs.readFile(path.join(root, 'src/engine/capture/captureCurrentView.ts'), 'utf8'),
  /forceEmptyProjectionHatch[\s\S]*?showEmptyProjectionHatch/,
  'coverage capture must force the renderer-owned hatch independently from viewport UI state',
);

console.log('Single-view texture completion regression checks passed.');
