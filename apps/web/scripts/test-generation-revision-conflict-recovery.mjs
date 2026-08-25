import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const generatePanel = await readFile(
  new URL('../src/components/panels/GeneratePanel.tsx', import.meta.url),
  'utf8',
);
const workspaceApi = await readFile(
  new URL('../src/services/workspaceApiClient.ts', import.meta.url),
  'utf8',
);

assert.match(generatePanel, /updateLatestProject,/);
assert.match(
  generatePanel,
  /const result = await updateLatestProject\([\s\S]*?\.\.\.latest,[\s\S]*?objects,[\s\S]*?layers,[\s\S]*?references,[\s\S]*?generations,[\s\S]*?captures,[\s\S]*?settings: project\.settings,[\s\S]*?\},[\s\S]*?5,[\s\S]*?\);/,
  '生成前保存必须把贴图模块状态合并到服务器最新项目版本。',
);
assert.doesNotMatch(
  generatePanel,
  /saveWorkspaceProject\(savedProjectSnapshot\)/,
  '不得再用打开页面时的旧快照覆盖服务器项目。',
);
assert.doesNotMatch(
  generatePanel,
  /error\.message\.includes\('stale project snapshot'\)/,
  '冲突恢复不得依赖单一英文错误文案。',
);
assert.match(workspaceApi, /const latest = \(await loadProject\(projectId\)\)\.project/);
assert.match(workspaceApi, /error\.status !== 409/);
assert.match(
  workspaceApi,
  /const projectMutationTails = new Map<string, Promise<void>>\(\)/,
  '同一浏览器标签中的项目写入必须经过项目级串行队列。',
);
assert.match(
  workspaceApi,
  /return withProjectMutationLock\(projectId, async \(\) => \{/,
  '读取最新版本、合并和保存必须处于同一个项目写入临界区。',
);
assert.match(workspaceApi, /return await saveProjectDirect\(/);
assert.match(
  workspaceApi,
  /if \(attempt \+ 1 < maxAttempts\) await waitForRevisionRetry\(attempt\)/,
  'revision 冲突重试之间必须退避，避免连续撞击服务器版本门禁。',
);
assert.match(
  workspaceApi,
  /`\/api\/projects\/\$\{projectId\}`,[\s\S]*?\{ cache: 'no-store' \}/,
  '冲突恢复读取不得复用浏览器缓存中的旧项目文档。',
);

console.log('生图前项目 revision 冲突恢复门禁通过。');
