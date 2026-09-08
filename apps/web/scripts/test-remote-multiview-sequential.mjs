import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const [panel, transformActions, sequenceSource] = await Promise.all([
  readFile(new URL('../src/components/panels/GeneratePanel.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/engine/scene/transformActions.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/engine/generation/remoteMultiviewSequence.ts', import.meta.url), 'utf8'),
]);

const transpiledSequence = ts.transpileModule(sequenceSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const sequenceModule = { exports: {} };
new Function('module', 'exports', transpiledSequence)(sequenceModule, sequenceModule.exports);
const { orderCameraViewsForSequentialGeneration } = sequenceModule.exports;

const ordered = orderCameraViewsForSequentialGeneration(
  [
    { id: 'front', viewDirection: [0, 0, 1] },
    { id: 'back', viewDirection: [0, 0, -1] },
    { id: 'right', viewDirection: [1, 0, 0] },
    { id: 'front-right', viewDirection: [1, 0, 1] },
  ],
  'front-right',
);
assert.deepEqual(
  ordered.map((view) => view.id),
  ['front-right', 'front', 'right', 'back'],
  'the active view must lead a deterministic nearest-angle traversal',
);

const start = panel.indexOf('async function handleRemoteSequentialMultiviewGenerate');
const end = panel.indexOf('async function handleTextureMapMultiviewGenerate', start);
assert(start >= 0 && end > start, 'the remote multiview sequential orchestrator must exist');
const flow = panel.slice(start, end);
const persistPairedStart = panel.indexOf('async function persistPairedMultiviewReference');
const persistPairedEnd = panel.indexOf('async function generatePairedMultiviewReference', persistPairedStart);
assert(
  persistPairedStart >= 0 && persistPairedEnd > persistPairedStart,
  'paired multiview reference persistence must exist',
);
const persistPairedFlow = panel.slice(persistPairedStart, persistPairedEnd);

assert.match(
  panel,
  /isTextureMapTab && displayedTexturePreviewMode !== 'repaint'[\s\S]*?<SegmentedControl<SingleViewProvider>[\s\S]*?远端/,
  'both single-view and multiview texture modes must expose the remote provider',
);
assert.match(
  panel,
  /isMultiviewRequest && usesRemoteTextureGeneration[\s\S]*?handleRemoteSequentialMultiviewGenerate/,
  'remote multiview requests must route into the sequential orchestrator',
);
assert.match(
  flow,
  /orderCameraViewsForSequentialGeneration[\s\S]*?for \(let index = 0; index < viewCount; index \+= 1\)/,
  'remote views must use the overlap-friendly order and one serial loop',
);
assert.match(
  flow,
  /setCameraToObjectDirection\(objectId, view\.viewDirection, view\.viewUp\)[\s\S]*?await waitForBrowserPaint\(\)[\s\S]*?captureCurrentColorPreview/,
  'the visible viewport must move and settle before the current material is captured',
);
assert.match(
  flow,
  /prepareSingleViewTextureCompletion\([\s\S]*?uncoveredPixelCount === 0[\s\S]*?continue;/,
  'fully covered views must skip remote generation',
);
assert.match(
  flow,
  /generateSingleViewInpaint\([\s\S]*?completion-mask\.png[\s\S]*?: await modelviewClient\.generateSingleView\(/,
  'partial views must use expanded-mask inpaint while all-clay views use ordinary generation',
);
assert.match(
  flow,
  /waitForProjectedMaterialResident\(objectId, signal\)[\s\S]*?addGenerationAsProjectedLayer[\s\S]*?await residentWait\.promise[\s\S]*?projectedGenerationCount \+= 1/,
  'each returned image must be projected and GPU-resident before the next iteration',
);
assert.doesNotMatch(
  flow,
  /beginProjectedPreviewBatch/,
  'sequential remote generation must publish every projected view immediately',
);
assert.match(
  flow,
  /requestContentAwareRepair\([\s\S]*?batchId: textureBatchId/,
  'content-aware repair must run once after the sequential view loop',
);
assert.match(
  panel,
  /if \(isTextureMap\)[\s\S]*?pipelineController\.abort\('user-cancelled-texture-generation'\)/,
  'terminating a texture generation must abort the active remote request and prevent later views',
);
assert.match(
  persistPairedFlow,
  /setSelectedReferences\(\[multiviewReference\.id\]\)/,
  'the generated multiview reference must remain selected for the texture pipeline',
);
assert.doesNotMatch(
  persistPairedFlow,
  /setTexturePreviewMode\('multi'\)|setTextureViewMode\('multi'\)|setTab\('multiview'\)/,
  'background multiview reference persistence must not navigate away from the active generation tab',
);
assert.match(
  transformActions,
  /export function setCameraToObjectDirection\([\s\S]*?runtime\.camera\.position\.copy\(center\)[\s\S]*?runtime\.controls\?\.target\.copy\(center\)/,
  'preset and custom generation views must share exact object-centered viewport framing',
);

console.log('Remote multiview sequential generation regression checks passed.');
