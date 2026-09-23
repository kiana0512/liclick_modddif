import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const read = (file) => readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');
const compile = (source) => ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const policy = {};
new Function('exports', compile(read('services/isServerWorkspace.ts')))(policy);
for (const mode of ['cloud-server', 'local-server']) assert.equal(policy.isServerWorkspace(mode), true);
for (const mode of [undefined, 'none', 'file-system-access', 'download-fallback', 'other'])
  assert.equal(policy.isServerWorkspace(mode), false);

function extract(source, names) {
  const ast = ts.createSourceFile('source.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found = {};
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && names.includes(node.name?.text)) found[node.name.text] = node.getText(ast);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return names.map((name) => { assert.ok(found[name], name); return found[name]; }).join('\n');
}
const panel = read('components/panels/GeneratePanel.tsx');
const names = ['persistGeneratedImage', 'persistCaptureAssets', 'persistReferenceAssets', 'saveCriticalProjectStateNow'];
const declarations = extract(panel, names);
const urlPolicy = {};
new Function('exports', compile(`const workspaceApiBase='http://10.3.2.59:44770'; const isCloudBuild=true;
${extract(read('services/workspaceApiClient.ts'), ['workspacePathAtBase', 'directAssetPathAtBase', 'isWorkspaceAssetUrl'])}`))(urlPolicy);
const ast = ts.createSourceFile('panel.tsx', panel, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let submission;
function findSubmission(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'generationPromise' &&
      ts.isConditionalExpression(node.initializer) && node.initializer.condition.getText(ast) === 'isGptLocalRepaint')
    submission = node.initializer.whenTrue.getText(ast);
  ts.forEachChild(node, findSubmission);
}
findSubmission(ast);
assert.ok(submission, 'Exercise the actual GPT submission branch');
assert.doesNotMatch(declarations, /workspaceMode\s*(?:!==|:)\s*'local-server'/);

function fixture(mode) {
  const project = { id: 'p', workspaceMode: mode, captures: [], references: [], layers: [],
    generations: [], objects: [], updatedAt: '2026-09-15T00:00:00.000Z' };
  const events = [], uploads = [], saved = [];
  let failUpload = false, failSave = false, waitSave;
  const capture = { id: 'capture', width: 2048, height: 2048, camera: { frozen: true },
    colorUrl: 'blob:color', maskUrl: 'blob:mask' };
  const assetUrl = (name) => `http://10.3.2.59:44770/api/projects/p/assets/${name}/content`;
  const upload = async (input) => {
    assert.equal(input.projectId, 'p');
    uploads.push(input); events.push(`upload:${input.filename}`);
    if (failUpload) throw new Error('upload failed');
    return { asset: { url: assetUrl(input.filename) } };
  };
  const scope = {
    ...policy, ...urlPolicy, currentProject: project, isCloudBuild: true,
    useProjectStore: { getState: () => ({ currentProjectId: 'p', projects: [project] }) },
    useSceneStore: { getState: () => ({ objects: project.objects }) },
    useLayerStore: { getState: () => ({ layers: project.layers }) },
    useReferenceStore: { getState: () => ({ references: project.references, setReferences: (r) => { project.references = r; } }) },
    useGenerationStore: { getState: () => ({ generations: project.generations }) },
    updateProjectById: (id, patch) => { assert.equal(id, 'p'); Object.assign(project, patch); },
    generationBelongsToProject: () => true,
    saveBlobAsset: upload, saveDataUrlAsset: upload, saveRemoteUrlAsset: upload,
    isLegacyWorkspaceAssetUrl: () => false, isIntegratedLoopbackWorkspaceAssetUrl: () => false,
    getRegisteredObjectUrlBlob: () => new Blob(['unchanged mask bytes']),
    urlToDataUrl: async (url) => url, urlToBlob: async () => new Blob(['image']),
    updateLatestProject: async (id, merge, attempts) => {
      assert.equal(id, 'p'); assert.equal(attempts, 5);
      events.push('save-start');
      await waitSave?.();
      if (failSave) throw new Error('save failed');
      const snapshot = merge({ ...project, workspaceMode: mode, revision: { id: 'latest' }, unrelated: 'preserved' });
      assert.equal(snapshot.unrelated, 'preserved'); assert.equal(snapshot.workspaceMode, mode);
      saved.push(snapshot); events.push('save-finished');
      return { project: snapshot, slug: 'project' };
    },
    requestAbortController: new globalThis.AbortController(), capture, captureRepaintDepth: async () => ({ depthUrl: 'blob:depth' }),
    depthPreviewPromise: undefined, objectId: 'object', captureAspect: 1, captureCameraSnapshot: capture.camera,
    LOCAL_REPAINT_INPUT_RESOLUTION: 2048,
    normalBackground: 'blue',
    captureLocalRepaintNormal: async (value, camera, signal, background) => {
      assert.equal(camera, capture.camera);
      assert.equal(signal.aborted, false);
      assert.equal(background, 'blue');
      return { ...value, normalUrl: 'blob:normal' };
    },
    pendingGeneration: { id: 'job', metadata: {} },
    syncGeneration: (generation) => { project.generations = [generation]; },
    generationId: 'job', effectivePrompt: 'repair', currentEffectDataUrl: 'data:guide', materialReference: undefined,
    objects: [], textureGptModel: 'gpt', textureGptQuality: 'high', resolution: '2K',
    buildGptLocalRepaintRequest: (request) => request,
    createLiclickApiClient: () => ({ generateTextureSingleView: async () => { events.push('paid-submit'); return { metadata: {} }; } }),
    isCancelledGeneration: () => false, waitForLiclickGeneration: async () => 'completed',
    window: { dispatchEvent: () => events.push('save-event') }, Event: globalThis.Event, DOMException, IMMEDIATE_PROJECT_SAVE_EVENT: 'save',
  };
  const functions = new Function(...Object.keys(scope), compile(`${declarations}\nreturn {${names.join(',')}};`))(...Object.values(scope));
  const run = () => {
    const params = { ...scope, saveCriticalProjectState: functions.saveCriticalProjectStateNow,
      persistedAuthoredMaskUrlPromise: functions.persistGeneratedImage('generations', 'blob:mask', 'authored-mask.png', undefined, 'p') };
    return new Function(...Object.keys(params), compile(`return ${submission};`))(...Object.values(params));
  };
  return { ...functions, run, project, events, uploads, saved, scope, assetUrl,
    failUpload: () => { failUpload = true; }, failSave: () => { failSave = true; }, onSave: (fn) => { waitSave = fn; } };
}

