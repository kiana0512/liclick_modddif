import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import yaml from 'js-yaml';
import { validateRuntimeEnv } from '../deploy/validate-runtime-env.mjs';

const root = path.resolve(import.meta.dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
const parse = p => yaml.load(read(p));
const valid = {
  LICLICK_RUNTIME_MODE: 'cloud', LICLICK_PROJECT_REPOSITORY: 'postgres',
  AUTH_MODE: 'feishu-oauth', SESSION_COOKIE_SECURE: 'true',
  SESSION_SECRET: 'test-only-session-value',
  FEISHU_OAUTH_CLIENT_ID: 'test-id', FEISHU_OAUTH_CLIENT_SECRET: 'test-secret',
  LICLICK_CLOUD_DATABASE_URL: 'postgresql://test:secret@db.invalid/li3d',
  LICLICK_OBJECT_STORAGE_ENDPOINT: 'https://objects.invalid',
  LICLICK_OBJECT_STORAGE_BUCKET: 'test-assets',
  LICLICK_OBJECT_STORAGE_ACCESS_KEY_ID: 'test-access',
  LICLICK_OBJECT_STORAGE_SECRET_ACCESS_KEY: 'test-secret',
};

test('Cloud startup rejects incomplete persistence without exposing supplied values', () => {
  assert.deepEqual(validateRuntimeEnv(valid), []);
  for (const name of Object.keys(valid)) {
    const input = { ...valid, [name]: '' };
    assert.ok(validateRuntimeEnv(input).some(error => error.includes(name)), name);
  }
  for (const [name, value] of [
    ['LICLICK_CLOUD_DATABASE_URL', 'file:/data/old.db'],
    ['LICLICK_OBJECT_STORAGE_ENDPOINT', 'http://objects.invalid'],
    ['LICLICK_SHARED_TEST_ACCOUNT_ENABLED', 'true'],
  ]) {
    const errors = validateRuntimeEnv({ ...valid, [name]: value });
    assert.ok(errors.length);
    assert.ok(errors.every(error => !error.includes(value)));
  }
});

test('Every K8s and CI YAML parses without duplicate keys', () => {
  const visit = dir => {
    for (const file of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const p = path.join(dir, file.name);
      if (file.isDirectory()) visit(p);
      else if (/\.ya?ml$/.test(p)) yaml.loadAll(read(p));
    }
  };
  visit('deploy');
  parse('.gitlab-ci.yml');
});

test('secret preparation preserves existing keys and blocks missing or multiline values', () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'li3d-deploy-env-'));
  const relative = 'deploy/k8s/base/secrets/server.env';
  const output = path.join(sandbox, relative);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const shell = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'sh';
  const script = path.join(root, 'deploy/prepare-cloud-secret.sh');
  const run = env => spawnSync(shell, [script], {
    cwd: sandbox, env: { ...process.env, ...env }, encoding: 'utf8', windowsHide: true,
  });
  try {
    fs.writeFileSync(output, 'QWEN3_VL_PLUS_API_KEY=test-only-key\n');
    const success = run(valid);
    assert.equal(success.status, 0, success.stderr);
    const content = fs.readFileSync(output, 'utf8');
    assert.ok(content.startsWith('QWEN3_VL_PLUS_API_KEY=test-only-key\n'));
    assert.ok(content.includes('LICLICK_CLOUD_DATABASE_URL=' + valid.LICLICK_CLOUD_DATABASE_URL));
    assert.doesNotMatch(success.stdout + success.stderr, /test-only-key|test-access|test-secret/);
    const missing = run({ ...valid, LICLICK_CLOUD_DATABASE_URL: '' });
    assert.notEqual(missing.status, 0);
    for (const newline of ['\n', '\r']) {
      const bad = run({ ...valid, LICLICK_OBJECT_STORAGE_BUCKET: 'test' + newline + 'INJECTED=true' });
      assert.notEqual(bad.status, 0);
      assert.ok(!fs.readFileSync(output, 'utf8').includes('INJECTED=true'));
    }
  } finally {
    assert.ok(path.resolve(sandbox).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test('master verifies both containers with no publishing and release retains every quality gate', () => {
  const ci = parse('.gitlab-ci.yml');
  for (const name of ['contracts-and-cloud-boundary', 'typecheck', 'web-regression', 'server-regression', 'lint', 'build']) {
    assert.ok(ci[name], name);
    assert.equal(ci[name].rules, undefined, name + ' must run on every branch');
    assert.notEqual(ci[name].allow_failure, true);
  }
  const verify = ci['container:verify'];
  assert.deepEqual(verify.parallel.matrix, [{ IMAGE_TARGET: ['server', 'web'] }]);
  assert.match(verify.rules[0].if, /CI_COMMIT_BRANCH == "master"/);
  assert.match(verify.script.join('\n'), /--no-push\b/);
  assert.doesNotMatch(verify.script.join('\n'), /--destination|kubectl/);
  for (const name of ['build:server', 'build:web']) {
    assert.equal(ci[name].rules[0].if, '$CI_COMMIT_BRANCH == "release"');
    assert.deepEqual(ci[name].needs, [{ job: 'build', artifacts: false }]);
  }
  assert.equal(ci['deploy:k8s'].rules[0].if,
    '$CI_COMMIT_BRANCH == "release" && $CI_COMMIT_MESSAGE =~ /\\[deploy\\]/');
  assert.deepEqual(ci['deploy:k8s'].needs, ['build:server', 'build:web']);
  assert.equal(ci['deploy:k8s'].resource_group, 'li3d-production');
  assert.match(ci.default.before_script.join('\n'), /--frozen-lockfile/);
});

test('runtime packaging and migration agree on paths and preserve existing PVC', () => {
  const docker = read('deploy/Dockerfile');
  assert.match(docker, /COPY packages\/contracts\/package.json/);
  assert.match(docker, /pnpm run build:release/);
  assert.match(docker, /pnpm run check:cloud-artifact/);
  assert.match(docker, /pnpm run check:web-bundle-budget/);
  assert.match(docker, /\/app/);
  assert.match(docker, /apps\/server\/dist\/index.js/);
  assert.match(docker, /apps\/server\/scripts\/migrate-cloud-projects.mjs/);
  assert.match(docker, /apps\/server\/sql/);
  assert.doesNotMatch(docker, /db push|Local-Component|ATLAS_TOKEN_FILE/);
  assert.equal(read('.dockerignore'), read('deploy/Dockerfile.dockerignore'));
  for (const pattern of ['.git', 'secrets', '**/secrets', 'workspace', '**/*.env', '**/.npmrc']) {
    assert.ok(read('.dockerignore').split('\n').includes(pattern), pattern);
  }
  const d = parse('deploy/k8s/base/server-deployment.yaml');
  assert.equal(d.spec.replicas, 1);
  const pod = d.spec.template.spec;
  const migration = pod.initContainers.find(c => c.name === 'db-push');
  assert.equal(migration.image, pod.containers.find(c => c.name === 'server').image);
  assert.match(migration.command.join(' '), /validate-runtime-env.mjs && node apps\/server\/scripts\/migrate-cloud-projects.mjs/);
  assert.equal(pod.volumes[0].persistentVolumeClaim.claimName, 'li3d-server-workspace');
  assert.doesNotMatch(read('deploy/docker/nginx/default.conf.template'), /Local-Component|Setup\.exe/);
});
