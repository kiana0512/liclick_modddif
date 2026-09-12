import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.resolve(
  scriptDirectory,
  '../src/engine/localRepaint/seamHarmonizationCore.ts',
);
const source = fs.readFileSync(sourcePath, 'utf8');
const generatePanelSource = fs.readFileSync(
  path.resolve(scriptDirectory, '../src/components/panels/GeneratePanel.tsx'),
  'utf8',
);
const viewportSource = fs.readFileSync(
  path.resolve(scriptDirectory, '../src/engine/viewport/ViewportCanvas.tsx'),
  'utf8',
);
const editorPageSource = fs.readFileSync(
  path.resolve(scriptDirectory, '../src/routes/EditorPage.tsx'),
  'utf8',
);
const sceneStoreSource = fs.readFileSync(
  path.resolve(scriptDirectory, '../src/stores/sceneStore.ts'),
  'utf8',
);
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
  fileName: sourcePath,
}).outputText;
const module = { exports: {} };
new Function('exports', 'module', compiled)(module.exports, module);
const { harmonizeLocalRepaintPixels } = module.exports;

function createPixels(width, height, rgba) {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let offset = 0; offset < pixels.length; offset += 4) pixels.set(rgba, offset);
  return pixels;
}

function pixelAt(pixels, width, x, y) {
  const offset = (y * width + x) * 4;
  return Array.from(pixels.slice(offset, offset + 4));
}

const width = 21;
const height = 21;
const generated = createPixels(width, height, [240, 40, 20, 255]);
const reference = createPixels(width, height, [10, 50, 220, 255]);
const mask = createPixels(width, height, [0, 0, 0, 255]);
for (let y = 3; y <= 17; y += 1) {
  for (let x = 3; x <= 17; x += 1) {
    const offset = (y * width + x) * 4;
    mask[offset] = 255;
    mask[offset + 1] = 255;
    mask[offset + 2] = 255;
  }
}

const composite = harmonizeLocalRepaintPixels({
  generated,
  reference,
  mask,
  width,
  height,
  options: {
    minBlendWidth: 4,
    maxBlendWidth: 8,
    edgeOpacity: 1,
    enableColorMatch: false,
  },
});
assert.equal(composite.report.applied, true);
assert.deepEqual(pixelAt(composite.pixels, width, 0, 0), [10, 50, 220, 255]);
assert.deepEqual(pixelAt(composite.pixels, width, 10, 10), [240, 40, 20, 255]);
const edge = pixelAt(composite.pixels, width, 3, 10);
assert.deepEqual(edge, [240, 40, 20, 255], 'the complete authored mask must stay fully opaque');
const outsideFalloff = pixelAt(composite.pixels, width, 2, 10);
assert.deepEqual(
  outsideFalloff,
  [240, 40, 20, 255],
  'the one-sided opacity ramp must begin at full new-image opacity',
);
const decliningOutsideFalloff = pixelAt(composite.pixels, width, 1, 10);
assert.ok(
  decliningOutsideFalloff[0] > 10 && decliningOutsideFalloff[0] < 240,
  'the outer ring should reduce generated-layer opacity after its full-strength edge',
);
assert.ok(
  decliningOutsideFalloff[2] > 20 && decliningOutsideFalloff[2] < 220,
  'the outer ring should reveal the submitted reference as opacity declines',
);

const fullMask = createPixels(width, height, [255, 255, 255, 255]);
const fullFrame = harmonizeLocalRepaintPixels({
  generated,
  reference,
  mask: fullMask,
  width,
  height,
});
assert.equal(fullFrame.report.applied, false);
assert.deepEqual(fullFrame.pixels, generated);

assert.throws(
  () =>
    harmonizeLocalRepaintPixels({
      generated,
      reference,
      mask: new Uint8ClampedArray(4),
      width,
      height,
    }),
  /identical RGBA dimensions/,
);

