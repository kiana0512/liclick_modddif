import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import ts from 'typescript';
const require = createRequire(import.meta.url);
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'li3d-lighting-binding-'));
let projectExists = true;
const source = await fs.readFile(new URL('../src/services/referenceLightingBinding.ts', import.meta.url), 'utf8');
const dependencies = {
  '../config.js': { serverConfig: { workspaceDir: root } },
  '../repositories/projectRepository.js': { projectRepository: { findSlug: async () => projectExists ? 'owned-project' : undefined } },
  './workspaceService.js': { getUserProjectDir: () => path.join(root, 'project') },
  './assetFileService.js': { saveRemoteImageAsset: async input => {
    assert.equal(input.userId, 'owner'); assert.equal(input.projectId, 'project');
    assert.equal(input.category, 'references'); return { url: '/workspace/assets/references/lit.png' };
  } },
  './atomicFileService.js': { writeFileAtomically: async (file, data) => { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, data); } },
};
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
const exports = {};
new Function('exports', 'require', compiled)(exports, name => name.startsWith('node:') ? require(name) : dependencies[name]);
try {
  const job = { id: 'lighting', userId: 'owner', projectId: 'project', workflow: 'liclick',
    status: 'running', input: { backgroundReference: true, references: [{ url: 'secret-data-url' }] },
    resultUrl: 'https://remote/result.png', startedAt: 'now', updatedAt: 'now', atlasHomeDir: 'secret-home' };
  await exports.bindReferenceLightingResult(job);
  const recovered = await exports.readReferenceLightingBinding('owner', 'lighting');
  assert.equal(recovered.resultUrl, '/workspace/assets/references/lit.png');
  assert.equal(recovered.status, 'succeeded');
  assert.equal(await exports.readReferenceLightingBinding('other', 'lighting'), undefined);
  const files = await fs.readdir(path.join(root, 'project', '.reference-lighting'));
  const retained = await fs.readFile(path.join(root, 'project', '.reference-lighting', files[0]), 'utf8');
  assert.match(retained, /assets\/references\/lit.png/);
  assert.doesNotMatch(retained, /secret/);
  projectExists = false;
  assert.equal(await exports.readReferenceLightingBinding('owner', 'lighting'), undefined);
  console.log('Private lighting binding passed: durable recovery, account/project ownership, retained asset and no credentials/input bytes.');
} finally { await fs.rm(root, { recursive: true, force: true }); }
