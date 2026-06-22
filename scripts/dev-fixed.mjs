import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptsDir, '..');

const env = {
  ...process.env,
  LICLICK_WORKSPACE_PORT: process.env.LICLICK_WORKSPACE_PORT ?? '4517',
  LICLICK_WORKSPACE_DIR: process.env.LICLICK_WORKSPACE_DIR ?? path.join(repoRoot, 'workspace'),
  LICLICK_PUBLIC_WORKSPACE_URL: process.env.LICLICK_PUBLIC_WORKSPACE_URL ?? 'http://localhost:4517',
  VITE_LICLICK_WORKSPACE_API: process.env.VITE_LICLICK_WORKSPACE_API ?? 'http://localhost:4517',
  AUTH_MODE: process.env.AUTH_MODE ?? 'feishu-oauth',
};

const child = spawn(
  'corepack',
  ['pnpm', '--parallel', '--filter', '@liclick/server', '--filter', '@liclick/web', 'dev'],
  {
    cwd: repoRoot,
    env,
    shell: process.platform === 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);

child.stdout?.on('data', (chunk) => process.stdout.write(chunk));
child.stderr?.on('data', (chunk) => process.stderr.write(chunk));

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exitCode = code ?? 0;
});
