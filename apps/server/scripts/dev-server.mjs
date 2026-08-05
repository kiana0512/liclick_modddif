import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const children = new Set();
const serverRoot = fileURLToPath(new URL('..', import.meta.url));
const tscCli = path.resolve(serverRoot, '..', '..', 'node_modules', 'typescript', 'bin', 'tsc');
const serverEntry = path.join(serverRoot, 'dist', 'index.js');
let repairInProgress = false;
let repairTimer;
let restartTimer;
let serverChild;
let shuttingDown = false;

function runInitialBuild({ fatal = true } = {}) {
  const result = spawnSync(process.execPath, [tscCli, '-p', 'tsconfig.json'], {
    cwd: serverRoot,
    shell: false,
    stdio: 'inherit',
  });
  if (result.status && result.status !== 0) {
    if (fatal) process.exit(result.status);
    return false;
  }
  if (result.error) {
    console.error(result.error);
    if (fatal) process.exit(1);
    return false;
  }
  return fs.existsSync(serverEntry);
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

function launchServer() {
  if (shuttingDown || serverChild || !fs.existsSync(serverEntry)) return;
  const child = spawn(process.execPath, [serverEntry], {
    cwd: serverRoot,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverChild = child;
  children.add(child);
  child.stdout.on('data', (chunk) => process.stdout.write(`[server] ${chunk}`));
  child.stderr.on('data', (chunk) => process.stderr.write(`[server] ${chunk}`));
  child.on('exit', (code, signal) => {
    children.delete(child);
    if (serverChild === child) serverChild = undefined;
    if (!shuttingDown && !signal && code) {
      console.error(`[server] Process exited with code ${code}; waiting for rebuilt output.`);
    }
  });
}

function restartServer() {
  if (restartTimer) clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    restartTimer = undefined;
    if (!serverChild) {
      launchServer();
      return;
    }
    const previous = serverChild;
    previous.once('exit', () => launchServer());
    previous.kill();
  }, 180);
}

function shutdown() {
  shuttingDown = true;
  if (repairTimer) clearInterval(repairTimer);
  if (restartTimer) clearTimeout(restartTimer);
  fs.unwatchFile(serverEntry);
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
launchServer();

fs.watchFile(serverEntry, { interval: 250 }, (current, previous) => {
  if (current.mtimeMs === previous.mtimeMs && current.size === previous.size) return;
  if (!fs.existsSync(serverEntry)) {
    if (serverChild) {
      serverChild.kill();
      serverChild = undefined;
    }
    return;
  }
  restartServer();
});

// Production/package builds intentionally clean dist. If one runs while the
// development watcher is alive, TypeScript may see no source change and leave
// dist/index.js missing forever. Repair the emitted tree; the explicit process
// supervisor above then relaunches the server as soon as the entry reappears.
repairTimer = setInterval(() => {
  if (repairInProgress || fs.existsSync(serverEntry)) return;
  repairInProgress = true;
  console.log('[server] dist/index.js is missing; rebuilding the development output...');
  try {
    if (!runInitialBuild({ fatal: false })) {
      console.error('[server] Could not restore dist/index.js; waiting before retrying.');
    }
  } finally {
    repairInProgress = false;
  }
}, 750);
repairTimer.unref();
