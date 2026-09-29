import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

const packageRoot = path.resolve(import.meta.dirname, '..');
const packageJson = JSON.parse(await fs.readFile(path.join(packageRoot, 'package.json'), 'utf8'));
const timeoutMs = Number.parseInt(process.env.LICLICK_TEST_TIMEOUT_MS ?? '180000', 10);
const testNames = Object.keys(packageJson.scripts)
  .filter((name) => name.startsWith('test:') && name !== 'test:regression')
  .sort();
const repeatedBuildPrefix = 'node scripts/clean-dist.mjs && tsc -p tsconfig.json && ';

if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000) {
  throw new Error('LICLICK_TEST_TIMEOUT_MS must be an integer of at least 1000ms.');
}
if (testNames.length === 0) throw new Error('No Server regression tests were discovered.');

function runProcess(name, args) {
  return new Promise((resolve, reject) => {
    const pnpmCli = process.env.npm_execpath;
    if (!pnpmCli) {
      reject(new Error('pnpm CLI path is unavailable. Run the suite through pnpm.'));
      return;
    }
    const child = spawn(process.execPath, args(pnpmCli), {
      cwd: packageRoot,
      env: process.env,
      stdio: 'inherit',
      windowsHide: true,
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`${name} exceeded the ${timeoutMs}ms test timeout.`));
      } else if (code !== 0) {
        reject(new Error(`${name} failed with code ${code ?? 'none'} (${signal ?? 'no signal'}).`));
      } else {
        resolve();
      }
    });
  });
}

const compiledTests = new Map();
for (const name of testNames) {
  const script = packageJson.scripts[name];
  if (!script.startsWith(repeatedBuildPrefix)) continue;
  const commands = script.slice(repeatedBuildPrefix.length).split(' && ');
  if (commands.every(command => /^node (?:\.\.\/\.\.\/)?scripts\/[\w-]+\.mjs$/.test(command))) {
    compiledTests.set(name, commands.map(command => command.slice('node '.length)));
  }
}
if (compiledTests.size) {
  process.stdout.write(`\n[server-regression] Compile once for ${compiledTests.size} compiled tests\n`);
  await runProcess('build', pnpmCli => [pnpmCli, 'run', 'build']);
}

for (const name of testNames) {
  process.stdout.write(`\n[server-regression] ${name}\n`);
  const commands = compiledTests.get(name);
  if (commands) {
    for (const command of commands) await runProcess(name, () => [command]);
  } else {
    await runProcess(name, pnpmCli => [pnpmCli, 'run', name]);
  }
}

process.stdout.write(`\nServer regression suite passed: ${testNames.length} contracts.\n`);
