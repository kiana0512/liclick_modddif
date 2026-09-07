import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';

const root = path.resolve(import.meta.dirname, '..');
const [panel, textureMapPrompts, workerClient, worker] = await Promise.all([
  fs.readFile(path.join(root, 'src/components/panels/GeneratePanel.tsx'), 'utf8'),
  fs.readFile(path.join(root, 'src/engine/generation/textureMapPrompts.ts'), 'utf8'),
  fs.readFile(
    path.join(root, 'src/engine/localRepaint/generationInputWorker.ts'),
    'utf8',
  ),
  fs.readFile(path.join(root, 'src/workers/localRepaintGenerationInput.worker.ts'), 'utf8'),
]);

assert.match(
  panel,
  /!isMultiviewRequest\s*&&\s*hasVisibleTextureLayerCandidate\(objectId\)/,
  'existing-texture inspection must be shared by GPT and remote single-view generation',
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
  /capture:\s*\{[\s\S]*?\.\.\.view\.capture,[\s\S]*?colorUrl: completionGuideUrl[\s\S]*?\}/,
  'the generated guide must replace only the Atlas input image',
);
assert.doesNotMatch(
  panel,
  /maskUrl: singleViewCompletion!\.completionMaskUrl!/,
  'the local gap mask must not crop the full Atlas result or its projection',
);
assert.match(
  panel,
  /texturePrompt = texturePromptBuilders!\.buildTextureMapCompletionPrompt\(prompt\)/,
  'GPT partial coverage must select the white-model completion prompt',
);
assert.match(
  panel,
  /usesRemoteSingleViewInpaint = true[\s\S]*?generateSingleViewInpaint\([\s\S]*?mask:\s*\{[\s\S]*?completion-mask\.png[\s\S]*?completionMaskDataUrl/,
  'remote partial coverage must route the fused image and RGB gap mask to single-view inpaint',
);
assert.match(
  panel,
  /if \(usesRemoteSingleView && singleViewCompletion\.uncoveredPixelCount === 0\)[\s\S]*?当前视角已经全部有贴图/,
  'fully covered remote views must not overwrite existing texture',
);
assert.match(
  panel,
  /return modelviewClient\.generateSingleView\([\s\S]*?white-model\.png/,
  'remote all-clay views must retain the original two-image generation path',
);
assert.match(
  panel,
  /referenceIds: \[modelViewReference\.id, materialReference\.id\][\s\S]*?referenceImages: \[modelViewReference, materialReference\]/,
  'Atlas must still receive exactly the guide and material reference',
);
assert.match(textureMapPrompts, /图一中已经具有颜色、纹理和材质的区域属于锁定内容/);
assert.match(
  textureMapPrompts,
  /只补全参考图一中尚未贴图的白色或浅灰色白模区域[\s\S]*?必须完整替换这些区域/,
  'completion must fill every unfinished white-model region',
);
assert.match(
  textureMapPrompts,
  /属于同一连续曲面的区域应跨越多边形边界自然、顺滑地延续材质[\s\S]*?不得改变真实几何位置或外轮廓/,
  'low-poly smoothing must remain an interior material operation and never reshape the silhouette',
);
assert.match(textureMapPrompts, /输出应接近用于3D投影的Base Color \/ Albedo/);
assert.doesNotMatch(
  textureMapPrompts,
  /以参考图一为目标视角，将参考图二的材质外观迁移到图一对应的可见表面/,
  'the old whole-surface fallback prompt must not remain',
);

assert.match(
  panel,
  /async function handleGeneratePairedMultiview[\s\S]*?setTexturePipelineProgress\(\{ active: true, progress: 4, label: '准备多视图参考' \}\)[\s\S]*?generatePairedMultiviewReference\(singleReference, updateTexturePipelineProgress\)[\s\S]*?setTexturePipelineProgress\(undefined\)/,
  'standalone single-view reference completion must drive and clear the shared CTA progress',
);
assert.match(
  panel,
  /onProgress\?\.\(16, '提交多视图参考'\)[\s\S]*?onProgress\?\.\(32, '生成多视图参考'\)[\s\S]*?onProgress\?\.\(88, '保存多视图参考'\)[\s\S]*?onProgress\?\.\(100, '多视图参考已就绪'\)/,
  'paired multiview generation must publish monotonic submission, generation and persistence phases',
);
assert.match(
  panel,
  /backgroundSize: `\$\{textureActionProgress\.progress\}% 100%, 100% 100%`[\s\S]*?`\$\{textureActionProgress\.label\} · \$\{Math\.round\(textureActionProgress\.progress\)\}%`/,
  'the bottom texture CTA must render the shared progress fill and percentage',
);

assert.match(worker, /inferProjectionGapMask\(currentPixels, targetMask, 1\)/);
assert.match(worker, /texturedPixelCount >= Math\.max\(64, Math\.round\(objectPixelCount \* 0\.0005\)\)/);
assert.match(worker, /compositeEdgeRadius = isSingleViewCompletion \? 0/);
for (const policy of [
  /Math\.round\(24 \* scale\)/,
  /Math\.round\(64 \* scale\)/,
  /Math\.round\(minimumDimension \* 0\.25\)/,
  /Math\.round\(dilationRadius \* 0\.2\)/,
]) {
  assert.match(worker, policy, 'remote completion must match local repaint mask expansion policy');
}
assert.match(worker, /const dilated = dilateMask\(compositeCore/);
assert.match(worker, /const submittedMask = boxBlur\([\s\S]*?dilated/);
assert.match(worker, /if \(compositeCore\[index\] > 0\) submittedMask\[index\] = 255/);
assert.match(worker, /pixels\[offset\] = value[\s\S]*?pixels\[offset \+ 3\] = 255/);
assert.match(worker, /submittedMaskBlob/);
assert.doesNotMatch(worker, /white|gray|grey.*threshold/i, 'coverage must not use a white/grey color heuristic');

const expansionCoreSource = `${worker.slice(
  worker.indexOf('type MaskBounds'),
  worker.indexOf('self.onmessage'),
)}\nexport { getMaskBounds, dilateMask, boxBlur };`;
const expansionCoreCompiled = ts.transpileModule(expansionCoreSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const expansionModule = { exports: {} };
new Function('exports', 'module', expansionCoreCompiled)(
  expansionModule.exports,
  expansionModule,
);
const { getMaskBounds, dilateMask, boxBlur } = expansionModule.exports;
const testWidth = 9;
const testHeight = 9;
const testCoreMask = new Uint8Array(testWidth * testHeight);
testCoreMask[4 * testWidth + 4] = 255;
const testCoreBounds = getMaskBounds(testCoreMask, testWidth, testHeight);
const testDilatedMask = dilateMask(
  testCoreMask,
  testWidth,
  testHeight,
  2,
  testCoreBounds,
);
assert.equal(testDilatedMask[2 * testWidth + 2], 255, 'the submitted mask must grow outward');
assert.equal(testDilatedMask[1 * testWidth + 1], 0, 'mask expansion must stay bounded');
const testFeatheredMask = boxBlur(
  testDilatedMask,
  testWidth,
  testHeight,
  1,
  { minX: 2, minY: 2, maxX: 6, maxY: 6 },
);
assert(
  testFeatheredMask[4 * testWidth + 1] > 0 &&
    testFeatheredMask[4 * testWidth + 1] < 255,
  'the expanded mask must include a non-binary feather band',
);
testFeatheredMask[4 * testWidth + 4] = 255;
assert.equal(testFeatheredMask[4 * testWidth + 4], 255, 'the original gap must remain fully editable');

assert.match(workerClient, /new Worker\([\s\S]*?localRepaintGenerationInput\.worker\.ts/);
assert.match(workerClient, /mode: 'single'/);
assert.match(workerClient, /createRegisteredObjectUrl\(result\.compositeBlob\)/);
assert.match(workerClient, /completionMaskUrl:[\s\S]*?createRegisteredObjectUrl\(result\.submittedMaskBlob\)/);
assert.match(
  await fs.readFile(path.join(root, 'src/engine/capture/captureCurrentView.ts'), 'utf8'),
  /forceEmptyProjectionHatch[\s\S]*?showEmptyProjectionHatch/,
  'coverage capture must force the renderer-owned hatch independently from viewport UI state',
);

console.log('Single-view texture completion regression checks passed.');
