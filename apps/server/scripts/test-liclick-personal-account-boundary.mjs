import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  pollLiclickImageTask,
  submitLiclickImageEdit,
  submitLiclickImageJob,
} from '../dist/services/liclickGenerationService.js';
import {
  buildPersonalLiclickAccountCallbackUrl,
  buildPersonalLiclickAccountSsoUrl,
  buildPersonalLiclickAccountTargetUrl,
  resolvePersonalLiclickAccountTargetLoginId,
  resolveLiclickAtlasUser,
} from '../dist/auth/atlasAuthService.js';
import { getLiclickUserErrorMessage } from '../dist/services/liclickErrorMessage.js';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const sharedWorkspaceDir = path.join(packageRoot, '.shared-test-workspace');
const sharedAtlasHomeDir = path.join(sharedWorkspaceDir, 'atlas-homes', 'owner');
const configProbeSource =
  "const {serverConfig}=await import('./dist/config.js');process.stdout.write(JSON.stringify(serverConfig.sharedLiclickTestAccount));";
const validSharedConfigProbe = spawnSync(
  process.execPath,
  ['--input-type=module', '--eval', configProbeSource],
  {
    cwd: packageRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      LICLICK_WORKSPACE_DIR: sharedWorkspaceDir,
      LICLICK_SHARED_TEST_ACCOUNT_ENABLED: 'true',
      LICLICK_SHARED_TEST_ACCOUNT_EMAIL: 'shared.owner@lilith.com',
      LICLICK_SHARED_TEST_ATLAS_HOME: sharedAtlasHomeDir,
    },
  },
);
assert.equal(validSharedConfigProbe.status, 0, validSharedConfigProbe.stderr);
assert.deepEqual(JSON.parse(validSharedConfigProbe.stdout), {
  enabled: true,
  email: 'shared.owner@lilith.com',
  atlasHomeDir: path.resolve(sharedAtlasHomeDir),
});
const escapedSharedConfigProbe = spawnSync(
  process.execPath,
  ['--input-type=module', '--eval', configProbeSource],
  {
    cwd: packageRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      LICLICK_WORKSPACE_DIR: sharedWorkspaceDir,
      LICLICK_SHARED_TEST_ACCOUNT_ENABLED: 'true',
      LICLICK_SHARED_TEST_ACCOUNT_EMAIL: 'shared.owner@lilith.com',
      LICLICK_SHARED_TEST_ATLAS_HOME: path.join(sharedWorkspaceDir, '..', 'outside-owner'),
    },
  },
);
assert.notEqual(escapedSharedConfigProbe.status, 0);
assert.match(escapedSharedConfigProbe.stderr, /must point to one managed Atlas home/);

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
  buildPersonalLiclickAccountCallbackUrl('http://10.3.2.59:44770', '/li3d').toString(),
  'http://10.3.2.59:44770/li3d/api/liclick/account-binding/callback',
  'The registered account-binding callback must be fixed and retain the deployed public path.',
);
assert.equal(
  buildPersonalLiclickAccountCallbackUrl('https://li3d.example.test/root/', '').toString(),
  'https://li3d.example.test/root/api/liclick/account-binding/callback',
  'The public workspace URL pathname remains the fallback when no explicit public path is set.',
);
const bindingId = '6f0e8fb0-6772-4f25-b5bc-8639290bf28d';
const bindingTargetUrl = buildPersonalLiclickAccountTargetUrl(
  'https://li3d.example.test/root/',
  '',
  bindingId,
);
assert.equal(
  bindingTargetUrl.toString(),
  `https://li3d.example.test/root/api/liclick/account-binding/complete?loginId=${bindingId}`,
);
assert.equal(
  resolvePersonalLiclickAccountTargetLoginId(
    bindingTargetUrl.toString(),
    'https://li3d.example.test/root/',
    '',
  ),
  bindingId,
);
for (const invalidTargetUrl of [
  `https://attacker.example/api/liclick/account-binding/complete?loginId=${bindingId}`,
  `https://li3d.example.test/root/api/liclick/account-binding/callback?loginId=${bindingId}`,
  `https://li3d.example.test/root/api/liclick/account-binding/complete?loginId=${bindingId}&next=https://attacker.example`,
  'https://li3d.example.test/root/api/liclick/account-binding/complete?loginId=not-a-uuid',
]) {
  assert.throws(
    () =>
      resolvePersonalLiclickAccountTargetLoginId(
        invalidTargetUrl,
        'https://li3d.example.test/root/',
        '',
      ),
    /账号关联目标无效/,
  );
}
const ssoUrl = buildPersonalLiclickAccountSsoUrl(
  'https://qa-idaas.lilithgames.com/enduser/sp/sso/qa-app?redirect_uri=old&state=old',
  'qa-enterprise',
  bindingTargetUrl,
);
assert.equal(ssoUrl.searchParams.get('target_url'), bindingTargetUrl.toString());
assert.equal(ssoUrl.searchParams.get('enterpriseId'), 'qa-enterprise');
assert.equal(ssoUrl.searchParams.has('redirect_uri'), false);
assert.equal(ssoUrl.searchParams.has('state'), false);