for (const mode of ['cloud-server', 'local-server']) {
  const f = fixture(mode);
  let release, entered;
  const gate = new Promise((resolve) => { release = resolve; });
  const reachedSave = new Promise((resolve) => { entered = resolve; });
  f.onSave(() => { entered(); return gate; });
  const running = f.run();
  await reachedSave;
  assert.ok(!f.events.includes('paid-submit'), 'Payment must wait for project persistence');
  release();
  assert.equal(await running, 'completed');
  assert.ok(f.events.indexOf('save-finished') < f.events.indexOf('paid-submit'));
  assert.equal(f.project.workspaceMode, mode, 'Do not rewrite cloud mode to legacy local mode');
  const savedCapture = f.saved[0].captures[0];
  for (const key of ['colorUrl', 'maskUrl', 'depthUrl', 'normalUrl']) assert.ok(urlPolicy.isWorkspaceAssetUrl(savedCapture[key]), key);
  assert.deepEqual(savedCapture.camera, { frozen: true });
  assert.equal(savedCapture.width, 2048);
  assert.equal(f.saved[0].generations[0].metadata.authoredMaskUrl, f.assetUrl('authored-mask.png'));
  const uploadsBefore = f.uploads.length;
  await f.persistGeneratedImage('generations', f.assetUrl('authored-mask.png'), 'again.png');
  assert.equal(f.uploads.length, uploadsBefore, 'Durable same-origin assets must be reused');
  await f.persistReferenceAssets([{ id: 'reference', url: 'blob:ref' }], 'p');
  assert.ok(urlPolicy.isWorkspaceAssetUrl(f.project.references[0].url));

  for (const failure of ['failUpload', 'failSave']) {
    const failed = fixture(mode); failed[failure]();
    await assert.rejects(failed.run(), /failed/);
    assert.ok(!failed.events.includes('paid-submit'));
  }
  const cancelled = fixture(mode); cancelled.scope.requestAbortController.abort();
  await assert.rejects(cancelled.run(), /终止/);
  assert.ok(!cancelled.events.includes('paid-submit'));
}
for (const mode of [undefined, 'none', 'file-system-access', 'download-fallback']) {
  const f = fixture(mode);
  assert.equal(await f.persistGeneratedImage('generations', 'blob:mask', 'mask.png'), 'blob:mask');
  await f.saveCriticalProjectStateNow({});
  assert.equal(f.uploads.length, 0); assert.equal(f.saved.length, 0);
}
console.log('Cloud/legacy generation persistence, four capture planes, save-before-submit, failure and cancellation passed.');
