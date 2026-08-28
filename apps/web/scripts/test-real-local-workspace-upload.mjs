import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const source = fs.readFileSync(path.join(root, 'src/services/workspaceApiClient.ts'), 'utf8');
const generatePanelSource = fs.readFileSync(
  path.join(root, 'src/components/panels/GeneratePanel.tsx'),
  'utf8',
);

assert.match(
  source,
  /if \(isIntegratedLoopbackWorkspace\(\)\) return saveBlobAssetWithProgress\(input\);/u,
  'The integrated 4517 workspace must bypass the unavailable cloud upload-intent endpoint.',
);

assert.match(
  source,
  /if \(isCloudBuild && globalThis\.crypto\?\.subtle\)[\s\S]*return await saveDirectBlobAsset\(input\);[\s\S]*error\.status !== 503[\s\S]*return saveBlobAssetWithProgress\(input\);/u,
  'The real local web build must fall back from unavailable cloud storage to the integrated authenticated workspace upload.',
);
assert.match(
  source,
  /request\.open\([\s\S]*'POST',[\s\S]*\/api\/projects\/\$\{input\.projectId\}\/assets\?/u,
  'The fallback must stream into the project assets route on the same workspace backend.',
);
assert.match(
  source,
  /if \(isCloudBuild && globalThis\.crypto\?\.subtle\)[\s\S]*return await saveDirectBlobAsset\(input\);/u,
  'Non-loopback Cloud/A100 builds must keep direct object-storage uploads.',
);
assert.match(
  generatePanelSource,
  /isIntegratedLoopbackWorkspaceAssetUrl\(url\)/u,
  'Automatic projection must reuse already durable 4517 workspace assets instead of re-uploading every capture plane.',
);

console.log('Real local integrated-workspace upload regression test passed.');
