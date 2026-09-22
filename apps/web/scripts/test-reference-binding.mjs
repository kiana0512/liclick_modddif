/* global structuredClone */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import { latestPairedGenerations, replacePairedReference, referenceGroupId } from '../src/components/panels/referenceGroup.ts';
import { resolveLocalRepaintMaterialReference } from '../src/services/localRepaintMaterialReference.ts';
import { generationMetadataString } from '../src/utils/generationIdentity.ts';

const panel = fs.readFileSync(new URL('../src/components/panels/GeneratePanel.tsx', import.meta.url), 'utf8');
const transpile = source => ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const persistSource = panel.slice(panel.indexOf('  async function persistPairedMultiviewReference('),
  panel.indexOf('  persistPairedMultiviewReferenceRef.current ='));
const recoverySource = panel.slice(panel.indexOf('    const completedReferenceGeneration = latestPairedGenerations'),
  panel.indexOf('    const persistPairedMultiviewReference =', panel.indexOf('    const completedReferenceGeneration =')));
assert.ok(recoverySource.length > 0, 'Exercise the actual recovery gate');
const recover = new Function('latestPairedGenerations', 'generations', 'references', 'currentProject',
  'pairedGenerationPersistenceRef', 'isMultiviewReference', 'generationMetadataString',
  transpile(`${recoverySource}\nreturn completedReferenceGeneration;`));

const source = { id: 'single', referenceGroupId: 'group', name: 'Single', url: '/single.png',
  width: 32, height: 32, isPrimary: true, referenceRole: 'single-view' };
const generation = (id, minute, status = 'succeeded') => ({ id, mode: 'single', prompt: '',
  referenceIds: [source.id], status, resultUrl: status === 'succeeded' ? `/${id}.png` : undefined,
  metadata: { sourceReferenceId: source.id, referenceRole: 'multi-view', projectId: 'project',
    startedAt: `2026-09-14T08:${minute}:00Z` } });
const oldJob = generation('old-job', '00');
const newJob = generation('new-job', '01');
for (const value of ['', ' ', 'source', undefined, null, 42, {}]) {
  assert.equal(generationMetadataString({ ...newJob, metadata: { field: value } }, 'field'),
    typeof value === 'string' ? value : undefined);
}
const oldReference = { ...source, id: 'old-multi', referenceRole: 'multi-view',
  derivedFromReferenceId: source.id, generationId: oldJob.id, isPrimary: false };
const other = { ...oldReference, id: 'other-multi', referenceGroupId: 'other', derivedFromReferenceId: 'other-single' };
let serial = 0;
function harness(jobs = [newJob, oldJob], references = [source, oldReference, other]) {
  const state = { references: structuredClone(references), selectedReferenceIds: [source.id],
    setReferences(values) {
      this.references = values;
      this.selectedReferenceIds = values.filter(r => r.isPrimary).map(r => r.id);
    },
    setSelectedReferences(ids) {
      this.selectedReferenceIds = ids;
      this.references = this.references.map(r => ({ ...r, isPrimary: ids.includes(r.id) }));
    } };
  const project = { currentProjectId: 'project', references: state.references };
  const store = { generations: structuredClone(jobs) };
  const saves = [];
  let upload = async url => `/verified${url}`;
  const dependencies = {
    currentProject: { id: 'project' }, createId: () => `reference-${++serial}`,
    getImageSize: async () => ({ width: 1536, height: 1024 }),
    persistGeneratedImage: async (_, url) => upload(url),
    referenceGroupId, latestPairedGenerations, replacePairedReference,
    useReferenceStore: { getState: () => state }, useProjectStore: { getState: () => project },
    useGenerationStore: { getState: () => store },
    syncGeneration: result => { store.generations = [result, ...store.generations.filter(g => g.id !== result.id)]; },
    setProjectReferences: values => { project.references = values; },
    saveCriticalProjectState: async values => { saves.push(structuredClone({ ...values, generations: store.generations })); },
  };
  const persist = new Function(...Object.keys(dependencies),
    transpile(`${persistSource}\nreturn persistPairedMultiviewReference;`))(...Object.values(dependencies));
  return { state, store, project, saves, persist, setUpload: value => { upload = value; },
    recover: () => recover(latestPairedGenerations, store.generations, state.references,
      { id: project.currentProjectId }, { current: new Set() }, r => r.referenceRole === 'multi-view', generationMetadataString) };
}

