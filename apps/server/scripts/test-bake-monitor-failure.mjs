import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import ts from 'typescript';

// Execute the production monitor in strict-rejection child processes. Inject only
// its I/O boundary so ENOSPC cannot affect a user's workspace or remote jobs.
const source = readFileSync(new URL('../src/services/substanceBakeService.ts', import.meta.url), 'utf8');
const start = source.indexOf('async function monitorRemoteJob(');
const end = source.indexOf('\nfunction internalJobFromPersisted', start);
assert(start >= 0 && end > start);
const monitor = ts.transpileModule(source.slice(start, end), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

for (const failure of ['poll', 'postprocess']) {
  const child = spawnSync(process.execPath, ['--unhandled-rejections=strict', '--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    const monitors = new Set(), records = [], reports = [];
    const console = { error: (...args) => reports.push(args) };
    let failWrites = true, failRemote = true, polls = 0;
    const job = { id: 'failed-job', status: 'running', logs: [], remote: { jobId: 'remote-a', statusUrl: 'fixture' } };
    const requestRemote = async () => {
      polls++;
      if (failRemote && ${JSON.stringify(failure)} === 'poll') throw new Error('remote unavailable');
      return { job_id: 'remote-a', status: 'SUCCEEDED' };
    };
    const ensureRemoteSuccess = () => {};
    const parseJson = value => value;
    const applyRemoteStatus = async (job, payload) => { job.remote.status = payload.status; };
    const downloadArtifacts = async job => {
      if (failRemote) throw new Error('artifact failed');
      job.status = 'succeeded';
      await appendLog(job, 'completed');
    };
    const appendLog = async (job, message) => {
      job.logs.push(message);
      if (failWrites) throw new Error('injected ENOSPC');
      records.push(structuredClone(job));
    };
    const delay = async () => {};
    class BakeRequestError extends Error {}
    ${monitor}
    void monitorRemoteJob(job);
    // Real monitor deduplication must remain active across the first await.
    void monitorRemoteJob(job);
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(polls, 1);
    assert.equal(job.status, 'failed');
    assert.equal(job.stage, 'finished');
    assert(job.finishedAt);
    assert.equal(records.length, 0, 'Failed writes cannot be reported as durable completion');
    assert.equal(monitors.size, 0, 'Monitor registration is released after failed persistence');
    assert.equal(reports.length, 1, 'Persistence failure remains observable');
    assert(reports[0].some(value => String(value).includes('failed-job')));
    assert(reports[0].some(value => String(value).includes('ENOSPC')));
    failWrites = false; failRemote = false;
    const next = { id: 'next-job', status: 'running', logs: [], remote: { jobId: 'remote-a', statusUrl: 'fixture' } };
    await monitorRemoteJob(next);
    assert.equal(next.status, 'succeeded');
    assert.equal(records.length, 1);
    assert.equal(monitors.size, 0);
    process.stdout.write('monitor recovered');
  `], { encoding: 'utf8', timeout: 10_000, windowsHide: true });
  assert.equal(child.status, 0, `${failure}: ${child.error ?? child.stderr}`);
  assert.match(child.stdout, /monitor recovered/);
}
console.log('Bake background monitor strict-rejection fault regressions passed.');
