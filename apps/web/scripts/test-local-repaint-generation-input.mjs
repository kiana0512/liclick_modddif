import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const workerPath = path.resolve(
  scriptDirectory,
  '../src/workers/localRepaintGenerationInput.worker.ts',
);
const panelPath = path.resolve(scriptDirectory, '../src/components/panels/GeneratePanel.tsx');
const editorPagePath = path.resolve(scriptDirectory, '../src/routes/EditorPage.tsx');
const workerSource = fs.readFileSync(workerPath, 'utf8');
const panelSource = fs.readFileSync(panelPath, 'utf8');
const editorPageSource = fs.readFileSync(editorPagePath, 'utf8');
const privateCoreSource = `${workerSource.slice(0, workerSource.indexOf('self.onmessage'))}
export { dilateMask, boxBlur };`;
const compiled = ts.transpileModule(privateCoreSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  fileName: workerPath,
}).outputText;
const module = { exports: {} };
new Function('exports', 'module', compiled)(module.exports, module);
const { dilateMask, boxBlur } = module.exports;

const width = 11;
const height = 11;
const authored = new Uint8Array(width * height);
authored[5 * width + 5] = 255;
const dilated = dilateMask(authored, width, height, 2);
assert.equal(dilated[5 * width + 5], 255);
assert.equal(dilated[3 * width + 3], 255);
assert.equal(dilated[2 * width + 2], 0);
const feathered = boxBlur(dilated, width, height, 1);
assert.ok(feathered[2 * width + 3] > 0 && feathered[2 * width + 3] < 255);

assert.match(
  panelSource,
  /prepareLocalRepaintGenerationInput\(\{[\s\S]*?currentEffectUrl: flatCurrentEffectUrl,[\s\S]*?clayPreviewUrl,[\s\S]*?authoredMaskUrl: currentPaintMaskDataUrl/,
  'ModelView input must use the authored-effect/clay composite.',
);
assert.match(
  panelSource,
  /prepareLocalRepaintPromptPolishInputs\(\{[\s\S]*?currentEffectUrl: promptAnalysisCurrentEffectUrl,[\s\S]*?maskUrl: currentPaintMaskDataUrl/,
  'Qwen must use the clean effect and original authored mask.',
);
assert.match(
  panelSource,
  /urlToDataUrl\(preparedGenerationInput\.submittedMaskUrl\)/,
  'Only ModelView should receive the expanded/feathered mask.',
);
assert.match(
  panelSource,
  /capture = \{[\s\S]*?colorUrl: preparedGenerationInput\.compositeUrl,[\s\S]*?maskUrl: currentPaintMaskDataUrl/,
  'Capture paintback must retain the original authored mask.',
);
assert.match(
  panelSource,
  /maskUrl: persistedAuthoredMaskUrl,[\s\S]*?authoredMaskUrl: persistedAuthoredMaskUrl,[\s\S]*?submittedMaskUrl: persistedSubmittedMaskUrl/,
  'Durable generation metadata must separate the authored paintback mask from the remote mask.',
);
assert.match(
  editorPageSource,
  /function getLocalRepaintAuthoringMaskUrl\([\s\S]*?metadata\.authoredMaskUrl[\s\S]*?metadata\.maskUrl/,
  'Brush restore must prefer the authored mask and retain legacy mask fallback.',
);
assert.match(workerSource, /Math\.round\(minimumDimension \* 0\.2\)/);
assert.match(workerSource, /Math\.round\(16 \* scale\)/);
assert.match(workerSource, /Math\.round\(48 \* scale\)/);
assert.match(workerSource, /Math\.round\(dilationRadius \* 0\.2\)/);
assert.match(workerSource, /if \(authoredBinary\[index\] > 0\) submittedMask\[index\] = 255/);

console.log('Local repaint generation input tests passed.');
