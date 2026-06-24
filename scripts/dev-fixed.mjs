import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptsDir, '..');
const workspacePort = process.env.LICLICK_WORKSPACE_PORT ?? '4517';
const webPort = process.env.LICLICK_WEB_PORT ?? '5173';
const restartWorkspace = process.env.LICLICK_DEV_RESTART_WORKSPACE !== '0';

const env = {
  ...process.env,
  LICLICK_WORKSPACE_PORT: workspacePort,
  LICLICK_WORKSPACE_DIR: process.env.LICLICK_WORKSPACE_DIR ?? path.join(repoRoot, 'workspace'),
  LICLICK_PUBLIC_WORKSPACE_URL:
    process.env.LICLICK_PUBLIC_WORKSPACE_URL ?? `http://127.0.0.1:${workspacePort}`,
  VITE_LICLICK_WORKSPACE_API:
    process.env.VITE_LICLICK_WORKSPACE_API ?? `http://127.0.0.1:${workspacePort}`,
  AUTH_MODE: process.env.AUTH_MODE ?? 'feishu-oauth',
};

function requestJson(url) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: 800 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch {
          resolve(null);
        }
      });
    });
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
    req.on('error', () => resolve(null));
  });
}

function killPortOnWindows(port) {
  const script = [
    `$connections = Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue`,
    '$connections | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object {',
    '  if ($_ -and $_ -ne $PID) { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }',
    '}',
  ].join('; ');
  const killer = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    cwd: repoRoot,
    shell: false,
    stdio: 'inherit',
  });
  return new Promise((resolve, reject) => {
    killer.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`port cleanup failed: ${code}`))));
    killer.on('error', reject);
  });
}

function runCommand(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: repoRoot,
    shell: false,
    stdio: options.stdio ?? ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('exit', (code) => resolve({ code: code ?? 0, stdout, stderr }));
    child.on('error', reject);
  });
}

async function commandExists(command) {
  const result = await runCommand('sh', ['-lc', `command -v ${command}`]);
  return result.code === 0;
}

async function getPortPidsOnUnix(port) {
  const commands = [];
  if (await commandExists('lsof')) commands.push(`lsof -nP -tiTCP:${port} -sTCP:LISTEN`);
  if (await commandExists('fuser')) commands.push(`fuser ${port}/tcp 2>/dev/null`);
  if (await commandExists('ss')) {
    commands.push(
      `ss -ltnp "sport = :${port}" 2>/dev/null | sed -n 's/.*pid=\\([0-9][0-9]*\\).*/\\1/p'`,
    );
  }

  const pids = new Set();
  for (const command of commands) {
    const result = await runCommand('sh', ['-lc', command]);
    for (const token of `${result.stdout}\n${result.stderr}`.matchAll(/\b\d+\b/g)) {
      const pid = Number(token[0]);
      if (pid > 1 && pid !== process.pid) pids.add(pid);
    }
  }
  return [...pids];
}

async function waitForPortReleaseOnUnix(port, timeoutMs = 3000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const pids = await getPortPidsOnUnix(port);
    if (pids.length === 0) return true;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return false;
}

async function killPortOnUnix(port) {
  const pids = await getPortPidsOnUnix(port);
  if (pids.length === 0) return;
  console.log(`[dev] Port ${port} is busy; killing listener PID(s): ${pids.join(', ')}`);

  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch (error) {
      if (error?.code !== 'ESRCH') {
        throw new Error(`Could not stop PID ${pid} on port ${port}: ${error?.message ?? error}`);
      }
    }
  }

  if (!(await waitForPortReleaseOnUnix(port))) {
    for (const pid of await getPortPidsOnUnix(port)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch (error) {
        if (error?.code !== 'ESRCH') {
          throw new Error(`Could not force-stop PID ${pid} on port ${port}: ${error?.message ?? error}`);
        }
      }
    }
  }

  if (!(await waitForPortReleaseOnUnix(port))) {
    throw new Error(
      `Port ${port} is still occupied. Try: lsof -ti:${port} | xargs kill -9, then restart dev.`,
    );
  }
}

async function prepareWorkspacePort() {
  if (!restartWorkspace) return;

  const health = await requestJson(`http://127.0.0.1:${workspacePort}/api/health`);
  if (process.platform === 'win32') {
    if (health?.ok) {
      console.log(
        `[dev] Found an existing workspace server on 127.0.0.1:${workspacePort}; restarting it so this dev run owns the backend.`,
      );
    }
    await killPortOnWindows(workspacePort);
    await killPortOnWindows(webPort);
    return;
  }

  if (health?.ok) {
    console.log(
      `[dev] Found an existing workspace server on 127.0.0.1:${workspacePort}; restarting it so this dev run owns the backend.`,
    );
  }
  await killPortOnUnix(workspacePort);
  await killPortOnUnix(webPort);
}

await prepareWorkspacePort();

const child = spawn('corepack', ['pnpm', '--parallel', '--filter', '@liclick/server', '--filter', '@liclick/web', 'dev'], {
  cwd: repoRoot,
  env,
  shell: process.platform === 'win32',
  stdio: ['ignore', 'pipe', 'pipe'],
});

child.stdout?.on('data', (chunk) => process.stdout.write(chunk));
child.stderr?.on('data', (chunk) => process.stderr.write(chunk));

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exitCode = code ?? 0;
});
