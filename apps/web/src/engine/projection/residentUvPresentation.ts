import type { Object3D } from 'three';
import { waitForBrowserPaint } from '@/utils/browserScheduling';
import { getLiveProjectedCanvasState } from './liveProjectedCanvasTextureRegistry';
import { getPipelineTrace, traceAsync, type TraceScope } from '@/engine/performance/tracing/pipelineTrace';

const pending = new WeakMap<Object3D, { objectId: string; error?: unknown; trace?: TraceScope }>();
const managed = new WeakSet<Object3D>();
export type ResidentUvMaskBinding = { layerId: string; url: string; revision?: number };
const masks = new WeakMap<Object3D, ResidentUvMaskBinding[]>();
export function isResidentUvMaskPresented(root: Object3D, layerId: string, url: string) {
  return !pending.has(root) && Boolean(masks.get(root)?.some(binding =>
    binding.layerId === layerId && binding.url === url &&
    binding.revision === getLiveProjectedCanvasState(url)?.revision));
}
export function isResidentUvManaged(root: Object3D) { return managed.has(root); }
export function releaseResidentUvManagement(root: Object3D) {
  if (import.meta.env.VITE_LICLICK_PIPELINE_TRACE_ENABLED === 'true') pending.get(root)?.trace?.end('cancelled');
  managed.delete(root); pending.delete(root); masks.delete(root);
}
export function markResidentUvPending(root: Object3D, objectId: string, error?: unknown) {
  managed.add(root);
  let trace: TraceScope | undefined;
  if (import.meta.env.VITE_LICLICK_PIPELINE_TRACE_ENABLED === 'true') {
    const previous = pending.get(root);
    if (previous && previous.objectId !== objectId) previous.trace?.end('interrupted');
    trace = previous?.objectId === objectId ? previous.trace : undefined;
    trace ??= getPipelineTrace()?.begin('material.resident', undefined, 'async', objectId);
    if (error) { trace?.end('error'); trace = undefined; }
  }
  pending.set(root, { objectId, error });
  if (import.meta.env.VITE_LICLICK_PIPELINE_TRACE_ENABLED === 'true' && trace) pending.get(root)!.trace = trace;
}
export function finishResidentUvPresentation(root: Object3D, bindings?: ResidentUvMaskBinding[]) {
  if (bindings) masks.set(root, bindings);
  if (import.meta.env.VITE_LICLICK_PIPELINE_TRACE_ENABLED === 'true') pending.get(root)?.trace?.end();
  pending.delete(root);
}

/** Generation references must not freeze the previous UV while a new state is pending. */
export const waitForResidentUvPresentation = import.meta.env.VITE_LICLICK_PIPELINE_TRACE_ENABLED === 'true'
  ? (scene: Object3D, objectId: string) => {
    const trace = getPipelineTrace();
    return trace ? traceAsync(trace, 'material.present', () => waitForPresentation(scene, objectId), undefined, objectId) : waitForPresentation(scene, objectId);
  } : waitForPresentation;

async function waitForPresentation(scene: Object3D, objectId: string) {
  await waitForBrowserPaint();
  for (;;) {
    let waiting = false;
    scene.traverse((object) => {
      const state = pending.get(object);
      if (state?.objectId !== objectId) return;
      if (state.error) throw state.error;
      waiting = true;
    });
    if (!waiting) return;
    // Pending projection is an ordered correctness barrier, not a generation
    // failure. The scheduler has a background-tab fallback, so keep driving
    // the resident publication until it completes or publishes its real error.
    await waitForBrowserPaint();
  }
}
