import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const apiSource = fs.readFileSync(path.join(root, 'src/services/workspaceApiClient.ts'), 'utf8');
const workflowSource = fs.readFileSync(path.join(root, 'src/routes/AssetProcessingPage.tsx'), 'utf8');

assert.match(apiSource, /export async function updateLatestProject\(/);
assert.match(apiSource, /await loadProject\(projectId\)/);
assert.match(apiSource, /error\.status !== 409/);
assert.match(apiSource, /latestUpdatedAt \+ 1/);
assert.match(apiSource, /candidateUpdatedAt > latestUpdatedAt/);
assert.match(workflowSource, /updateLatestProject\(targetProject\.id/);
assert.match(workflowSource, /revisionsToPublish/);
assert.match(workflowSource, /latestManifest\.models, \.\.\.modelAssetPaths/);
assert.match(workflowSource, /\[objectId\]: publishedBakeSet/);
assert.match(workflowSource, /const historicalUvSource/);
assert.match(workflowSource, /sourceFile: historicalUvSource/);
assert.match(workflowSource, /mode === 'uv'/);
assert.doesNotMatch(workflowSource, /saveWorkspaceProject\(nextProject\)/);

console.log('UV 历史传入烘焙的最新 revision 合并与冲突重试门禁通过。');
