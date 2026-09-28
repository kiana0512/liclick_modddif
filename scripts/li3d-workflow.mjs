/* global Buffer, TextDecoder, URL, document, location, fetch, HTMLInputElement, Event, createImageBitmap, setTimeout, clearTimeout, WebSocket, process, console */
// Node runner globals plus browser globals in functions serialized through CDP.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';

export function glbTriangles(bytes) {
  const b = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 20 || b.getUint32(0, true) !== 0x46546c67 || b.getUint32(4, true) !== 2 || b.getUint32(8, true) !== bytes.length || b.getUint32(16, true) !== 0x4e4f534a) throw new Error('Invalid GLB v2');
  const length = b.getUint32(12, true);
  if (20 + length > bytes.length) throw new Error('Truncated GLB JSON');
  const gltf = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + length)));
  let count = 0;
  const visit = (index, ancestors = new Set()) => {
    if (ancestors.has(index)) throw new Error('Cyclic GLB nodes');
    const node = gltf.nodes[index];
    if (!node) throw new Error('Missing GLB node');
    for (const p of gltf.meshes?.[node.mesh]?.primitives ?? []) {
      if ((p.mode ?? 4) !== 4) throw new Error('Only triangle-list GLB fixtures are supported');
      const n = gltf.accessors[p.indices ?? p.attributes.POSITION]?.count;
      if (!Number.isInteger(n) || n < 3 || n % 3) throw new Error('Invalid triangle count');
      count += n / 3;
    }
    for (const child of node.children ?? []) visit(child, new Set([...ancestors, index]));
  };
  const roots = gltf.scenes?.[gltf.scene ?? 0]?.nodes;
  if (!roots) throw new Error('Missing GLB scene');
  for (const root of roots) visit(root);
  return count;
}

export function completion(project, expectedViews) {
  const generations = project.generations.filter(g => g.metadata.workflow === 'texture-map');
  const ready = generations.filter(g => g.status === 'succeeded' && g.resultUrl && !g.metadata.projectionError && !g.metadata.cancelled &&
    project.layers.some(l => l.id === g.metadata.projectedLayerId && l.generationId === g.id && l.imageUrl && l.objectId === g.metadata.objectId));
  const viewIds = new Set(ready.map(g => g.metadata.cameraViewId).filter(Boolean));
  const failedByView = new Map();
  for (const g of generations) {
    const view = g.metadata.cameraViewId;
    if (!viewIds.has(view) && (g.status === 'failed' || g.metadata.cancelled || g.metadata.projectionError)) {
      failedByView.set(view ?? g.id, { id: g.id, view: g.metadata.cameraViewLabel, error: g.metadata.error ?? g.metadata.projectionError ?? 'cancelled' });
    }
  }
  const failures = [...failedByView.values()];
  return { ready: viewIds.size, expected: expectedViews, attempts: generations.length, failures, complete: !failures.length && viewIds.size === expectedViews };
}

