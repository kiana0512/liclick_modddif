import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const installRoot = path.resolve(scriptDir, '..');
const nodeExecutable = path.join(installRoot, 'node', 'node.exe');
const serverEntry = path.join(installRoot, 'apps', 'server', 'dist', 'localComponent.js');
const dataRoot = path.join(
  process.env.LOCALAPPDATA ?? path.join(process.env.USERPROFILE ?? installRoot, 'AppData', 'Local'),
  'LIclick 3D Texture Local Component',
);
const workspaceDir = path.join(dataRoot, 'workspace');
const logsDir = path.join(dataRoot, 'logs');
const pidFile = path.join(dataRoot, 'local-component.pid');
const healthUrl = 'http://127.0.0.1:4617/api/health';
const publicSite = 'https://li3d-creation-suite.zany-degu-7838.chatgpt.site';

function ensureDirectories() {
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.mkdirSync(logsDir, { recursive: true });
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function probeHealth() {
  try {
    const response = await fetch(healthUrl, { signal: AbortSignal.timeout(1500) });
    if (!response.ok) return { reachable: true, compatible: false };
    const payload = await response.json();
    return {
      reachable: true,
      compatible: payload?.ok === true && payload?.capabilities?.includes('texture-painting'),
    };
  } catch {
    return { reachable: false, compatible: false };
  }
}

if (!fs.existsSync(nodeExecutable)) {
  throw new Error(`Bundled Node runtime is missing: ${nodeExecutable}`);
}
if (!fs.existsSync(serverEntry)) {
  throw new Error(`Local component entry is missing: ${serverEntry}`);
}
ensureDirectories();

let health = await probeHealth();
if (health.compatible) process.exit(0);

// The old desktop launcher also used port 4617. Give it time to close instead
// of racing the new always-on local component for the same port.
for (let attempt = 0; health.reachable && attempt < 120; attempt += 1) {
  await delay(5_000);
  health = await probeHealth();
  if (health.compatible) process.exit(0);
}
if (health.reachable) {
  throw new Error('Port 4617 is occupied by another application. Close the old LIclick desktop app and start the local component again.');
}

const stdout = fs.openSync(path.join(logsDir, 'local-component.log'), 'a');
const stderr = fs.openSync(path.join(logsDir, 'local-component-error.log'), 'a');
const child = spawn(nodeExecutable, [serverEntry], {
  cwd: installRoot,
  detached: true,
  windowsHide: true,
  stdio: ['ignore', stdout, stderr],
  env: {
    ...process.env,
    LICLICK_LOCAL_COMPONENT_MODE: '1',
    LICLICK_WORKSPACE_PORT: '4617',
    SERVER_HOST: '127.0.0.1',
    LICLICK_WORKSPACE_DIR: workspaceDir,
    LICLICK_LOCAL_SETTINGS_PATH: path.join(workspaceDir, 'config', 'local-settings.json'),
    LICLICK_PUBLIC_WORKSPACE_URL: 'http://127.0.0.1:4617',
    LICLICK_FRONTEND_URL: publicSite,
    LICLICK_ALLOWED_ORIGINS: publicSite,
    LICLICK_ENABLE_ATLAS_LOCAL_LOGIN: 'false',
    LICLICK_WINDOWS_HIDE: '1',
  },
});

fs.writeFileSync(pidFile, `${child.pid}\n`, 'utf8');
child.unref();
fs.closeSync(stdout);
fs.closeSync(stderr);
