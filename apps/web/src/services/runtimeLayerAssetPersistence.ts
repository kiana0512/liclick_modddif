import type { Project } from '@/types/project';
type LiveLayerAssetSource = {
  flush: () => Promise<void>;
  blob: (url: string) => Promise<Blob> | undefined;
  state: (url: string) => { source: object; revision: number } | undefined;
};
let liveAssets: LiveLayerAssetSource | undefined;
// The renderer registers access to its CPU mirror. The common save client
// must not import Three.js into the login/application shell just to save JSON.
export function registerRuntimeLayerAssetSource(source: LiveLayerAssetSource) {
  liveAssets = source;
}
const isLiveProjectedCanvasUrl = (url: string) => url.startsWith('liclick-live-projected-canvas:');

const fields = ['imageUrl', 'maskUrl', 'localRepaintMaskUrl', 'localRepaintSourceUrl',
  'localRepaintRawSourceUrl', 'depthUrl', 'renderedColorMaskUrl'] as const;
const isRuntimeUrl = (url: unknown): url is string =>
  typeof url === 'string' && (isLiveProjectedCanvasUrl(url) || url.startsWith('blob:'));

/** RUNTIME-LAYER-ASSETS/1: every document writer must freeze pixels before CAS.
 * Never mutate the live editor's URLs or replace missing paint with its raw
 * generation source (which does not contain the authored UV coverage). */
export async function persistRuntimeLayerAssets(
  project: Project,
  upload: (blob: Blob, filename: string) => Promise<string>,
): Promise<Project> {
  const urls = new Map<string, string>();
  for (const layer of project.layers) {
    for (const field of fields) {
      const url = layer[field];
      if (isRuntimeUrl(url) && !urls.has(url)) urls.set(url, `${layer.id}-${field}.png`);
    }
  }
  if (!urls.size) return project;
  const source = liveAssets;
  await source?.flush();
  const revisions = new Map([...urls.keys()].filter(isLiveProjectedCanvasUrl).map((url) =>
    [url, source?.state(url)] as const));
  const blobs = new Map<string, Blob>();
  for (const url of urls.keys()) {
    let blob: Blob | undefined;
    if (isLiveProjectedCanvasUrl(url)) blob = await source?.blob(url);
    else {
      const response = await fetch(url);
      if (!response.ok) throw new Error('图层临时贴图读取失败，工程未保存。');
      blob = await response.blob();
    }
    if (!blob?.size) throw new Error('局部重绘贴图内存已失效，工程未保存；请保留图层以便恢复。');
    blobs.set(url, blob);
  }
  for (const [url, before] of revisions) {
    const after = source?.state(url);
    if (!before || before.source !== after?.source || before.revision !== after?.revision)
      throw new Error('保存期间图层笔画发生变化，请稍后重试。');
  }
  const durable = new Map<string, string>();
  // Bounded sequential uploads; the immutable PNG blobs are already frozen.
  for (const [url, blob] of blobs) {
    const saved = await upload(blob, urls.get(url)!);
    if (!saved || isRuntimeUrl(saved)) throw new Error('图层贴图尚未持久化，工程未保存。');
    durable.set(url, saved);
  }
  return { ...project, layers: project.layers.map((layer) => {
    const next = { ...layer };
    for (const field of fields) {
      const url = layer[field];
      if (url && durable.has(url)) next[field] = durable.get(url)!;
    }
    return next;
  }) };
}
