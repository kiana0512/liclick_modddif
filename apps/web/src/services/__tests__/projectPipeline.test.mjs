import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createEmptyProjectPipeline,
  getEffectivePipelineRevisionStatus,
  getLatestPipelineStageRevision,
  getLatestUsablePipelineStageRevision,
  isPipelineRevisionStale,
  markDownstreamPipelineRevisionsStale,
  publishPipelineRevision,
  resolvePipelineAssetObjectId,
  resolvePipelineBakeTargetObjectId,
} from '../projectPipeline.ts';

function asset(id, kind = 'model') {
  return {
    id,
    kind,
    name: `${id}.fbx`,
    url: `/workspace/${id}.fbx`,
  };
}

test('resolvePipelineAssetObjectId preserves direct identity and supports legacy fallbacks', () => {
  assert.equal(
    resolvePipelineAssetObjectId([{ ...asset('low'), objectId: 'object-direct' }], 'object-bound'),
    'object-direct',
  );
  assert.equal(resolvePipelineAssetObjectId([asset('legacy')], 'object-bound'), 'object-bound');
  assert.equal(
    resolvePipelineAssetObjectId([asset('legacy')], undefined, 'object-selected'),
    'object-selected',
  );
  assert.equal(resolvePipelineAssetObjectId([asset('standalone')], undefined), undefined);
});

test('resolvePipelineBakeTargetObjectId avoids guessing between multiple Bake Sets', () => {
  assert.equal(
    resolvePipelineBakeTargetObjectId(['object-a', 'object-b'], 'object-b', 'object-a'),
    'object-b',
  );
  assert.equal(
    resolvePipelineBakeTargetObjectId(['object-a', 'object-b'], undefined, 'object-a'),
    'object-a',
  );
  assert.equal(resolvePipelineBakeTargetObjectId(['object-only']), 'object-only');
  assert.equal(resolvePipelineBakeTargetObjectId(['object-a', 'object-b']), undefined);
});

function revision({
  id,
  stage,
  parentRevisionId,
  inputAssets = [],
  outputAssets = [asset(`${id}-output`)],
  status = 'ready',
  settings = {},
}) {
  return {
    id,
    stage,
    sourceMode: parentRevisionId ? 'handoff' : 'project',
    ...(parentRevisionId ? { parentRevisionId } : {}),
    inputAssets,
    outputAssets,
    settings,
    status,
    createdAt: `2026-08-06T00:00:0${id.length}.000Z`,
    updatedAt: `2026-08-06T00:00:0${id.length}.000Z`,
    completedAt: `2026-08-06T00:00:0${id.length}.000Z`,
  };
}

test('publishes defensive append-only revisions and returns the latest stage checkpoint', () => {
  const settings = { quality: { preset: 'production' }, channels: ['baseColor'] };
  const first = revision({ id: 'texture-v1', stage: 'texture', settings });
  const initial = createEmptyProjectPipeline();
  const withFirst = publishPipelineRevision(initial, first);
  const second = revision({
    id: 'texture-v2',
    stage: 'texture',
    parentRevisionId: 'texture-v1',
  });
  const withSecond = publishPipelineRevision(withFirst, second);

  settings.quality.preset = 'preview';
  settings.channels.push('normal');

  assert.equal(initial.revisions.length, 0);
  assert.equal(withFirst.revisions.length, 1);
  assert.equal(withSecond.revisions.length, 2);
  assert.equal(getLatestPipelineStageRevision(withSecond, 'texture').id, 'texture-v2');
  assert.deepEqual(withFirst.revisions[0].settings, {
    quality: { preset: 'production' },
    channels: ['baseColor'],
  });
  assert.ok(Object.isFrozen(withFirst.revisions[0]));
  assert.ok(Object.isFrozen(withFirst.revisions[0].settings.quality));
});

test('rejects duplicate revision ids, missing parents, and duplicate asset ids', () => {
  const texture = revision({ id: 'texture-v1', stage: 'texture' });
  const pipeline = publishPipelineRevision(undefined, texture);

  assert.throws(
    () => publishPipelineRevision(pipeline, texture),
    /revision already exists/,
  );
  assert.throws(
    () =>
      publishPipelineRevision(
        pipeline,
        revision({ id: 'uv-v1', stage: 'uv', parentRevisionId: 'missing' }),
      ),
    /parent revision does not exist/,
  );
  assert.throws(
    () =>
      publishPipelineRevision(
        pipeline,
        revision({
          id: 'retopology-v1',
          stage: 'retopology',
          parentRevisionId: 'texture-v1',
          outputAssets: [asset('shared', 'low-model'), asset('shared', 'report')],
        }),
      ),
    /asset ids must be unique/,
  );
});