const originalUser = {
  id: 'feishu-test-user',
  displayName: 'Test User',
  email: 'test.user@lilith.com',
  role: 'user',
  status: 'active',
  authSource: 'feishu-oauth',
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
  lastLoginAt: new Date(0).toISOString(),
};
assert.equal(
  resolveLiclickAtlasUser(originalUser, {
    enabled: true,
    email: 'shared.owner@lilith.com',
    atlasHomeDir: '/managed/atlas/shared-owner',
  }).atlasHomeDir,
  '/managed/atlas/shared-owner',
  'The explicit test-only switch must route authenticated users to the configured Atlas home.',
);
assert.strictEqual(
  resolveLiclickAtlasUser(originalUser, {
    enabled: false,
    email: '',
    atlasHomeDir: '',
  }),
  originalUser,
  'Production mode must preserve the personal-account user unchanged.',
);

const [routeSource, atlasSource, configSource, webOAuthSource, serverSource, setupSource] = await Promise.all([
  readFile(path.join(packageRoot, 'src/routes/liclick.ts'), 'utf8'),
  readFile(path.join(packageRoot, 'src/auth/atlasAuthService.ts'), 'utf8'),
  readFile(path.join(packageRoot, 'src/config.ts'), 'utf8'),
  readFile(path.join(packageRoot, 'src/auth/webOAuthService.ts'), 'utf8'),
  readFile(path.join(packageRoot, 'src/index.ts'), 'utf8'),
  readFile(path.resolve(packageRoot, '../../scripts/setup-linux-a100.sh'), 'utf8'),
]);

assert.match(routeSource, /code:\s*'LICLICK_PERSONAL_ACCOUNT_REQUIRED'/);
assert.match(routeSource, /startPersonalLiclickAccountBinding\(user\)/);
assert.match(routeSource, /pollPersonalLiclickAccountBinding\(segments\[3\], user\)/);
assert.match(routeSource, /getPersonalLiclickAccountCallbackHtml\(targetUrl, user\)/);
assert.match(routeSource, /completePersonalLiclickAccountBinding\(loginId, user, body\)/);
assert.match(routeSource, /url\.searchParams\.get\('target_url'\)/);
assert.doesNotMatch(routeSource, /url\.searchParams\.get\('loginId'\)/);
assert.doesNotMatch(
  routeSource,
  /pollLiclickImageTask\(segments\[3\]/,
  'Unknown remote task ids must never be polled with the current or shared credential.',
);
assert.match(atlasSource, /resolveLiclickAtlasUser/);
assert.match(atlasSource, /测试共享莉刻账号由服务器管理，不能从用户菜单解除/);
assert.match(atlasSource, /莉刻账号与当前飞书登录账号不一致，已拒绝关联/);
assert.match(atlasSource, /ATLAS_RUNTIME_INCOMPATIBLE/);
assert.match(atlasSource, /minimumCompatibleAtlasSkillhubVersion = '2\.9\.1'/);
assert.match(atlasSource, /encryptedTokenCacheReaderPromise = undefined/);
assert.match(atlasSource, /runtime\.authenticate/);
assert.match(atlasSource, /gateway', 'list-tools', '--service', 'liclick'/);
assert.doesNotMatch(atlasSource, /writeFile\(tokenFile/);
assert.match(atlasSource, /searchParams\.set\('target_url'/);
assert.doesNotMatch(atlasSource, /searchParams\.set\('redirect_uri'/);
assert.doesNotMatch(atlasSource, /searchParams\.set\('state'/);
assert.match(configSource, /LICLICK_SHARED_TEST_ACCOUNT_ENABLED/);
assert.match(configSource, /LICLICK_SHARED_TEST_ACCOUNT_EMAIL/);
assert.match(configSource, /LICLICK_SHARED_TEST_ATLAS_HOME/);
assert.match(configSource, /must point to one managed Atlas home/);
assert.match(routeSource, /LICLICK_SHARED_TEST_ACCOUNT_LOCKED/);
assert.match(webOAuthSource, /getPersonalLiclickAccount\(user\)/);
assert.match(webOAuthSource, /startPersonalLiclickAccountBinding\(user/);
assert.match(webOAuthSource, /completeWebOAuthLiclickBinding/);
assert.match(serverSource, /getAtlasRuntimeCompatibility\(\)/);
assert.match(serverSource, /secureTokenCacheReader: atlasRuntime\.secureTokenCacheReader/);
assert.match(setupSource, /ATLAS_SKILLHUB_VERSION="\$\{ATLAS_SKILLHUB_VERSION:-2\.9\.1\}"/);
assert.match(setupSource, /@lilith\/atlas-skillhub@\$\{ATLAS_SKILLHUB_VERSION\}/);

process.stdout.write('Liclick personal-account boundary regression test passed.\n');
