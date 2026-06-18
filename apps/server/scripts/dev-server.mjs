import { spawn } from 'node:child_process';

const children = new Set();

function run(command, args, label) {
  const child = spawn(command, args, {
    cwd: new URL('..', import.meta.url),
    shell: process.platform === 'win32',
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

run('tsc', ['-p', 'tsconfig.json', '--watch', '--preserveWatchOutput', 'false'], 'server:tsc');
run('node', ['--watch', 'dist/index.js'], 'server');
