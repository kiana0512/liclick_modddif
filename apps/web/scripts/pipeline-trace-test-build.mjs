/** Source-level algorithm harnesses run the default build; enabled tracing has its own tests. */
export function pipelineTraceDisabled(source) {
  return source
    .replace(/^import\s+[^;]+?from\s+['"][^'"]*\/tracing\/[^'"]+['"];?\r?\n/gm, '')
    .replaceAll('import.meta.env.VITE_LICLICK_PIPELINE_TRACE_ENABLED', '"false"')
    .replaceAll('import.meta.env.VITE_LICLICK_PIPELINE_TRACE_DETAIL_ENABLED', '"false"');
}