// Reproduce replacement after page reload: the removed older history must never be restored.
const app = harness();
const replacement = await app.persist(source, newJob);
assert.notEqual(replacement.id, oldReference.id, 'A new six-view result replaces the older paired reference');
assert.equal(replacement.generationId, newJob.id);
assert.equal(replacement.isPrimary, true);
assert.equal(replacement.derivedFromReferenceId, source.id);
assert.deepEqual(app.state.references.map(r => r.id), [replacement.id, source.id, other.id]);
assert.deepEqual(app.state.selectedReferenceIds, [replacement.id]);
assert.equal(app.project.references.find(r => r.isPrimary).id, replacement.id);
assert.equal(app.saves[0].references.find(r => r.isPrimary).id, replacement.id);
assert.equal(app.saves[0].generations.find(g => g.id === newJob.id).metadata.referenceBindingApplied, true);
assert.equal(app.recover(), undefined, 'Old removed image is superseded, not missing work');
const reloaded = harness(app.saves[0].generations, app.saves[0].references);
assert.equal(reloaded.recover(), undefined, 'Reloaded history cannot restore the first result');
assert.equal(resolveLocalRepaintMaterialReference({ references: reloaded.state.references,
  selectedReferenceIds: [source.id] }).id, source.id);

// Repair projects affected by the old code, even when an old task is first in the history list.
const affected = harness([oldJob, newJob]);
assert.equal(affected.recover().id, newJob.id);
await affected.persist(source, affected.recover());
assert.equal(affected.recover(), undefined);
assert.equal(affected.state.references[0].generationId, newJob.id);

const uploadFailure = harness();
const beforeFailure = structuredClone(uploadFailure.state.references);
uploadFailure.setUpload(async () => { throw new Error('Asset upload failed'); });
await assert.rejects(uploadFailure.persist(source, newJob), /Asset upload failed/);
assert.deepEqual(uploadFailure.state.references, beforeFailure, 'Keep the old pair until the new asset is ready');
assert.equal(uploadFailure.saves.length, 0);

// Removing an applied image is intentional, not a reason to recreate it from old history.
reloaded.state.references = reloaded.state.references.filter(r => r.id !== replacement.id);
assert.equal(reloaded.recover(), undefined);
assert.equal(resolveLocalRepaintMaterialReference({ references: reloaded.state.references,
  selectedReferenceIds: [source.id] }).id, source.id);

for (const status of ['running', 'failed']) {
  const waiting = harness([oldJob, generation('new-job', '01', status)], [source, other]);
  assert.equal(waiting.recover(), undefined, 'New request prevents resurrection of superseded results');
}
const lateOld = { ...oldJob, metadata: { ...oldJob.metadata, completedAt: '2026-09-14T09:00:00Z' } };
assert.equal(latestPairedGenerations([lateOld, newJob], 'project')[0].id, newJob.id);
const foreign = { ...generation('foreign', '02'), metadata: { ...newJob.metadata, projectId: 'foreign' } };
assert.equal(latestPairedGenerations([foreign, newJob], 'project')[0].id, newJob.id);
const legacy = { ...source, referenceGroupId: undefined };
const broken = { ...oldReference, referenceGroupId: 'incorrect-old-group' };
const fixed = replacePairedReference([legacy, broken, other], legacy, oldReference);
assert.equal(fixed.length, 3);
assert.equal(fixed[0].referenceGroupId, legacy.id);
assert.equal(fixed.find(r => r.id === legacy.id).referenceGroupId, legacy.id);

