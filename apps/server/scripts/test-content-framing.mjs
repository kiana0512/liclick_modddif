import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { buildExtraParams } from '../dist/services/liclickGenerationService.js';
const framing = {
  version: 1,
  sourceWidth: 2048,
  sourceHeight: 2048,
  left: 100,
  top: 100,
  width: 1710,
  height: 1470,
};
for (const model of ['gpt-image-2', 'gpt-image-2.5-sunburst', 'gpt-image-2.5-flare'])
  for (const workflow of ['local-repaint', 'texture-map']) {
    const input = {
      model,
      workflow,
      prompt: 'fixture',
      framing,
      imageSize: '2K',
      aspectRatio: '1:1',
      quality: 'high',
    };
    const { extraParams } = buildExtraParams(input, [
      { assetId: 'guide' },
      { assetId: 'normal' },
      { assetId: 'optional-material' },
    ]);
    assert.equal(extraParams.aspect_ratio_w, 57);
    assert.equal(extraParams.aspect_ratio_h, 49);
    assert.equal(extraParams.aspect_ratio, undefined);
    assert.equal(extraParams.background, 'transparent');
    assert.equal(extraParams.image_size, '2K');
    assert.deepEqual(
      extraParams.reference_images.map((i) => i.asset_id),
      ['guide', 'normal', 'optional-material'],
    );
    assert.equal(
      extraParams.framing,
      undefined,
      'Internal restoration coordinates never leak into provider controls',
    );
    assert.throws(() => buildExtraParams({ ...input, framing: { ...framing, width: 99999 } }, []));
    assert.throws(() => buildExtraParams({ ...input, imageSize: 'auto' }, []));
    assert.throws(() => buildExtraParams({ ...input, workflow: 'liclick' }, []));
    assert.throws(() =>
      buildExtraParams({ ...input, referencePipeline: 'six-view-delight-v1' }, []),
    );
    assert.equal(
      buildExtraParams({ ...input, framing: undefined }, []).extraParams.aspect_ratio_w,
      undefined,
    );
  }
console.log(
  'GPT custom framing: three models, exact ratio, transparent output and invalid-input rejection passed.',
);

// Execute the real persistence and disk-load functions against an in-memory disk.
const source = readFileSync(new URL('../src/routes/liclick.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('routes.ts', source, ts.ScriptTarget.Latest, true);
const names = [
  'trimPersistedString',
  'sanitizeForPersistence',
  'getPersistableJob',
  'loadGenerationJobsFromDisk',
];
const functions = ast.statements
  .filter((n) => ts.isFunctionDeclaration(n) && names.includes(n.name?.text))
  .map((n) => n.getText(ast))
  .join('\n');
assert.equal(
  ast.statements.filter((n) => ts.isFunctionDeclaration(n) && names.includes(n.name?.text)).length,
  names.length,
);
const module = { exports: {} };
const code = `const maxPersistedStringLength=2000; const generationJobs=new Map(); let disk='[]';
const jobsFile=()=> 'fixture'; const fs={promises:{readFile:async()=>disk}};
${functions}
export async function roundtrip(job){disk=JSON.stringify([getPersistableJob(job)]);await loadGenerationJobsFromDisk();return generationJobs.get(job.id);}`;
new Function(
  'module',
  'exports',
  ts.transpileModule(code, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText,
)(module, module.exports);
const restored = await module.exports.roundtrip({
  id: 'framed-job',
  workflow: 'local-repaint',
  status: 'running',
  input: { framing, prompt: 'fixture' },
  promise: Promise.resolve(),
});
assert.deepEqual(restored.input.framing, framing);
assert.equal(restored.promise, undefined);
assert.equal(restored.status, 'running');
const padded = {
  version: 2,
  sourceWidth: 2048,
  sourceHeight: 2048,
  left: 300,
  top: 700,
  width: 1616,
  height: 648,
  cropBounds: { left: 350, top: 725, width: 1507, height: 597 },
  subject: { left: 395, top: 770, width: 1417, height: 507 },
  ratioWidth: 100,
  ratioHeight: 40,
  outputWidth: 3232,
  outputHeight: 1296,
};
const paddedInput = {
  model: 'gpt-image-2.5-sunburst',
  workflow: 'texture-map',
  prompt: 'fixture',
  imageSize: '2K',
  aspectRatio: '1:1',
  framing: padded,
};
const params = buildExtraParams(paddedInput, []).extraParams;
assert.equal(params.aspect_ratio_w, 5);
assert.equal(params.aspect_ratio_h, 2);
assert.equal(params.aspect_ratio, undefined);
assert.throws(() => buildExtraParams({ ...paddedInput, imageSize: '1K' }, []));
for (const change of [
  { ratioWidth: 1507 },
  { outputWidth: 3248 },
  { subject: undefined },
  { cropBounds: { ...padded.cropBounds, left: -500 } },
])
  assert.throws(() => buildExtraParams({ ...paddedInput, framing: { ...padded, ...change } }, []));
const paddedJob = await module.exports.roundtrip({
  id: 'padded-job',
  workflow: 'texture-map',
  status: 'running',
  input: paddedInput,
});
assert.deepEqual(paddedJob.input.framing, padded);
const square = { ...padded, width: 1507, height: 1507, ratioWidth: 1, ratioHeight: 1, outputWidth: 2048, outputHeight: 2048 };
// Preserve all of the crop while centering it inside a square.
square.left = padded.cropBounds.left;
square.top = padded.cropBounds.top - 400;
for (const model of ['gpt-image-2', 'gpt-image-2.5-sunburst', 'gpt-image-2.5-flare']) {
  const output = buildExtraParams({ ...paddedInput, model, framing: square }, []).extraParams;
  assert.equal(output.aspect_ratio_w, 1);
  assert.equal(output.aspect_ratio_h, 1);
  assert.equal(output.background, 'transparent');
}
console.log(
  'GPT framing persistence: production sanitization + disk restart preserve exact coordinates.',
);
