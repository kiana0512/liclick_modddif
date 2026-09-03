import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'vite';

const [source, bakeWorkspace, bakeHighSnapshot] = await Promise.all([
  fs.readFile(path.resolve(import.meta.dirname, '../src/routes/AssetProcessingPage.tsx'), 'utf8'),
  fs.readFile(path.resolve(import.meta.dirname, '../src/routes/BakeWorkspacePage.tsx'), 'utf8'),
  fs.readFile(path.resolve(import.meta.dirname, '../src/services/bakeHighSnapshot.ts'), 'utf8'),
]);

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
assert.match(source, /high: undefined,[\s\S]*highObject: undefined,[\s\S]*low: \{/,
  'UV 发布必须只填充 Bake 低模并清除旧的自动高模快照');
assert.match(source, /activeStage: 'assets'/,
  'UV 进入烘焙后必须停留在资产阶段等待用户选择高模');
assert.match(source, /lowModel: \{[\s\S]*name: outputAsset\.name/,
  'UV 结果必须继续作为低模传给烘焙');
assert.doesNotMatch(bakeWorkspace, /pipelineAssetHydrationRef|pendingPipelineLowRef|handleHighImport\(\[highFile\]\)/,
  '烘焙页不得从 Pipeline 自动导入 UV 输入模型作为高模');
assert.match(bakeWorkspace, /if \(!project\) return;[\s\S]*const uvRevision[\s\S]*lowAsset\.objectId \?\?[\s\S]*selectedWorkspaceObjectId/,
  '烘焙页必须允许在高模为空时先恢复 UV 低模');
assert.match(bakeWorkspace, /objectId = firstNonEmptyId\([\s\S]*fileTargetIdRef\.current[\s\S]*handoff\?\.objectId[\s\S]*loaded\.object\.id/,
  '用户后续导入的高模必须复用 UV 低模的 Bake Set 身份');
assert.match(bakeHighSnapshot, /if \(pipelineOwnsHighSource\) return \[\];/,
  '历史 UV Pipeline 高模快照也不得在烘焙页自动显示');

const server = await createServer({
  root: path.resolve(import.meta.dirname, '..'),
  appType: 'custom',
  logLevel: 'silent',
  server: { middlewareMode: true },
});
try {
  const { getBakeHighObjects } = await server.ssrLoadModule('/src/services/bakeHighSnapshot.ts');
  const highObject = {
    id: 'object-1',
    name: 'uv-input.fbx',
    type: 'group',
    sourcePath: '/assets/pipeline-uv-input.fbx',
    format: 'fbx',
    materialSlots: [],
    uvSets: [],
    transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    visible: true,
    selected: true,
  };
  const project = {
    objects: [highObject],
    pipeline: {
      revisions: [
        {
          outputAssets: [
            { kind: 'high-model', url: '/assets/pipeline-uv-input.fbx' },
          ],
        },
      ],
    },
    bakeWorkspace: {
      bakeSets: {
        'object-1': {
          objectId: 'object-1',
          high: { name: highObject.name, url: highObject.sourcePath },
          highObject,
          low: { name: 'uv-output.fbx', url: '/assets/uv-output.fbx' },
        },
      },
    },
  };
  assert.deepEqual(
    getBakeHighObjects(project),
    [],
    'pipeline-owned UV input must not hydrate as the Bake high-poly model',
  );
  project.pipeline.revisions = [];
  assert.equal(
    getBakeHighObjects(project).length,
    1,
    'an explicitly imported Bake high-poly snapshot must remain available',
  );
} finally {
  await server.close();
}

console.log('真实服务器 UV 提交、校验、保存与烘焙交接门禁通过。');
