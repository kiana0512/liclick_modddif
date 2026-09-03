import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  pollLiclickImageTask,
  submitLiclickImageEdit,
  submitLiclickImageJob,
} from '../dist/services/liclickGenerationService.js';
import { buildPersonalLiclickAccountCallbackUrl } from '../dist/auth/atlasAuthService.js';
import { getLiclickUserErrorMessage } from '../dist/services/liclickErrorMessage.js';

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
  () =>
    submitLiclickImageEdit({
      image: 'data:image/png;base64,AA==',
      mask: 'data:image/png;base64,AA==',
      prompt: 'test',
    }),
  /LICLICK_PERSONAL_ACCOUNT_REQUIRED/,
);

assert.equal(
  getLiclickUserErrorMessage(
    new Error(
      'ATLAS_RUNTIME_INCOMPATIBLE: Installed Atlas runtime does not expose its secure token cache reader.',
    ),
  ),
  '服务器莉刻运行时版本不兼容，请联系管理员升级服务。',
);

assert.equal(
  buildPersonalLiclickAccountCallbackUrl(
    'http://10.3.2.59:44770',
    '/li3d',
    'binding-test',
  ).toString(),
  'http://10.3.2.59:44770/li3d/api/liclick/account-binding/callback?loginId=binding-test',
  'The account-binding callback must retain the deployed public path.',
);
assert.equal(
  buildPersonalLiclickAccountCallbackUrl(
    'https://li3d.example.test/root/',
    '',
    'binding-fallback',
  ).toString(),
  'https://li3d.example.test/root/api/liclick/account-binding/callback?loginId=binding-fallback',
  'The public workspace URL pathname remains the fallback when no explicit public path is set.',
);

const [routeSource, atlasSource, webOAuthSource, serverSource, setupSource] = await Promise.all([
  readFile(path.join(packageRoot, 'src/routes/liclick.ts'), 'utf8'),
  readFile(path.join(packageRoot, 'src/auth/atlasAuthService.ts'), 'utf8'),
  readFile(path.join(packageRoot, 'src/auth/webOAuthService.ts'), 'utf8'),
  readFile(path.join(packageRoot, 'src/index.ts'), 'utf8'),
  readFile(path.resolve(packageRoot, '../../scripts/setup-linux-a100.sh'), 'utf8'),
]);

assert.match(routeSource, /code:\s*'LICLICK_PERSONAL_ACCOUNT_REQUIRED'/);
assert.match(routeSource, /startPersonalLiclickAccountBinding\(user\)/);
assert.match(routeSource, /pollPersonalLiclickAccountBinding\(segments\[3\], user\)/);
assert.match(routeSource, /getPersonalLiclickAccountCallbackHtml\(loginId, user\)/);
assert.match(routeSource, /completePersonalLiclickAccountBinding\(loginId, user, body\)/);
assert.doesNotMatch(
  routeSource,
  /pollLiclickImageTask\(segments\[3\]/,
  'Unknown remote task ids must never be polled with the current or shared credential.',
);
assert.match(atlasSource, /禁止使用服务器共享 Atlas 凭据调用莉刻/);
assert.match(atlasSource, /莉刻账号与当前飞书登录账号不一致，已拒绝关联/);
assert.match(atlasSource, /ATLAS_RUNTIME_INCOMPATIBLE/);
assert.match(atlasSource, /minimumCompatibleAtlasSkillhubVersion = '2\.9\.1'/);
assert.match(atlasSource, /encryptedTokenCacheReaderPromise = undefined/);
assert.match(atlasSource, /runtime\.authenticate/);
assert.match(atlasSource, /gateway', 'list-tools', '--service', 'liclick'/);
assert.doesNotMatch(atlasSource, /writeFile\(tokenFile/);
assert.match(webOAuthSource, /getPersonalLiclickAccount\(user\)/);
assert.match(webOAuthSource, /startPersonalLiclickAccountBinding\(user/);
assert.match(webOAuthSource, /completeWebOAuthLiclickBinding/);
assert.match(serverSource, /getAtlasRuntimeCompatibility\(\)/);
assert.match(serverSource, /secureTokenCacheReader: atlasRuntime\.secureTokenCacheReader/);
assert.match(setupSource, /ATLAS_SKILLHUB_VERSION="\$\{ATLAS_SKILLHUB_VERSION:-2\.9\.1\}"/);
assert.match(setupSource, /@lilith\/atlas-skillhub@\$\{ATLAS_SKILLHUB_VERSION\}/);

process.stdout.write('Liclick personal-account boundary regression test passed.\n');
