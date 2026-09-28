/** Local function timings, never part of a Project document. */
export const pipelineTraceNames = [
  'function.call',
  'project.create',
  'project.fetch',
  'project.hydrate',
  'model.load',
  'model.read',
  'model.parse',
  'model.normalize',
  'model.inspect',
  'decimate.confirm',
  'decimate.prepare',
  'decimate.request',
  'decimate.download',
  'decimate.qa',
  'uv.confirm',
  'uv.prepare',
  'uv.request',
  'uv.download',
  'uv.qa',
  'reference.read',
  'reference.decode',
  'reference.select',
  'asset.hash',
  'asset.upload.intent',
  'asset.upload.transfer',
  'asset.verify',
  'asset.retry.wait',
  'generation.operation',
  'generation.attempt',
  'generation.submit',
  'generation.poll.request',
  'provider.opaque_wait',
  'result.decode',
  'result.qa',
  'capture.frame',
  'capture.color',
  'capture.normal',
  'capture.mask',
  'capture.depth',
  'projection.prepare',
  'layer.commit',
  'uv.compose',
  'material.present',
  'save.queue',
  'save.execute',
  'save.command',
  'save.serialize',
  'task.queue',
  'task.run',
  'http.request',
  'http.decode',
  'capture.submit',
  'capture.readback',
  'capture.encode',
  'result.publish.wait',
  'generation.batch',
  'generation.view',
  'shader.compile',
  'gpu.fence.wait',
  'save.ack',
  'result.image.load',
  'generation.restore',
  'generation.cancel',
  'material.resident',
  'save.dispatch',
  'save.coalesce.wait',
  'project.restore',
  'model.prepare',
  'model.repair',
  'asset.reuse',
  'save.retry.wait',
  'result.worker',
  'result.worker.queue',
  'result.body.read',
  'result.json.parse',
  'result.blob.encode',
] as const;

export type PipelineTraceName = typeof pipelineTraceNames[number];
export type PipelineTraceStatus = 'ok' | 'error' | 'cancelled' | 'interrupted' | 'skipped';
export type PipelineTraceContext = { traceId: string; operationId: string; spanId: string };
export type TraceAttributes = { functionName?: string; width?: number; height?: number; bytes?: number; triangles?: number; attempt?: number; viewSlot?: number; lane?: 'cpu' | 'gpu' | 'io' | 'worker'; backend?: string; lateAttach?: boolean };
export type PipelineTraceSpan = PipelineTraceContext & {
  name: PipelineTraceName; parentSpanId?: string; links: string[];
  producerId: string; kind: 'sync' | 'async'; startMs: number; endMs: number | null;
  status: PipelineTraceStatus | null; attributes?: Pick<TraceAttributes, 'functionName' | 'attempt' | 'viewSlot' | 'lateAttach'>;
};
export type PipelineTraceReport = {
  schema: 'LI3D-FUNCTION-TIMING'; version: 1; traceId: string; unit: 'ms';
  spans: PipelineTraceSpan[]; dropped: number; completeness: 'complete' | 'partial' | 'truncated';
};

export type WorkerTraceTiming = PipelineTraceContext & {
  producerId: string; receivedMs: number; sentMs: number;
  name?: PipelineTraceName; kind?: 'sync' | 'async'; status?: PipelineTraceStatus;
};