assert.match(
  generatePanelSource,
  /const LOCAL_REPAINT_INPUT_RESOLUTION = 2048;/,
  'the current effect and submitted mask must stay aligned at 2K',
);
assert.match(
  generatePanelSource,
  /captureCurrentLocalRepaintView\([\s\S]*resolution: LOCAL_REPAINT_INPUT_RESOLUTION,[\s\S]*colorMode: isGptLocalRepaint \? 'flat-target-coverage' : 'flat-target'/,
  'the generation path must first capture the frozen-camera current BaseColor effect',
);
assert.match(
  generatePanelSource,
  /prepareLocalRepaintGenerationInput\(\{[\s\S]*currentEffectUrl: flatCurrentEffectUrl,[\s\S]*clayPreviewUrl,[\s\S]*authoredMaskUrl: currentPaintMaskDataUrl/,
  'the input worker must receive the unchanged authored mask alongside aligned current and clay captures',
);
assert.match(
  generatePanelSource,
  /urlToDataUrl\(capture\.colorUrl\)[\s\S]*urlToDataUrl\(preparedGenerationInput\.submittedMaskUrl\)/,
  'ModelView must receive the composite image and the expanded/feathered mask',
);
assert.match(
  generatePanelSource,
  /prepareLocalRepaintPromptPolishInputs\(\{[\s\S]*currentEffectUrl: promptAnalysisCurrentEffectUrl,[\s\S]*maskUrl: currentPaintMaskDataUrl/,
  'Qwen must receive the clean current effect and the original non-dilated mask',
);
assert.match(
  generatePanelSource,
  /image: \{ path: 'current-effect\.png',[\s\S]*materialImage: \{[\s\S]*mask: \{ path: `\$\{generationId\}-mask\.png`/,
  'the local repaint request must submit current effect, material reference and mask',
);
assert.match(
  generatePanelSource,
  /resultUrl: preparedResult.resultUrl,[\s\S]*rawResultUrl: generation\.resultUrl,[\s\S]*resultComposition: 'direct-v1'/,
  'model silhouette clipping preserves the untouched provider result without colour harmonization',
);
assert.doesNotMatch(
  generatePanelSource,
  /harmonizeLocalRepaintInWorker|\u6b63\u5728\u878d\u5408\u5c40\u90e8\u91cd\u7ed8\u7ed3\u679c/,
  'the new generation path must not run the retired colour correction step',
);
assert.doesNotMatch(
  generatePanelSource,
  /syncGeneration\(completedGeneration\);[\s\S]{0,800}liveMaskState\.clearPaintMask\(\);/,
  'a completed generation must retain the single live mask for repeated generation',
);
assert.match(
  generatePanelSource,
  /capture = \{[\s\S]*colorUrl: preparedGenerationInput\.compositeUrl,[\s\S]*maskUrl: currentPaintMaskDataUrl/,
  'capture and paintback must retain the authored mask instead of the expanded remote blending mask',
);
assert.match(
  generatePanelSource,
  /authoredMaskUrl: currentPaintMaskDataUrl,[\s\S]*submittedMaskUrl: isGptLocalRepaint \? undefined : preparedGenerationInput\.submittedMaskUrl/,
  'ModelView must archive its sampling mask separately; GPT sends no mask but must retain the authored write mask',
);
assert.match(
  generatePanelSource,
  /maskUrl: persistedAuthoredMaskUrl,[\s\S]*authoredMaskUrl: persistedAuthoredMaskUrl,[\s\S]*submittedMaskUrl: persistedSubmittedMaskUrl/,
  'durable generation metadata must keep the authored and remote-submitted masks separate',
);
assert.doesNotMatch(
  generatePanelSource,
  /createFullFrameMaskDataUrl|full-frame-default|未绘制蒙版时将使用全图范围/,
  'local generation must not silently replace an empty mask with a full-frame mask',
);
assert.match(
  generatePanelSource,
  /if \(!initialMaskState\.paintMaskHasContent\) \{[\s\S]*title: '请先绘制蒙版',[\s\S]*return false;/,
  'the terminal generation boundary must reject an empty live mask',
);
assert.match(
  generatePanelSource,
  /initialMaskState.paintMaskCapture\(\{[\s\S]*resolution: LOCAL_REPAINT_INPUT_RESOLUTION/,
  'the canonical submitted mask must be captured at the same 2K resolution as the current effect',
);
assert.doesNotMatch(
  generatePanelSource,
  /PaintedLocalRepaintPreview|paintedPreviewLayer/,
  'the repaint result panel must keep showing the complete returned image instead of switching to the painted layer mask',
);
assert.match(
  sceneStoreSource,
  /export type PaintMaskCapture = \(options\?: \{[\s\S]*resolution\?: number;/,
  'paint-mask capture must accept an explicit canonical output resolution',
);
assert.match(
  viewportSource,
  /currentProjectionHasContentRef\.current &&[\s\S]*archiveCurrentInpaintProjection\([\s\S]*currentProjectionOperationRef\.current/,
  'the live selection must be archived with its real add/subtract operation before capture',
);
assert.match(
  viewportSource,
  /createInpaintMaskCaptureMaterial\([\s\S]*layer\.accumulatedMaskTarget\.texture,[\s\S]*true,[\s\S]*\)/,
  'capture must use the canonical accumulated UV mask as its only coverage source',
);
assert.doesNotMatch(
  viewportSource.slice(
    viewportSource.indexOf('const capturePaintMask = useCallback'),
    viewportSource.indexOf('const invertPaintMaskRuntime = useCallback'),
  ),
  /renderScenePassesToPngUrl|layer\.inpaintSnapshots\.map|layer\.projectionTexture/,
  'canonical capture must not union stale or live projector passes into a second mask',
);
assert.match(
  viewportSource,
  /localRepaintSeamHarmonizationVersion === 2 \|\|[\s\S]*localRepaintSeamHarmonizationVersion === 6 \|\|[\s\S]*localRepaintSeamHarmonizationVersion === 7 \|\|[\s\S]*localRepaintSeamHarmonizationVersion === 8 \|\|[\s\S]*localRepaintSeamHarmonizationVersion === 9 \|\|[\s\S]*localRepaintSeamHarmonizationVersion === 10 \|\|[\s\S]*localRepaintSeamHarmonizationVersion === 11 \|\|[\s\S]*localRepaintSeamHarmonizationVersion === 12 \|\|[\s\S]*localRepaintSeamHarmonizationVersion === 13 \|\|[\s\S]*localRepaintSeamHarmonizationVersion === 14/,
  'saved v14 one-sided composites must remain the editable repaint source after reload',
);
assert.match(
  editorPageSource,
  /seamHarmonizationVersion === 5 \|\|[\s\S]*seamHarmonizationVersion === 6 \|\|[\s\S]*seamHarmonizationVersion === 7 \|\|[\s\S]*seamHarmonizationVersion === 8 \|\|[\s\S]*seamHarmonizationVersion === 9 \|\|[\s\S]*seamHarmonizationVersion === 10 \|\|[\s\S]*seamHarmonizationVersion === 11 \|\|[\s\S]*seamHarmonizationVersion === 12 \|\|[\s\S]*seamHarmonizationVersion === 13 \|\|[\s\S]*seamHarmonizationVersion === 14/,
  'the projection resolver must recognize persisted v14 one-sided composites',
);
assert.match(
  editorPageSource,
  /seamMode === 'legacy' \|\| !referenceUrl\) return legacyResult/,
  'the explicit legacy switch must still restore the raw generated result',
);

console.log('Local repaint result composite tests passed.');
