import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const source = await fs.readFile(
  path.resolve(import.meta.dirname, '../src/routes/AssetProcessingPage.tsx'),
  'utf8',
);

assert.match(source, /await submitUvProcessing\(\{/,
  '自动展 UV 必须提交真实服务器任务');
assert.match(source, /outputBlob: await fetchVerifiedArtifactBlob\(currentJobId, artifact\)/,
  '服务器 UV 结果必须经过摘要验证后再进入项目流水线');
assert.match(source, /onContinueArtifact=\{handleContinue\}/,
  '自动展 UV 工作区必须接入项目保存和烘焙交接');
assert.match(source, /void onContinueArtifact\(uvFbxArtifact\)/,
  '成功任务必须使用服务器返回的 UV FBX 交付物');
assert.match(source, /直接传入烘焙/,
  '服务器 UV 成功结果必须向用户提供明确的下一阶段入口');
assert.doesNotMatch(source, /LocalUvUnwrapResult|localUvResult|sourceMode: 'browser-local'/,
  '生产 UV 页面不得回退到浏览器本地拆分或伪造本地任务历史');

console.log('真实服务器 UV 提交、校验、保存与烘焙交接门禁通过。');
