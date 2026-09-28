import { getPipelineTrace } from './pipelineTrace';

/** The explicit project entry joins later batches; it is not a global async parent. */
export function beginGenerationEntry(projectId: string | undefined) {
  if (!projectId) return;
  const trace = getPipelineTrace(projectId), scope = trace?.begin('generation.operation');
  if (!trace || !scope) return;
  let finished = false, accepted = false;
  let failure: 'error' | 'cancelled' | undefined;
  return {
    accept() { if (!finished) { accepted = true; trace.bind(`generation-entry:${projectId}`, scope.context); } },
    fail(status: 'error' | 'cancelled') { failure = status; },
    end() {
    if (finished) return; finished = true;
    for (const [key, context] of trace.bindings()) {
      if (context.operationId !== scope.context.operationId) continue;
      if ((key.startsWith('view:') || key.startsWith('batch:')) && !trace.lookup(`started:${key}`)) trace.scopeFor(key)?.end(failure === 'cancelled' ? 'cancelled' : 'skipped');
    }
    if (failure) scope.end(failure);
    if (trace.lookup(`entry-linked:${scope.context.operationId}`)) trace.acknowledge(`entry-finished:${scope.context.operationId}`);
    else scope.end(accepted ? 'skipped' : 'cancelled');
  } };
}

export function planGenerationViews(projectId: string, batchId: string, viewIds: string[]) {
  const trace = getPipelineTrace(projectId);
  if (!trace) return;
  const entry = trace.scopeFor(`generation-entry:${projectId}`);
  const batch = trace.scopeFor(`batch:${batchId}`) ?? trace.begin('generation.batch', entry?.context, 'async', batchId);
  if (!batch) return;
  trace.bind(`batch:${batchId}`, batch.context);
  if (viewIds.length > 128) trace.lose(viewIds.length - 128);
  viewIds.slice(0, 128).forEach((viewId, viewSlot) => {
    const key = `view:${batchId}:${viewId}`;
    if (trace.scopeFor(key)) return;
    const view = trace.begin('generation.view', batch.context, 'async', key, { viewSlot });
    if (view) trace.bind(key, view.context);
  });
}