// send is the documented CDP capability of an already-open browser tab.
// Browser cookies stay inside that tab; the runner never reads or exports them.
export async function* workflowSteps(send, options, uploadFiles) {
  const base = new URL(options.url ?? 'http://127.0.0.1:4517/');
  if (!['http:', 'https:'].includes(base.protocol)) throw new Error('Expected HTTP(S) site URL');
  const caseDir = resolve(options.case ?? 'temp/li3dTests/Bicycle');
  const stem = basename(caseDir);
  const model = resolve(caseDir, `${stem}.glb`), reference = resolve(caseDir, `${stem}.png`);
  const modelBytes = await readFile(model), referenceBytes = await readFile(reference);
  const inputTriangles = glbTriangles(modelBytes);
  if (inputTriangles <= 1_500_000) throw new Error('This decimation workflow requires a fixture above 1,500,000 triangles');
  if (!referenceBytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw new Error('Reference must be PNG');
  const out = resolve(options.out ?? `output/li3d-tests/${new Date().toISOString().replace(/[:.]/g, '-')}`);
  await mkdir(out, { recursive: true });
  const report = { schemaVersion: 1, status: 'running', startedAt: new Date().toISOString(),
    fixture: { name: stem, inputTriangles, modelSha256: createHash('sha256').update(modelBytes).digest('hex'), referenceSha256: createHash('sha256').update(referenceBytes).digest('hex') },
    stages: [], limitations: ['Automation stage wall times include polling and tool pauses; they are not business timings.', 'Application Trace is exported separately when --trace is enabled; coverage remains explicit.', 'Resume does not reconstruct missing batches or resubmit failed generations.'] };
  const traceEvents = [];
  const rawSend = send;
  send = async (method, params) => {
    const start = performance.now(); let status = 'ok';
    try { return await rawSend(method, params); }
    catch (error) { status = 'error'; throw error; }
    finally { traceEvents.push({ name: 'automation.command', cat: 'automation', ph: 'X', pid: 1, tid: 2, ts: (performance.timeOrigin + start) * 1000, dur: (performance.now() - start) * 1000, args: { method, status } }); }
  };
  const evaluate = async expression => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };
  const expr = (fn, arg) => `(${fn})(${JSON.stringify(arg)})`;
  const button = text => evaluate(expr(text => {
    const found = [...document.querySelectorAll('button:not([data-task-preview-allowed])')].filter(b => b.textContent.trim() === text || b.getAttribute('aria-label') === text);
    if (found.length !== 1 || found[0].disabled || found[0].getAttribute('aria-disabled') === 'true') throw new Error(`Button unavailable or ambiguous: ${text}`);
    found[0].click();
  }, text));
  const project = () => evaluate(expr(async () => {
    const id = location.pathname.match(/\/project\/([^/]+)/)?.[1];
    if (!id) return null;
    const r = await fetch(`/api/projects/${encodeURIComponent(id)}`, { cache: 'no-store' });
    if (!r.ok) throw new Error(`Project read: ${r.status}`);
    return (await r.json()).project;
  }));
  const wait = async function* (name, check, timeout = 120_000) {
    const end = Date.now() + timeout;
    for (;;) {
      const pollStart = performance.now();
      const value = await check();
      traceEvents.push({ name: 'automation.poll', cat: 'automation', ph: 'X', pid: 1, tid: 3, ts: (performance.timeOrigin + pollStart) * 1000, dur: (performance.now() - pollStart) * 1000 });
      if (value) return value;
      if (Date.now() >= end) throw new Error(`Timeout: ${name}`);
      const idleStart = performance.now();
      yield { waiting: name, outputDirectory: out };
      traceEvents.push({ name: 'automation.idle', cat: 'automation', ph: 'X', pid: 1, tid: 3, ts: (performance.timeOrigin + idleStart) * 1000, dur: (performance.now() - idleStart) * 1000 });
    }
  };
  const save = () => writeFile(resolve(out, 'report.json'), JSON.stringify(report, null, 2));
  const stage = async function* (name, task) {
    const start = performance.now(), record = { name, startedAt: new Date().toISOString(), status: 'running' };
    report.stages.push(record); await save();
    try { const value = yield* task(); record.status = 'passed'; return value; }
    catch (error) { record.status = 'failed'; throw error; }
    finally { record.durationMs = performance.now() - start; record.timingSource = 'automation-wall-including-idle'; traceEvents.push({ name: `automation.stage.${name}`, cat: 'automation', ph: 'X', ts: (performance.timeOrigin + start) * 1000, dur: record.durationMs * 1000, pid: 1, tid: 1, args: { status: record.status } }); await save(); }
  };
  const screenshot = async name => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    await writeFile(resolve(out, `${name}.png`), Buffer.from(r.data, 'base64'));
  };
  const upload = uploadFiles ?? (async ({ selector, files }) => {
    const { root } = await send('DOM.getDocument', { depth: 0 });
    const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector });
    if (!nodeId) throw new Error(`Missing file input: ${selector}`);
    await send('DOM.setFileInputFiles', { nodeId, files });
  });
  try {
    yield* stage('open-project', async function* () {
      const target = options.projectUrl ? new URL(options.projectUrl) : new URL('texture', base);
      if (target.origin !== base.origin) throw new Error('Project URL must have the same origin');
      const currentUrl = await evaluate('location.href');
      const landing = options.trace && options.projectUrl && currentUrl !== target.href ? new URL('texture', base) : target;
      if (currentUrl !== landing.href) await send('Page.navigate', { url: landing.href });
      yield* wait('LI3D page', () => evaluate('document.readyState === "complete" && !!document.querySelector("button")'));
      const auth = await evaluate('(async()=>{const r=await fetch("/api/auth/me");return r.ok && (await r.json()).authenticated})()');
      if (!auth) throw new Error('Sign in to LI3D in this browser first');
      if (options.trace) {
        yield* wait('Pipeline Trace controls', () => evaluate('!!window.__li3dPipelineTrace'));
        const started = await evaluate('window.__li3dPipelineTrace.start()');
        if (!started) throw new Error('Function timing could not start; rebuild with --DEBUG');
        report.limitations.push('Only local browser/Worker timings are recorded; remote service internals are not instrumented.');
      }
      if (landing.href !== target.href) await evaluate(expr(url => { history.pushState({}, '', url); window.dispatchEvent(new PopStateEvent('popstate')); }, target.href));
      if (!options.projectUrl) {
        yield* wait('new project button', () => evaluate('[...document.querySelectorAll("button")].some(b=>b.textContent.trim()==="新建项目")'));
        await button('新建项目');
        yield* wait('project form', () => evaluate(expr(() => !!document.querySelector('input[placeholder="项目名称"]'))));
        const name = `LI3D-E2E-${stem}-${Date.now()}`;
        await evaluate(expr(name => {
          const input = document.querySelector('input[placeholder="项目名称"]');
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, name);
          input.dispatchEvent(new Event('input', { bubbles: true }));
        }, name));
        await button('创建');
      }
      const p = yield* wait('saved project', project);
      if (!/^(LI3D-E2E-|Bicycle-cli-e2e-)/.test(p.name)) throw new Error('Resume is restricted to explicitly named automation projects');
      report.projectId = p.id; report.projectUrl = await evaluate('location.href');
    });
    yield* stage('import-decimate-save', async function* () {
      let p = await project();
      report.reusedModel = !!p.objects.length;
      if (!p.objects.length) {
        await upload({ selector: 'input[type="file"][accept^=".glb"]', button: '导入模型', files: [model] });
        yield* wait('decimation consent', () => evaluate('document.body.innerText.includes("同意减面并继续")'));
        await button('同意减面并继续');
        p = yield* wait('decimated model saved', async () => {
          const text = await evaluate('document.body.innerText');
          if (text.includes('同意修改 UV 并导入')) throw new Error('UV repair requires separate explicit consent; import is waiting in the browser');
          const next = await project(); return next?.objects.length ? next : false;
        }, 300_000);
      }
      if (p.objects.length !== 1 || !p.objects[0].name.includes(`${stem}_200k`)) throw new Error('Expected exactly one decimated fixture model');
      report.objectId = p.objects[0].id;
      // Count the persisted asset, not a label or mocked server response.
      report.outputTriangles = await evaluate(`(async()=>{const p=${JSON.stringify(p.objects[0].sourcePath)};const r=await fetch(p);if(!r.ok)throw new Error('Model asset HTTP '+r.status);return (${glbTriangles.toString()})(new Uint8Array(await r.arrayBuffer()));})()`);
      if (!(report.outputTriangles > 0 && report.outputTriangles <= 202_000 && report.outputTriangles < inputTriangles)) throw new Error('Persisted mesh failed decimation acceptance');
      await screenshot('01-imported');
    });
    yield* stage('import-six-view-reference', async function* () {
      let p = await project();
      report.reusedReference = !!p.references.length;
      if (!p.references.length) {
        await upload({ selector: 'input[type="file"][accept="image/*"]', button: '添加参考图', files: [reference] });
        yield* wait('reference role dialog', () => evaluate('document.body.innerText.includes("传入作为多视图")'));
        await button('传入作为多视图');
        p = yield* wait('reference saved', async () => { const p = await project(); return p.references.length ? p : false; });
      }
      const ref = p.references.find(r => r.referenceRole === 'multi-view' && r.isPrimary && [stem, `${stem}.png`].includes(r.name));
      if (!ref) throw new Error('Expected selected six-view PNG reference');
      report.referenceId = ref.id;
    });
    yield* stage('generate-project-save', async function* () {
      await evaluate(`(()=>{if(document.querySelector('.gen-action-button'))return;const header=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='生成'&&b.title==='Expand panel');header?.click();})()`);
      if (!await evaluate('!!document.querySelector("[role=tablist][aria-label=多视图预设]")')) await button('多视图');
      yield* wait('generation action', () => evaluate('!!document.querySelector(".gen-action-button")'));
      const selected = await evaluate('document.querySelector("[role=tab][aria-selected=true]")?.textContent');
      if (!selected?.includes('预设 1') || !selected.includes('9')) throw new Error('Expected unchanged default preset 1 with 9 views');
      report.expectedViews = 9;
      const p = await project();
      if (p.settings.resolution !== '2K') throw new Error('Expected default 2K; runner does not change resolution');
      if (!p.generations.length) {
        report.submissionAttemptedAt = new Date().toISOString(); await save();
        await button('生成纹理贴图');
      }
      const done = yield* wait('all nine projections saved', async () => {
        const p = await project();
        report.progress = completion(p, report.expectedViews); await save();
        const busy = await evaluate('(()=>{const b=document.querySelector(".gen-action-button");return !b || b.disabled || b.getAttribute("aria-disabled")==="true"})()');
        return !busy && p.generations.length ? p : false;
      }, options.timeoutMs ?? 30 * 60_000);
      report.generationIds = done.generations.filter(g => g.metadata.workflow === 'texture-map').map(g => g.id);
      report.layerIds = done.layers.filter(l => report.generationIds.includes(l.generationId)).map(l => l.id);
      report.revision = done.revision;
      for (const g of done.generations) {
        const start = Date.parse(g.metadata.startedAt), end = Date.parse(g.metadata.completedAt);
        if (Number.isFinite(start) && Number.isFinite(end) && end >= start) traceEvents.push({ name: 'observer.generation.metadata', cat: 'business-metadata-wall', ph: 'X', ts: start * 1000, dur: (end - start) * 1000, pid: 3, tid: 1 });
      }
      if (report.progress.complete) yield* wait('presentation completed', () => evaluate('document.querySelector("[data-texture-onboarding=generate-texture]")?.dataset.onboardingComplete === "true"'));
      await screenshot('02-generated');
    });
    if (!report.progress.complete) {
      report.stages.at(-1).status = 'failed';
      traceEvents.at(-1).args.status = 'failed';
    }
    yield* stage('reload-verify', async function* () {
      if (options.trace) {
        await evaluate('window.__li3dPipelineTrace.stop()');
        const reports = await evaluate('window.__li3dPipelineTrace.reports()');
        await writeFile(resolve(out, 'application-trace-before-reload.json'), JSON.stringify(reports));
      }
      await send('Page.reload');
      yield* wait('editor restored', () => evaluate('!!document.querySelector(".gen-action-button")'));
      if (options.trace) {
        if (await evaluate('window.__li3dPipelineTrace?.recording() === true')) throw new Error('Recording unexpectedly resumed after reload');
        report.limitations.push('Reload cold-start functions are unobserved: local function timing defaults off after navigation.');
      }
      const p = await project();
      const restored = completion(p, report.expectedViews);
      if (restored.ready !== report.progress.ready || restored.attempts !== report.progress.attempts || p.objects[0]?.id !== report.objectId || !p.references.some(r => r.id === report.referenceId) || !report.layerIds.every(id => p.layers.some(l => l.id === id))) throw new Error('Reload lost workflow results');
      report.images = await evaluate(expr(async urls => {
        const images = [];
        for (const url of urls) {
          const response = await fetch(url);
          if (!response.ok) throw new Error(`Result asset HTTP ${response.status}`);
          const bitmap = await createImageBitmap(await response.blob());
          if (!bitmap.width || !bitmap.height) throw new Error('Empty result image');
          images.push({ width: bitmap.width, height: bitmap.height }); bitmap.close();
        }
        return images;
      }, p.layers.filter(l => report.layerIds.includes(l.id)).map(l => l.imageUrl)));
      yield* wait('model visible after reload', () => evaluate(expr(name => document.body.innerText.includes(name), `${stem}_200k.glb`)));
      yield* wait('restored material ready', () => evaluate('document.body.dataset.textureRestoreModelFull === "1" && document.body.dataset.textureRestoreUvReady === "1"'));
      await screenshot('03-reopened');
    });
    if (!report.progress.complete) throw new Error(`Workflow failed: ${report.progress.ready}/${report.expectedViews} views committed; ${report.progress.failures.map(f => `${f.view}: ${f.error}`).join('; ')}`);
    report.status = 'passed';
  } catch (error) {
    report.status = 'failed'; report.error = error.message;
    await screenshot('failure').catch(() => {});
    throw error;
  } finally {
    if (options.trace) {
      const reports = await evaluate('window.__li3dPipelineTrace?.reports() ?? []').catch(() => []);
      await writeFile(resolve(out, 'application-trace-after-reload.json'), JSON.stringify(reports));
      await evaluate('window.__li3dPipelineTrace?.stop()').catch(() => undefined);
    }
    if (report.status === 'running') report.status = 'interrupted';
    report.endedAt = new Date().toISOString();
    await save();
    await writeFile(resolve(out, 'automation-timings.json'), JSON.stringify({ version: 1, unit: 'ms', source: 'automation-observer', events: traceEvents.map(event => ({ name: event.name, startMs: event.ts / 1000, durationMs: event.dur / 1000, status: event.args?.status })) }));
  }
  return { ...report, outputDirectory: out };
}

