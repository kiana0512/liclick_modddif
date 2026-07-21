import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const children = new Set();
const serverRoot = fileURLToPath(new URL('..', import.meta.url));
const tscCli = path.resolve(serverRoot, '..', '..', 'node_modules', 'typescript', 'bin', 'tsc');

function runInitialBuild() {
  const result = spawnSync(process.execPath, [tscCli, '-p', 'tsconfig.json'], {
    cwd: serverRoot,
    shell: false,
    stdio: 'inherit',
  });
  if (result.status && result.status !== 0) process.exit(result.status);
  if (result.error) {
    console.error(result.error);
    process.exit(1);
  }
}

function run(command, args, label) {
  const child = spawn(command, args, {
    cwd: serverRoot,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.add(child);

  child.stdout.on('data', (chunk) => process.stdout.write(`[${label}] ${chunk}`));
  child.stderr.on('data', (chunk) => process.stderr.write(`[${label}] ${chunk}`));
  child.on('exit', (code) => {
    children.delete(child);
    if (code && code !== 0) process.exitCode = code;
  });

  return child;
}

function shutdown() {
  for (const child of children) child.kill();
}

process.on('SIGINT', () => {
  shutdown();
  process.exit(0);
});
process.on('SIGTERM', () => {
  shutdown();
  process.exit(0);
});

runInitialBuild();
run(process.execPath, [tscCli, '-p', 'tsconfig.json', '--watch', '--preserveWatchOutput', 'false'], 'server:tsc');
run(process.execPath, ['--watch', 'dist/index.js'], 'server');
