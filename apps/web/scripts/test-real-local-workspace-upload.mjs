import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const source = fs.readFileSync(path.join(root, 'src/services/workspaceApiClient.ts'), 'utf8');

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

console.log('Real local integrated-workspace upload regression test passed.');