test('marks downstream revisions stale without rewriting historical revisions', () => {
  let pipeline = publishPipelineRevision(
    undefined,
    revision({ id: 'texture-v1', stage: 'texture' }),
  );
  pipeline = publishPipelineRevision(
    pipeline,
    revision({
      id: 'retopology-v1',
      stage: 'retopology',
      parentRevisionId: 'texture-v1',
    }),
  );
  pipeline = publishPipelineRevision(
    pipeline,
    revision({ id: 'uv-v1', stage: 'uv', parentRevisionId: 'retopology-v1' }),
  );
  pipeline = publishPipelineRevision(
    pipeline,
    revision({ id: 'bake-v1', stage: 'bake', parentRevisionId: 'uv-v1' }),
  );
  const originalRevisions = pipeline.revisions;
  const originalStatuses = pipeline.revisions.map((item) => item.status);

  const stale = markDownstreamPipelineRevisionsStale(pipeline, 'retopology');

  assert.strictEqual(stale.revisions, originalRevisions);
  assert.deepEqual(pipeline.staleRevisionIds, undefined);
  assert.deepEqual(stale.revisions.map((item) => item.status), originalStatuses);
  assert.equal(isPipelineRevisionStale(stale, 'texture-v1'), false);
  assert.equal(isPipelineRevisionStale(stale, 'retopology-v1'), false);
  assert.equal(isPipelineRevisionStale(stale, 'uv-v1'), true);
  assert.equal(isPipelineRevisionStale(stale, 'bake-v1'), true);
  assert.equal(
    getEffectivePipelineRevisionStatus(stale, getLatestPipelineStageRevision(stale, 'uv')),
    'stale',
  );
});

test('publishing a new downstream revision leaves old stale history intact and exposes a fresh latest revision', () => {
  let pipeline = publishPipelineRevision(
    undefined,
    revision({ id: 'texture-v1', stage: 'texture' }),
  );
  pipeline = publishPipelineRevision(
    pipeline,
    revision({ id: 'retopology-v1', stage: 'retopology', parentRevisionId: 'texture-v1' }),
  );
  pipeline = markDownstreamPipelineRevisionsStale(pipeline, 'texture');
  pipeline = publishPipelineRevision(
    pipeline,
    revision({ id: 'texture-v2', stage: 'texture', parentRevisionId: 'texture-v1' }),
  );
  pipeline = publishPipelineRevision(
    pipeline,
    revision({ id: 'retopology-v2', stage: 'retopology', parentRevisionId: 'texture-v2' }),
  );

  assert.equal(isPipelineRevisionStale(pipeline, 'retopology-v1'), true);
  const latest = getLatestPipelineStageRevision(pipeline, 'retopology');
  assert.equal(latest.id, 'retopology-v2');
  assert.equal(getEffectivePipelineRevisionStatus(pipeline, latest), 'ready');
});

test('latest usable revision skips stale and incomplete checkpoints without deleting history', () => {
  let pipeline = publishPipelineRevision(
    undefined,
    revision({ id: 'texture-v1', stage: 'texture' }),
  );
  pipeline = publishPipelineRevision(
    pipeline,
    revision({
      id: 'retopology-v1',
      stage: 'retopology',
      parentRevisionId: 'texture-v1',
    }),
  );
  pipeline = markDownstreamPipelineRevisionsStale(pipeline, 'texture');
  pipeline = publishPipelineRevision(
    pipeline,
    revision({
      id: 'retopology-v2',
      stage: 'retopology',
      parentRevisionId: 'texture-v1',
      status: 'running',
    }),
  );

  assert.equal(pipeline.revisions.length, 3);
  assert.equal(getLatestPipelineStageRevision(pipeline, 'retopology').id, 'retopology-v2');
  assert.equal(getLatestUsablePipelineStageRevision(pipeline, 'retopology'), undefined);

  pipeline = publishPipelineRevision(
    pipeline,
    revision({
      id: 'retopology-v3',
      stage: 'retopology',
      parentRevisionId: 'texture-v1',
    }),
  );

  assert.equal(pipeline.revisions.length, 4);
  assert.equal(getLatestUsablePipelineStageRevision(pipeline, 'retopology').id, 'retopology-v3');
  assert.equal(isPipelineRevisionStale(pipeline, 'retopology-v1'), true);
});
