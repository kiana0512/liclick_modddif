import { spawnSync } from 'node:child_process';
if (process.argv.length > 2) throw new Error('Release builds accept no debug flags.');
const env = { ...process.env, LI3D_DEBUG_BUILD: 'false', VITE_LICLICK_PIPELINE_TRACE_ENABLED: 'false' };
const commands = [[process.execPath, ['scripts/validate-release-env.mjs']], [process.execPath, [process.env.npm_execpath, '-r', 'build']]];
for (const [command, args] of commands) {
  const result = spawnSync(command, args, { env, stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
