import type {Layer} from '@/types/layer';
import {isNativeUvRepaintLayer} from '@/engine/localRepaint/uvRepaintState';
import {compositeRgbaUrlUnderWithWebGpu} from '@/engine/performance/webGpuRgbaComposite';
import {encodeRgbaPngBlob} from '@/utils/encodeRgbaPng';
import {clearPreparedMergePreview, prepareMergePreview} from './preparedMergePreview';
import {yieldToBrowserTask} from '@/utils/browserScheduling';
import {getLiveProjectedTextureSourceState,flushLiveUvCommits,isLiveProjectedCanvasUrl,getLiveProjectedTextureBlob} from '@/engine/projection/liveProjectedCanvasTextureRegistry';
import {cloneProjectionBakeImageData} from './projectionBakeSignature';

let ready:{key:string;blob:Blob}|undefined;
let pending:{key:string;controller:AbortController;promise:Promise<void>}|undefined;
const keyFor=(signature:string,layers:Layer[])=>signature+'|uv-final-v3|'+JSON.stringify([
  layers,layers.map(layer=>getLiveProjectedTextureSourceState(layer.imageUrl)?.revision),
]);
export function cancelMergeFinalPreparation(clear=false) {
  pending?.controller.abort();pending=undefined;
  clearPreparedMergePreview();
  if(clear) ready=undefined;
}
export function getPreparedMergePng(signature:string,layers:Layer[]) {
  if(new URLSearchParams(window.location.search).get('webGpuUv')==='0') return undefined;
  return ready?.key===keyFor(signature,layers) ? ready.blob : undefined;
}
export async function awaitPreparedMergePng(signature:string,layers:Layer[]) {
  const current=pending;
  if(current?.key===keyFor(signature,layers)) {
    try {await current.promise;} catch {return undefined;}
  }
  return getPreparedMergePng(signature,layers);
}
/** Exact no-op underlays may reuse the projection PNG and its GPU allocation.
 * Compare every RGBA byte, including hidden gutter colors; opacity alone is insufficient.
 */
export async function reuseUnchangedMergePng(signature:string,source:Uint8ClampedArray,output:Uint8ClampedArray) {
  const key=keyFor(signature,[]);
  if((ready?.key!==key && pending?.key!==key) || source.length!==output.length || !source.length) return;
  const aligned=(source.byteOffset|output.byteOffset|source.length)%4===0;
  const a=aligned ? new Uint32Array(source.buffer,source.byteOffset,source.length/4) : source;
  const b=aligned ? new Uint32Array(output.buffer,output.byteOffset,output.length/4) : output;
  for(let first=0;first<a.length;first+=262144) {
    const end=Math.min(a.length,first+262144);
    for(let i=first;i<end;i++) if(a[i]!==b[i]) return;
    if(end<a.length) await yieldToBrowserTask();
  }
  return awaitPreparedMergePng(signature,[]);
}
/** Encode the exact authored result; no project/asset mutation occurs here. */
export async function prepareMergeFinal(signature:string,imageData:ImageData,layers:Layer[]) {
  if(new URLSearchParams(window.location.search).get('webGpuUv')==='0') return;
  const key=keyFor(signature,layers);
  if(pending?.key===key) return pending.promise;
  if(ready?.key===key) {
    await prepareMergePreview(ready.blob);
    return;
  }
  cancelMergeFinalPreparation();
  const current={key,controller:new AbortController(),promise:Promise.resolve()};pending=current;
  const signal=current.controller.signal;
  const guard=()=>{if(signal.aborted || keyFor(signature,layers)!==key) throw new DOMException('Final UV preparation superseded.','AbortError');};
  const startedAt=performance.now();
  document.body.dataset.uvMergeFinalPreparation='preparing';
  current.promise=(async()=>{const snapshots:string[]=[];try {
    await flushLiveUvCommits();
    guard();
    // Preserve the reusable atlas; copy in bounded slices instead of one
    // synchronous 64 MiB copy. Input/rendering gets priority between slices.
    let rgba=(await cloneProjectionBakeImageData(imageData,guard)).data;
    for(const layer of layers) {
      guard();
      let sourceUrl=layer.imageUrl;
      if(isLiveProjectedCanvasUrl(sourceUrl)) {
        const blob=await getLiveProjectedTextureBlob(sourceUrl);
        guard();
        if(!blob) throw new Error('UV 图层像素不可用，未发布合并预热。');
        sourceUrl=URL.createObjectURL(blob);snapshots.push(sourceUrl);
      }
      const result=await compositeRgbaUrlUnderWithWebGpu(rgba,sourceUrl,
        imageData.width,imageData.height,layer.opacity,signal,isNativeUvRepaintLayer(layer));
      rgba=result.data;
    }
    guard();
    // rgba is a private final buffer. Transfer it once; do not copy another
    // full atlas just to send the encoder its own input.
    const blob=await encodeRgbaPngBlob(imageData.width,imageData.height,rgba,{transferOwnership:true});
    guard();
    await prepareMergePreview(blob);
    guard();ready={key,blob};
    document.body.dataset.uvMergeFinalPreparation='ready';
    document.body.dataset.uvMergeFinalPreparationMs=String(performance.now()-startedAt);
  } finally {snapshots.forEach(url=>URL.revokeObjectURL(url));if(pending===current) pending=undefined;}})();
  return current.promise;
}
