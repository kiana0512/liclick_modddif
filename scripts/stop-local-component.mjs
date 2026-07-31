import fs from 'node:fs';
import path from 'node:path';

const dataRoot = path.join(
  process.env.LOCALAPPDATA ?? path.join(process.env.USERPROFILE ?? process.cwd(), 'AppData', 'Local'),
  'LIclick 3D Texture Local Component',
);
const pidFile = path.join(dataRoot, 'local-component.pid');

try {
  const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
  if (Number.isInteger(pid) && pid > 0) process.kill(pid);
} catch {
  // Already stopped or the PID file is stale.
}

try {
  fs.rmSync(pidFile, { force: true });
} catch {
  // Uninstall can continue even if a stale PID file cannot be removed.
}
