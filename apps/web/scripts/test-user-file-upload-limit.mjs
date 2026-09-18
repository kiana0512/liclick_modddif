import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';

const read = name => fs.readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8');
const notices = [];
const scope = {};
new Function('exports', 'require', ts.transpileModule(read('services/userFileUploadPolicy.ts'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText)(scope, () => ({ useToastStore: { getState: () => ({ pushToast: t => notices.push(t) }) } }));
const { MAX_USER_FILE_BYTES: limit, getUserFileUploadError, allowUserFileUpload } = scope;
assert.equal(limit, 104857600);
for (const size of [0, limit - 1, limit]) {
  assert.equal(getUserFileUploadError([{ size }]), undefined);
  assert.equal(allowUserFileUpload([{ size }]), true);
}
assert.equal(allowUserFileUpload([{ size: limit }, { size: limit }]), true, 'per file, not total batch size');
assert.equal(notices.length, 0);
const rejected = [{ size: 1 }, { size: limit + 1 }];
assert.equal(allowUserFileUpload(rejected), false);
assert.equal(notices.at(-1).description, '文件大小超过 100MB 限制');

// Execute each real handler's initial guard. Any read/decode/state/network work
// beyond that guard throws, proving oversized selections stop before side effects.
const entries = {
  'routes/EditorPage.tsx': ['handleImportModels', 'handleImportReferenceImages', 'handleLoadProject', 'replaceLayerImage'],
  'routes/BakeWorkspacePage.tsx': ['handleLowImport', 'handleColorImport', 'handleMaterialChannelImport', 'handleMaterialImport', 'handleHighImport'],
  'routes/AssetProcessingPage.tsx': ['acceptFile', 'addFiles', 'appendFiles'],
  'components/panels/ReferenceImagePicker.tsx': ['importFiles'],
  'components/panels/ReferenceGroupPicker.tsx': ['queueReferenceFiles'],
};
let checked = 0;
for (const [file, names] of Object.entries(entries)) {
  const ast = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found = new Map();
  const visit = node => {
    if (ts.isFunctionDeclaration(node) && node.name && names.includes(node.name.text)) found.set(node.name.text, node);
    if (ts.isVariableDeclaration(node) && names.includes(node.name.getText(ast)) && ts.isCallExpression(node.initializer)) {
      found.set(node.name.getText(ast), node.initializer.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  for (const name of names) {
    const node = found.get(name);
    assert.ok(node?.body, `${file}:${name}`);
    const guard = node.body.statements[0].getText(ast);
    assert.match(guard, /^if \(!allowUserFileUpload\(/, `${name} guard must run first`);
    const guardJs = ts.transpileModule(guard, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    new Function('allowUserFileUpload','files','file','nextFile','input','list',
      guardJs + '\nthrow new Error("oversized file reached a side effect");')(
      allowUserFileUpload, rejected, rejected[1], rejected[1], rejected, rejected);
    checked++;
  }
}
assert.match(read('routes/BakeWorkspacePage.tsx'), /if \(!allowUserFileUpload\(files\)\) \{ event.target.value = ''; return; \}\s*const assigned = assignFilesToObjects/);
console.log(`User file upload limit: exact 100MB allowed, +1 byte rejected, per-file batch policy, ${checked} early-return handlers and cage guard passed.`);
