/* global console, process */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

// RELEASE-PREPUSH/1.3.0: all CI verify jobs, build and advisory size/headroom report.
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
  CI_JOB_STARTED_AT: new Date().toISOString().replace(/\.\d{3}Z$/, '+00:00'),
};
const ci = yaml.load(fs.readFileSync(path.join(root, '.gitlab-ci.yml'), 'utf8'));
console.log(`正式发布推送前检查：${branch} / ${sha}`);
const verifyJobs = Object.entries(ci).filter(([name, job]) =>
  !name.startsWith('.') && job?.stage === 'verify');
if (!verifyJobs.length) throw new Error('CI 未声明 verify 任务，拒绝跳过回归检查。');
const jobs = [...verifyJobs, ['build', ci.build], ['bundle-headroom', {
  variables: ci.build.variables,
  script: ['corepack pnpm run check:web-bundle-budget --reserve-bytes=256'],
}]];
for (const [name, job] of jobs) {
  if (!Array.isArray(job.script) || !job.script.length) {
    throw new Error(`CI 任务 ${name} 缺少直接 script，请同步检查入口。`);
  }
  const environment = { ...process.env };
  for (const [key, value] of Object.entries(job.variables ?? {})) {
    environment[key] = String(value).replace(/\$([A-Z_]+)/g, (_, variable) => {
      if (!(variable in values)) throw new Error(`CI 发布变量未实现：${variable}`);
      return values[variable];
    });
  }
  for (const command of job.script) {
    if (typeof command !== 'string' || !/^(corepack pnpm|node) [\w :./=@-]+$/.test(command)) {
      throw new Error(`CI 命令发生变化，请同步检查入口：${command}`);
    }
    const args = command.startsWith('corepack pnpm ')
      ? [pnpm, ...command.slice('corepack pnpm '.length).split(/\s+/)]
      : command.slice('node '.length).split(/\s+/);
    console.log(`\n[prepush:${name}] ${command}`);
    const result = spawnSync(process.execPath, args, {
      cwd: root, env: environment, stdio: 'inherit', windowsHide: true,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}
if (git('rev-parse', 'HEAD') !== sha || git('status', '--porcelain', '--untracked-files=no')) {
  throw new Error('检查期间提交或源码发生变化，请重新运行检查。');
}
console.log(`\n推送前检查通过：${sha}。提交变化后必须重新检查。`);
