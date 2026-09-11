/* global console, process */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

// RELEASE-PREPUSH/1.0.0: consume the actual CI build job, including metadata.
// This command validates locally; it never pushes or deploys.
const root = path.resolve(import.meta.dirname, '..');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
if (git('status', '--porcelain', '--untracked-files=no')) {
  throw new Error('请先提交本次修改，再对准备推送的提交运行 pnpm verify:prepush。');
}
const pnpm = process.env.npm_execpath;
if (!pnpm) throw new Error('请通过 pnpm verify:prepush 运行。');
const branch = git('branch', '--show-current');
if (!branch) throw new Error('请在准备推送的分支上运行，不能使用 detached HEAD。');
const sha = git('rev-parse', 'HEAD');
const values = {
  CI_COMMIT_SHA: sha,
  CI_COMMIT_SHORT_SHA: sha.slice(0, 8),
  CI_COMMIT_REF_SLUG: branch.toLowerCase().replace(/[^a-z0-9]/g, '-').slice(0, 63).replace(/^-+|-+$/g, ''),
  CI_JOB_STARTED_AT: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
};
const ci = yaml.load(fs.readFileSync(path.join(root, '.gitlab-ci.yml'), 'utf8'));
const environment = { ...process.env };
for (const [key, value] of Object.entries(ci.build.variables)) {
  environment[key] = String(value).replace(/\$([A-Z_]+)/g, (_, name) => {
    if (!(name in values)) throw new Error(`CI 发布变量未实现：${name}`);
    return values[name];
  });
}
console.log(`正式发布推送前检查：${branch} / ${sha}`);
for (const command of [...ci.lint.script, ...ci.build.script]) {
  if (!/^corepack pnpm [\w :./-]+$/.test(command)) {
    throw new Error(`CI 构建命令发生变化，请同步检查入口：${command}`);
  }
  console.log(`\n[prepush] ${command}`);
  const result = spawnSync(process.execPath, [pnpm, ...command.slice('corepack pnpm '.length).split(/\s+/)], {
    cwd: root, env: environment, stdio: 'inherit', windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
if (git('rev-parse', 'HEAD') !== sha || git('status', '--porcelain', '--untracked-files=no')) {
  throw new Error('检查期间提交或源码发生变化，请重新运行检查。');
}
console.log(`\n推送前检查通过：${sha}。提交变化后必须重新检查。`);