export async function runWorkflow(send, options, uploadFiles) {
  const steps = workflowSteps(send, options, uploadFiles);
  for (;;) {
    const next = await steps.next();
    if (next.done) return next.value;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
}

// Attach only to a caller-supplied existing tab. Never start an external browser.
export async function connectCdp(endpoint) {
  const url = new URL(endpoint);
  if (!['ws:', 'wss:'].includes(url.protocol)) throw new Error('--cdp must be a page WebSocket debugger URL');
  const socket = new WebSocket(url), pending = new Map(); let id = 0;
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', () => reject(new Error('CDP connection failed')), { once: true }); });
  socket.addEventListener('message', ({ data }) => { const r = JSON.parse(data); const p = pending.get(r.id); if (!p) return; pending.delete(r.id); clearTimeout(p.timer); if (r.error) p.reject(new Error(r.error.message)); else p.resolve(r.result); });
  socket.addEventListener('close', () => { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('CDP disconnected')); } pending.clear(); });
  return { close: () => socket.close(), send: (method, params = {}) => new Promise((resolve, reject) => { const key = ++id; const timer = setTimeout(() => { pending.delete(key); reject(new Error(`CDP timeout: ${method}`)); }, 60_000); pending.set(key, { resolve, reject, timer }); socket.send(JSON.stringify({ id: key, method, params })); }) };
}

if (typeof process !== 'undefined' && process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  let connection;
  try {
    const { values } = parseArgs({ options: { help: { type: 'boolean', short: 'h' }, cdp: { type: 'string' }, url: { type: 'string' }, case: { type: 'string' }, out: { type: 'string' }, 'project-url': { type: 'string' }, trace: { type: 'boolean' } } });
    if (values.help) console.log('node scripts/li3d-workflow.mjs --cdp <existing-page-websocket-url> [--url http://127.0.0.1:4517/] [--case temp/li3dTests/Bicycle] [--out directory] [--project-url explicit-test-project]\nCodex in-app browser: import runWorkflow and pass its documented cdp.send plus filechooser upload callback. No external browser is launched. This runs real paid generation.');
    else {
      if (!values.cdp) throw new Error('Use the Codex in-app browser adapter or supply --cdp for an existing authorized tab');
      connection = await connectCdp(values.cdp);
      console.log(JSON.stringify({ ok: true, data: await runWorkflow(connection.send, { ...values, projectUrl: values['project-url'] }) }));
    }
  } catch (error) { console.error(JSON.stringify({ ok: false, error: { message: error.message } })); process.exitCode = 1; }
  finally { connection?.close(); }
}
