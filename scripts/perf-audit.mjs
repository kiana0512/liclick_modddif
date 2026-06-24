import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

const root = process.cwd();
const args = new Set(process.argv.slice(2));
const largeFileLimitMb = Number(process.env.LICLICK_LARGE_FILE_MB ?? 50);
const concurrency = Number(process.env.LICLICK_STRESS_USERS ?? 30);
const baseUrl = process.env.LICLICK_STRESS_BASE_URL;
const stressDurationSeconds = Number(process.env.LICLICK_STRESS_SECONDS ?? 15);
const ignoredDirs = new Set(['.git', 'node_modules', '.pnpm-store', 'dist', '.vite']);

function bytesToMb(bytes) {
  return bytes / 1024 / 1024;
}

function walkFiles(dir, output = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ignoredDirs.has(entry.name)) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(fullPath, output);
      continue;
    }
    if (entry.isFile()) {
      const stat = fs.statSync(fullPath);
      output.push({ path: fullPath, size: stat.size });
    }
  }
  return output;
}

function auditFiles() {
  const files = walkFiles(root);
  const largeFiles = files
    .filter((file) => bytesToMb(file.size) >= largeFileLimitMb)
    .sort((a, b) => b.size - a.size);
  const workspaceFiles = files.filter((file) => file.path.includes(`${path.sep}workspace${path.sep}`));
  const workspaceBytes = workspaceFiles.reduce((total, file) => total + file.size, 0);
  const generationJobs = path.join(root, 'workspace', 'generation-jobs.json');
  const generationJobsMb = fs.existsSync(generationJobs) ? bytesToMb(fs.statSync(generationJobs).size) : 0;

  console.log(`Workspace payload: ${bytesToMb(workspaceBytes).toFixed(2)} MB`);
  console.log(`generation-jobs.json: ${generationJobsMb.toFixed(2)} MB`);
  if (largeFiles.length > 0) {
    console.log(`Large files >= ${largeFileLimitMb} MB:`);
    for (const file of largeFiles) {
      console.log(`- ${bytesToMb(file.size).toFixed(2)} MB ${path.relative(root, file.path)}`);
    }
  } else {
    console.log(`No files >= ${largeFileLimitMb} MB outside ignored build/dependency folders.`);
  }

  if (generationJobsMb >= largeFileLimitMb) {
    process.exitCode = 1;
  }
}

async function stressEndpoint(endpoint) {
  if (!baseUrl) return;
  const startedAt = performance.now();
  const deadline = startedAt + stressDurationSeconds * 1000;
  const results = [];

  async function worker(index) {
    while (performance.now() < deadline) {
      const requestStartedAt = performance.now();
      try {
        const response = await fetch(`${baseUrl}${endpoint}`, {
          headers: { 'x-load-user': `perf-audit-${index}` },
        });
        const body = await response.text();
        results.push({
          ok: response.ok,
          status: response.status,
          durationMs: performance.now() - requestStartedAt,
          bytes: body.length,
        });
      } catch (error) {
        results.push({
          ok: false,
          status: 'network-error',
          durationMs: performance.now() - requestStartedAt,
          bytes: 0,
          error,
        });
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, (_, index) => worker(index + 1)));
  const failed = results.filter((result) => !result.ok).length;
  const durations = results.map((result) => result.durationMs).sort((a, b) => a - b);
  const p95 = durations[Math.max(0, Math.ceil(durations.length * 0.95) - 1)] ?? 0;
  console.log(
    `Stress ${endpoint}: users=${concurrency}, seconds=${stressDurationSeconds}, requests=${results.length}, failed=${failed}, p95=${p95.toFixed(1)}ms`,
  );
  if (failed > 0) process.exitCode = 1;
}

auditFiles();
if (args.has('--stress') && baseUrl) {
  await stressEndpoint('/api/health');
}
