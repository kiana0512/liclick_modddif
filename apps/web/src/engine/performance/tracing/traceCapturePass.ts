import { getPipelineTrace } from './pipelineTrace';
/** Measures the CPU-side render call, never GPU execution. */
export function traceCaptureRender(renderer: import('three').WebGLRenderer, scene: import('three').Scene, camera: import('three').Camera, parent?: import('@/engine/performance/tracing/types').PipelineTraceContext, name: import('@/engine/performance/tracing/types').PipelineTraceName = 'capture.submit') {
  const scope = getPipelineTrace()?.begin(name, parent, 'sync');
  try { renderer.render(scene, camera); scope?.end(); } catch (error) { scope?.end('error'); throw error; }
}
