import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  pollLiclickImageTask,
  submitLiclickImageEdit,
  submitLiclickImageJob,
} from '../dist/services/liclickGenerationService.js';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

await assert.rejects(
  () => pollLiclickImageTask('foreign-task'),
  /LICLICK_PERSONAL_ACCOUNT_REQUIRED/,
);
await assert.rejects(
  () => submitLiclickImageJob({ prompt: 'test' }),
  /LICLICK_PERSONAL_ACCOUNT_REQUIRED/,
);
await assert.rejects(
  () => submitLiclickImageEdit({ image: 'data:image/png;base64,AA==', mask: 'data:image/png;base64,AA==', prompt: 'test' }),
  /LICLICK_PERSONAL_ACCOUNT_REQUIRED/,
);

const [routeSource, atlasSource] = await Promise.all([
  readFile(path.join(packageRoot, 'src/routes/liclick.ts'), 'utf8'),
  readFile(path.join(packageRoot, 'src/auth/atlasAuthService.ts'), 'utf8'),
]);

assert.match(routeSource, /code:\s*'LICLICK_PERSONAL_ACCOUNT_REQUIRED'/);
assert.match(routeSource, /startPersonalLiclickAccountBinding\(user\)/);
assert.match(routeSource, /pollPersonalLiclickAccountBinding\(segments\[3\], user\)/);
assert.doesNotMatch(
  routeSource,
  /pollLiclickImageTask\(segments\[3\]/,
  'Unknown remote task ids must never be polled with the current or shared credential.',
);
assert.match(atlasSource, /禁止使用服务器共享 Atlas 凭据调用莉刻/);
assert.match(atlasSource, /莉刻账号与当前飞书登录账号不一致，已拒绝绑定/);

process.stdout.write('Liclick personal-account boundary regression test passed.\n');
