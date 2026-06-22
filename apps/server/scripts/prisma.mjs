import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(serverRoot, '..', '..');

process.env.DATABASE_URL ??= `file:${path.join(repoRoot, 'workspace', 'liclick.db').replaceAll('\\', '/')}`;

const command = process.execPath;
const pnpmEntrypoint = process.env.npm_execpath;
if (!pnpmEntrypoint) {
  throw new Error('This script must be run through pnpm so Prisma can be resolved from the workspace.');
}

const child = spawn(command, [pnpmEntrypoint, 'exec', 'prisma', ...process.argv.slice(2), '--schema', 'prisma/schema.prisma'], {
  cwd: serverRoot,
  env: process.env,
  stdio: 'inherit',
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exitCode = code ?? 0;
});
