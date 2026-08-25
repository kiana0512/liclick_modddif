import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const source = await fs.readFile(
  path.resolve(import.meta.dirname, '../src/routes/AssetProcessingPage.tsx'),
  'utf8',
);

assert.match(
  source,
  /statusError instanceof AssetProcessingHttpError && statusError\.status === 401/,
  'UV/拓扑服务状态必须区分未登录与服务故障',
);
assert.match(
  source,
  /请先使用右上角飞书登录，登录后才能检测和提交真实云端任务/,
  '未登录状态必须提供真实飞书登录指引',
);
assert.match(source, /loginRequired\s*\? '请先登录'/, '服务状态徽标必须明确显示请先登录');

const catchBlock = source.slice(
  source.indexOf('.catch((statusError)'),
  source.indexOf('.finally(() =>', source.indexOf('.catch((statusError)')),
);
assert.match(catchBlock, /if \(loginRequired\) serviceRetryAttemptRef\.current = 0/);
assert.match(catchBlock, /else scheduleRetry\(\)/);
assert.doesNotMatch(
  catchBlock,
  /setServiceError\(message\);\s*scheduleRetry\(\);/,
  '401 不得进入无限后台重试',
);

console.log('UV/拓扑未登录提示与 401 停止重试门禁通过。');
