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
const { insertCameraViewByPreviewOrder, usesGptTextureGeneration } = sequenceModule.exports;

const ordered = insertCameraViewByPreviewOrder(
  [
    { id: 'front', viewDirection: [0, 0, 1] },
    { id: 'left', viewDirection: [-1, 0, 0] },
    { id: 'top', viewDirection: [0, 1, 0] },
    { id: 'bottom', viewDirection: [0, -1, 0] },
  ],
  { id: 'front-left', viewDirection: [-1, 0, 1] },
);
assert.deepEqual(
  ordered.map((view) => view.id),
  ['front', 'front-left', 'left', 'top', 'bottom'],
  'new ordinary views must be inserted by adjacency before the GPT pole tail',
);
assert.equal(usesGptTextureGeneration({ id: 'top', viewDirection: [0, 1, 0] }), true);
assert.equal(
  usesGptTextureGeneration({ id: 'top-oblique', viewDirection: [0, 0.89, 0.46] }),
  false,
);
assert.equal(usesGptTextureGeneration({ id: 'bottom', viewDirection: [0, -1, 0] }), true);
const orderedWithCustomTop = insertCameraViewByPreviewOrder(ordered, {
  id: 'custom-top',
  viewDirection: [0.1, 0.99, 0],
});
assert.deepEqual(
  orderedWithCustomTop.map((view) => view.id),
  ['front', 'front-left', 'left', 'top', 'custom-top', 'bottom'],
  'custom pole views must use the GPT top/bottom tail instead of interrupting remote views',
);

const start = panel.indexOf('async function handleRemoteSequentialMultiviewGenerate');
const end = panel.indexOf('async function handleTextureMapMultiviewGenerate', start);
assert(start >= 0 && end > start, 'the remote multiview sequential orchestrator must exist');
const flow = panel.slice(start, end);
const persistPairedStart = panel.indexOf('async function persistPairedMultiviewReference');
const persistPairedEnd = panel.indexOf(
  'async function generatePairedMultiviewReference',
  persistPairedStart,
);
assert(
  persistPairedStart >= 0 && persistPairedEnd > persistPairedStart,
  'paired multiview reference persistence must exist',
);
const persistPairedFlow = panel.slice(persistPairedStart, persistPairedEnd);

// GPT-only UI policy: keep legacy remote implementation/history compatible,
// but neither a toggle nor persisted settings can select it for new tasks.
assert.match(panel, /const \[singleViewProvider\] = useState<SingleViewProvider>\('gpt'\)/);
assert.doesNotMatch(panel, /setSingleViewProvider|<SegmentedControl<SingleViewProvider>|data-single-view-provider=/);
assert.doesNotMatch(panel, /label: 'GPT2'|label: '远端'/);
const routeStart = panel.indexOf('async function handleTextureMapMultiviewGenerate(');
const routeEnd = panel.indexOf('    const objectId = captureObjectId;', routeStart);
assert(routeStart >= 0 && routeEnd > routeStart);
const routeJs = ts.transpileModule(`${panel.slice(routeStart, routeEnd)}\n}`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;
const providerBinding = panel.match(/const \[singleViewProvider\] = useState<SingleViewProvider>\('gpt'\);/)[0];
const bindingJs = ts.transpileModule(providerBinding, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;
for (const mode of ['single', 'multi']) {
  const calls = [];
  const scope = {
    useState: (initial) => [initial, () => { throw new Error('Provider must stay fixed'); }],
    throwIfTexturePipelineCancelled: () => {}, captureObjectId: 'object',
    requireFeishuLogin: async () => { calls.push('remote-login'); return true; },
    requirePersonalLiclickAccount: async () => { calls.push('gpt-login'); },
    usesGptTextureGeneration: () => true,
    handleRemoteSequentialMultiviewGenerate: async () => { calls.push('remote-generation'); },
    handleGptPairedMultiviewGenerate: async () => { calls.push('gpt-pairs'); },
  };
  const route = new Function(...Object.keys(scope), `${bindingJs}\n${routeJs}\nreturn handleTextureMapMultiviewGenerate;`)(...Object.values(scope));
  await route({ id: 'material' }, [{ id: 'front' }, { id: 'top' }, { id: 'custom' }], mode);
  assert.deepEqual(calls, mode === 'multi' ? ['gpt-login', 'gpt-pairs'] : ['gpt-login'], `${mode} must use GPT authorization, never the remote route`);
}
assert.match(
  panel,
  /isMultiviewRequest && usesRemoteTextureGeneration[\s\S]*?handleRemoteSequentialMultiviewGenerate/,
  'remote multiview requests must route into the sequential orchestrator',
);
assert.match(
  flow,
  /const orderedViews = \[\.\.\.requestedViews\][\s\S]*?for \(let index = 0; index < viewCount; index \+= 1\)/,
  'remote generation must consume the exact preview order in one serial loop',
);
assert.doesNotMatch(
  flow,
  /preferredFirstViewId|activeCameraViewId\s*\)/,
  'the active thumbnail must not reorder the submitted preview sequence',
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
  /usesGptTextureGeneration\(view\)[\s\S]*?submitGptTextureView\([\s\S]*?waitForLiclickGeneration\(alignedGeneration\)/,
  'top and bottom views must switch to GPT2 while staying inside the serial projection chain',
);
assert.match(
  panel,
  /requestedViews\.some\(usesGptTextureGeneration\)[\s\S]*?requirePersonalLiclickAccount\(\)/,
  'mixed remote multiview must validate the GPT2 account before submitting the batch',
);
assert.match(
  panel,
  /'front',[\s\S]*?'front-left',[\s\S]*?'left',[\s\S]*?'back-left',[\s\S]*?'back',[\s\S]*?'back-right',[\s\S]*?'right',[\s\S]*?'front-right',[\s\S]*?'top',[\s\S]*?'bottom'/,
  'preset 1 must keep adjacent orbit views first and poles last',
);
assert.match(
  panel,
  /'front',[\s\S]*?'left',[\s\S]*?'back',[\s\S]*?'right',[\s\S]*?'right-top',[\s\S]*?'front-top',[\s\S]*?'left-top',[\s\S]*?'back-top',[\s\S]*?'back-bottom',[\s\S]*?'left-bottom',[\s\S]*?'front-bottom',[\s\S]*?'right-bottom',[\s\S]*?'top',[\s\S]*?'bottom'/,
  'preset 2 must use the approved preview and execution order',
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
