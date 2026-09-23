import assert from 'node:assert/strict';
import fs from 'node:fs';
import { resolveLocalRepaintMaterialReference } from '../src/services/localRepaintMaterialReference.ts';

const resolver = fs.readFileSync(
  new URL('../src/services/localRepaintMaterialReference.ts', import.meta.url),
  'utf8',
);
const panel = fs.readFileSync(
  new URL('../src/components/panels/GeneratePanel.tsx', import.meta.url),
  'utf8',
);

const references = [
  {
    id: 'board-single',
    name: '画板单视图',
    url: 'data:image/png;base64,board-single',
    width: 1,
    height: 1,
    isPrimary: false,
    referenceGroupId: 'board',
    referenceRole: 'single-view',
  },
  {
    id: 'board-multi',
    name: '画板多视图',
    url: 'data:image/png;base64,board-multi',
    width: 1,
    height: 1,
    isPrimary: true,
    referenceGroupId: 'board',
    referenceRole: 'multi-view',
  },
  {
    id: 'robot-multi',
    name: '机器人多视图',
    url: 'data:image/png;base64,robot-multi',
    width: 1,
    height: 1,
    isPrimary: false,
    referenceGroupId: 'robot',
    referenceRole: 'multi-view',
  },
];

assert.equal(
  resolveLocalRepaintMaterialReference({
    references,
    selectedReferenceIds: ['board-multi'],
    historicalReferenceId: 'robot-multi',
  })?.id,
  'board-multi',
  'the selected board must override the previous robot generation',
);
assert.equal(
  resolveLocalRepaintMaterialReference({
    references,
    selectedReferenceIds: ['board-single'],
    historicalReferenceId: 'robot-multi',
  })?.id,
  'board-single',
  'explicit single selection stays single even when a paired multiview exists',
);
assert.equal(
  resolveLocalRepaintMaterialReference({
    references: references.filter((reference) => reference.id !== 'board-multi'),
    selectedReferenceIds: ['board-single'],
    historicalReferenceId: 'robot-multi',
  })?.id,
  'board-single',
  'deleting the paired multiview image must return the selected single image so the caller regenerates it',
);
assert.equal(
  resolveLocalRepaintMaterialReference({
    references,
    selectedReferenceIds: [],
    historicalReferenceId: 'robot-multi',
  })?.id,
  'robot-multi',
  'history remains available only when there is no explicit selection',
);
assert.match(
  resolver,
  /const historicalReference[\s\S]*return historicalReference/,
  'history must remain a fallback only after the explicit-selection branch',
);
assert.match(
  panel,
  /const referenceStateAtSubmission = useReferenceStore\.getState\(\)/,
  'submission must read the latest reference store instead of a render-time closure',
);
const localRepaintFlow = panel.slice(
  panel.indexOf('async function handleLocalRepaintGenerate()'),
  panel.indexOf('handleLocalRepaintGenerateRef.current = handleLocalRepaintGenerate'),
);
assert.doesNotMatch(localRepaintFlow, /await generatePairedMultiviewReference/);
assert.ok(localRepaintFlow.indexOf('await prepareReferenceLighting') < localRepaintFlow.indexOf('createModelviewApiClient().generateInpaint'));
assert.match(
  panel,
  /await saveCriticalProjectState\(\{ references: useReferenceStore\.getState\(\)\.references \}\)/,
  'the newly generated multiview reference must be durable before remote submission',
);
assert.match(
  panel,
  /path: `\$\{generationId\}-\$\{materialReference!\.id\}-material-reference\.png`/,
  'each task must use a reference-identifying multipart filename',
);

console.log('local repaint material reference regression checks passed');