// Publication rechecks live ownership/freshness after slow image persistence.
for (const change of ['newer-task', 'deleted-source', 'switched-project']) {
  const racing = harness([oldJob]);
  let release;
  racing.setUpload(() => new Promise(resolve => { release = resolve; }));
  const pending = racing.persist(source, oldJob);
  await Promise.resolve();
  assert.ok(release);
  if (change === 'newer-task') racing.store.generations.unshift(newJob);
  if (change === 'deleted-source') racing.state.references = [other];
  if (change === 'switched-project') racing.project.currentProjectId = 'another-project';
  const snapshot = structuredClone(racing.state.references);
  release('/verified-old.png');
  await assert.rejects(pending, error => error.name === 'AbortError');
  assert.deepEqual(racing.state.references, snapshot);
  assert.equal(racing.saves.length, 0);
}
console.log('Reference binding passed: latest replacement, durable selection, stale-history repair, reload, deletion, ownership and late-result guards.');

// Lighting edits replace the selected multi-view in place and retain its single-view binding.
const lightingJob = { ...generation('light-job', '03'), referenceIds: [oldReference.id],
  metadata: { ...generation('light-job', '03').metadata, sourceReferenceId: oldReference.id,
    referenceOperation: 'lighting', referenceBindingSourceId: source.id } };
const lit = harness([oldJob, lightingJob]);
assert.equal(lit.recover().id, lightingJob.id);
const litResult = await lit.persist(oldReference, lightingJob);
assert.equal(litResult.id, oldReference.id);
assert.deepEqual(lit.state.selectedReferenceIds, [oldReference.id]);
assert.deepEqual(lit.saves[0].references.filter(r => r.isPrimary).map(r => r.id), [oldReference.id]);
assert.equal(litResult.name, oldReference.name);
assert.equal(litResult.derivedFromReferenceId, source.id);
assert.equal(litResult.generationId, lightingJob.id);
assert.equal(litResult.url, '/verified/light-job.png');
assert.equal(lit.state.references.filter(r => r.id === oldReference.id).length, 1);
assert.equal(resolveLocalRepaintMaterialReference({ references: lit.state.references, selectedReferenceIds: [source.id] }).url, source.url);
const litReload = harness(lit.saves[0].generations, lit.saves[0].references);
assert.equal(litReload.recover(), undefined);
const failedLighting = harness([oldJob, { ...lightingJob, status: 'failed', resultUrl: undefined }]);
assert.equal(failedLighting.recover(), undefined, 'Failed lighting must not resurrect an older generation');
const lightUploadFailure = harness([lightingJob]);
lightUploadFailure.setUpload(async () => { throw Error('upload unavailable'); });
await assert.rejects(lightUploadFailure.persist(oldReference, lightingJob), /upload unavailable/);
assert.equal(lightUploadFailure.state.references.find(r => r.id === oldReference.id).url, oldReference.url);
const standalone = { ...oldReference, id: 'uploaded-multi', referenceGroupId: 'uploaded-multi', derivedFromReferenceId: undefined };
const standaloneJob = { ...lightingJob, metadata: { ...lightingJob.metadata, sourceReferenceId: standalone.id, referenceBindingSourceId: standalone.id } };
const solo = harness([standaloneJob], [standalone, other]);
assert.equal(solo.recover().id, standaloneJob.id);
const soloResult = await solo.persist(standalone, standaloneJob);
assert.equal(soloResult.id, standalone.id);assert.equal(soloResult.derivedFromReferenceId, undefined);
assert.deepEqual(solo.state.selectedReferenceIds, [soloResult.id]);
assert.deepEqual(solo.saves[0].references.filter(r => r.isPrimary).map(r => r.id), [soloResult.id]);
const againJob = { ...standaloneJob, id: 'light-again', metadata: { ...standaloneJob.metadata, startedAt: '2026-09-14T08:04:00Z' } };
solo.store.generations.unshift(againJob);
await solo.persist(soloResult, againJob);
assert.deepEqual(solo.state.selectedReferenceIds, [standalone.id]);
assert.equal(solo.state.references.filter(r => r.id === standalone.id).length, 1);
assert.equal(solo.state.references[0].generationId, againJob.id);
console.log('Lighting references: paired/standalone/repeat, replacement, original binding, durable reload and failure retention passed.');
