import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { stdout } from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [editorPage, generatePanel] = await Promise.all([
  readFile(path.join(root, 'src/routes/EditorPage.tsx'), 'utf8'),
  readFile(path.join(root, 'src/components/panels/GeneratePanel.tsx'), 'utf8'),
]);

assert.doesNotMatch(
  editorPage,
  /textureGenerationLocked=\{localImageGenerationRunning\}/,
  'The toolbar request bridge must not be passed back to GeneratePanel as its own lock.',
);
assert.doesNotMatch(
  generatePanel,
  /textureGenerationLocked/,
  'GeneratePanel must derive duplicate-submission locking from its actual running task.',
);
assert.match(
  generatePanel,
  /const workflowSubmissionLocked = interactionLocked \|\| panelTaskRunning;/,
  'External exclusive work and an actual panel task may block submission.',
);
assert.match(
  generatePanel,
  /submitLocksRef\.current\.add\('repaint'\)[\s\S]*?setSubmissionActive\(true\)/,
  'Local repaint must still claim its internal synchronous submission lock.',
);
assert.match(
  generatePanel,
  /let materialReference = resolveLocalRepaintMaterialReference\(\{[\s\S]*?selectedReferenceIds: referenceStateAtSubmission\.selectedReferenceIds,[\s\S]*?historicalReferenceId:/,
  'Local repaint must resolve the currently selected single-view or multiview reference before historical fallback.',
);
assert.match(
  generatePanel,
  /if \(!isMultiviewReference\(materialReference\)\) \{[\s\S]*?materialReference = await generatePairedMultiviewReference\(materialReference\)/,
  'A selected single-view material reference must be converted while the repaint submission lock is held.',
);

stdout.write('Local generation self-lock regression test passed.\n');
