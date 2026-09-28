import { useGenerationStore } from '@/stores/generationStore';
import { useReferenceStore } from '@/stores/referenceStore';
import { useLayerStore } from '@/stores/layerStore';
import type { Generation } from '@/types/generation';
import type { TraceScope, TraceSession } from './pipelineTrace';

/** Observe the same authoritative transitions for UI, restore and automation; never mutate stores. */
export function observeGenerationPipeline(trace: TraceSession, projectId: string) {
  const attachedAt = Date.now();
  const attempts = new Map<string, { scope: TraceScope; done: boolean; succeeded: boolean; batchId: string; viewId: string }>();
  const batches = new Map<string, TraceScope>();
  const entryByBatch = new Map<string, string>();
  const entries = new Map<string, { scope: TraceScope; pending: Set<string>; failed: boolean }>();
  const views = new Map<string, TraceScope>();
  const viewBatches = new Map<string, string>();
  const historical = new Set(useGenerationStore.getState().generations.filter(g => g.status !== 'running' && g.status !== 'queued' && !trace.scopeFor(g.id)).map(g => g.id));
  for (const generation of useGenerationStore.getState().generations) {
    if (generation.metadata.projectId !== projectId) continue;
    const batchId = String(generation.metadata.textureBatchId ?? generation.id), viewId = `${batchId}:${String(generation.metadata.cameraViewId ?? generation.id)}`;
    const view = trace.scopeFor(`view:${viewId}`), batch = trace.scopeFor(`batch:${batchId}`);
    if (view) { views.set(viewId, view); viewBatches.set(viewId, batchId); }
    if (batch) {
      batches.set(batchId, batch);
      const entry = trace.scopeFor(`generation-entry:${projectId}`);
      if (entry && entry.context.operationId === batch.context.operationId) {
        const id = entry.context.operationId, state = entries.get(id) ?? { scope: entry, pending: new Set<string>(), failed: false };
        state.pending.add(batchId); entries.set(id, state); entryByBatch.set(batchId, id);
      }
    }
  }
  const sync = (generations: Generation[], generating: boolean) => {
    for (const generation of generations) {
      if (generation.metadata.projectId !== projectId || historical.has(generation.id)) continue;
      let attempt = attempts.get(generation.id);
      if (!attempt) {
        if (generation.status !== 'running' && generation.status !== 'queued' && !trace.scopeFor(generation.id)) continue;
        const batchId = String(generation.metadata.textureBatchId ?? generation.id);
        let batch = batches.get(batchId);
        if (!batch) {
          const entry = trace.scopeFor(`generation-entry:${projectId}`);
          batch = trace.scopeFor(`batch:${batchId}`) ?? trace.begin('generation.batch', entry?.context, 'async', batchId);
          if (!batch) continue;
          trace.bind(`batch:${batchId}`, batch.context);
          trace.bind(`started:batch:${batchId}`, batch.context);
          batches.set(batchId, batch);
          if (entry) {
            const id = entry.context.operationId, state = entries.get(id) ?? { scope: entry, pending: new Set<string>(), failed: false };
            state.pending.add(batchId); entries.set(id, state); entryByBatch.set(batchId, id);
            trace.bind(`entry-linked:${id}`, entry.context);
          }
        }
        const viewId = `${batchId}:${String(generation.metadata.cameraViewId ?? generation.id)}`;
        let view = views.get(viewId);
        if (!view) { view = trace.scopeFor(`view:${viewId}`) ?? trace.begin('generation.view', batch.context, 'async', viewId); if (view) { views.set(viewId, view); viewBatches.set(viewId, batchId); trace.bind(`view:${viewId}`, view.context); } }
        if (view) trace.bind(`started:view:${viewId}`, view.context);
        const retry = Number(generation.metadata.silhouetteRetryAttempt ?? 0);
        const scope = trace.scopeFor(generation.id) ?? trace.begin('generation.attempt', view?.context ?? batch.context, 'async', generation.id, { attempt: Number.isSafeInteger(retry) && retry >= 0 ? retry + 1 : 1, lateAttach: !Number.isFinite(Date.parse(String(generation.metadata.startedAt))) || Date.parse(String(generation.metadata.startedAt)) < attachedAt });
        if (!scope) continue;
        attempt = { scope, done: false, succeeded: false, batchId, viewId }; attempts.set(generation.id, attempt);
        trace.bind(generation.id, scope.context);
        const capture = trace.lookup(generation.captureId);
        if (capture) trace.link(scope.context, capture);
        const previous = trace.lookup(typeof generation.metadata.silhouetteRetryOf === 'string' ? generation.metadata.silhouetteRetryOf : undefined);
        if (previous) trace.link(scope.context, previous);
      }
      for (const key of ['clientGenerationId', 'serverJobId', 'taskId', 'modelviewJobId']) {
        const reference = generation.metadata[key];
        if (typeof reference === 'string') trace.bind(reference, attempt.scope.context);
      }
      if (!attempt.done) {
        const failed = generation.status === 'failed' || generation.metadata.projectionError || generation.metadata.returnQaRejected;
        const cancelled = generation.metadata.cancelled === true;
        const checkpoint = generation.metadata.autoProjectExpected
          ? `projection:${generation.id}:${String(generation.metadata.projectedLayerId ?? '')}` : generation.id;
        const succeeded = generation.status === 'succeeded' && Boolean(generation.resultUrl) && trace.isAcknowledged(checkpoint);
        if (failed || cancelled || succeeded) { attempt.done = true; attempt.succeeded = Boolean(succeeded && !failed && !cancelled); attempt.scope.end(cancelled ? 'cancelled' : failed ? 'error' : 'ok'); }
      }
    }
    for (const [viewId, view] of views) if ([...attempts.values()].some(attempt => attempt.viewId === viewId && attempt.succeeded)) { view.end(); views.delete(viewId); }
    for (const [batchId, batch] of batches) {
      const entryId = entryByBatch.get(batchId), entry = entries.get(entryId ?? '');
      const entryFinished = entryId ? trace.isAcknowledged(`entry-finished:${entryId}`) : !generating;
      const batchAttempts = [...attempts.values()].filter(attempt => attempt.batchId === batchId);
      if (!entryFinished || !batchAttempts.every(attempt => attempt.done)) continue;
      let failed = false;
      for (const [viewId, view] of views) {
        if (viewBatches.get(viewId) !== batchId) continue;
        const succeeded = batchAttempts.some(attempt => attempt.viewId === viewId && attempt.succeeded);
        view.end(succeeded ? 'ok' : 'error'); failed ||= !succeeded; views.delete(viewId);
      }
      batch.end(failed ? 'error' : 'ok'); batches.delete(batchId);
      if (entry) { entry.pending.delete(batchId); entry.failed ||= failed; }
    }
    for (const [id, entry] of entries) if (!entry.pending.size && trace.isAcknowledged(`entry-finished:${id}`)) { entry.scope.end(entry.failed ? 'error' : 'ok'); entries.delete(id); }
  };
  const safeSync = (generations: Generation[], generating: boolean) => { try { sync(generations, generating); } catch { /* Diagnostic observers cannot reject a store update. */ } };
  safeSync(useGenerationStore.getState().generations, useGenerationStore.getState().isGenerating);
  const unsubscribeGeneration = useGenerationStore.subscribe((state, previous) => {
    if (state.generations !== previous.generations || state.isGenerating !== previous.isGenerating) safeSync(state.generations, state.isGenerating);
  });
  const unsubscribeAck = trace.onAcknowledged(() => safeSync(useGenerationStore.getState().generations, useGenerationStore.getState().isGenerating));
  const unsubscribeReference = useReferenceStore.subscribe((state, previous) => {
    if (state.selectedReferenceIds.length !== previous.selectedReferenceIds.length || state.selectedReferenceIds.some((id, index) => id !== previous.selectedReferenceIds[index])) trace.begin('reference.select', undefined, 'sync')?.end();
  });
  const unsubscribeLayer = useLayerStore.subscribe((state, previous) => {
    if (state.layers === previous.layers) return;
    const prior = new Set(previous.layers.map(layer => layer.id));
    for (const layer of state.layers) if (!prior.has(layer.id)) {
      const commit = trace.begin('layer.commit', trace.lookup(layer.generationId), 'sync', layer.id);
      if (commit) { trace.bind(layer.id, commit.context); commit.end(); }
    }
  });
  return () => { unsubscribeGeneration(); unsubscribeReference(); unsubscribeLayer(); unsubscribeAck(); };
}
