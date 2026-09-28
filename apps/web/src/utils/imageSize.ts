import { getPipelineTrace } from '@/engine/performance/tracing/pipelineTrace';
/** Read image dimensions; unreadable images retain the existing zero-size fallback. */
export function getImageSize(url: string) {
  const trace = import.meta.env.VITE_LICLICK_PIPELINE_TRACE_ENABLED === 'true' ? getPipelineTrace()?.begin('reference.decode') : undefined;
  return new Promise<{ width: number; height: number }>((resolve) => {
    const image = new window.Image();
    image.onload = () => { trace?.end(); resolve({ width: image.naturalWidth, height: image.naturalHeight }); };
    image.onerror = () => { trace?.end('error'); resolve({ width: 0, height: 0 }); };
    image.src = url;
  });
}
