import type {Layer} from '@/types/layer';
import {compositeRgbaUrlUnderWithWebGpu} from '@/engine/performance/webGpuRgbaComposite';
import {encodeRgbaPngBlob} from '@/utils/encodeRgbaPng';
import {clearPreparedMergePreview, prepareMergePreview} from './preparedMergePreview';

let ready:{key:string;blob:Blob}|undefined;
let pending:{key:string;controller:AbortController}|undefined;
const keyFor=(signature:string,layers:Layer[])=>signature+'|uv-final-v1|'+JSON.stringify(layers);
export function cancelMergeFinalPreparation(clear=false) {
  pending?.controller.abort();pending=undefined;
  clearPreparedMergePreview();
  if(clear) ready=undefined;
}
export function getPreparedMergePng(signature:string,layers:Layer[]) {
  if(new URLSearchParams(window.location.search).get('webGpuUv')==='0') return undefined;
  return ready?.key===keyFor(signature,layers) ? ready.blob : undefined;
}
/** Encode the exact authored result; no project/asset mutation occurs here. */
export async function prepareMergeFinal(signature:string,imageData:ImageData,layers:Layer[]) {
  if(new URLSearchParams(window.location.search).get('webGpuUv')==='0') return;
  const key=keyFor(signature,layers);
  if(ready?.key===key) {
    await prepareMergePreview(ready.blob);
    return;
  }
  if(pending?.key===key) return;
  cancelMergeFinalPreparation();
  const current={key,controller:new AbortController()};pending=current;
  const signal=current.controller.signal;
  const guard=()=>{if(signal.aborted) throw new DOMException('Final UV preparation superseded.','AbortError');};
  const startedAt=performance.now();
  document.body.dataset.uvMergeFinalPreparation='preparing';
  try {
    let rgba=new Uint8ClampedArray(imageData.data);
    for(const layer of layers) {
      guard();
      const result=await compositeRgbaUrlUnderWithWebGpu(rgba,layer.imageUrl,
        imageData.width,imageData.height,layer.opacity,signal);
      rgba=result.data;
    }
    guard();
    // rgba is a private final buffer. Transfer it once; do not copy another
    // full atlas just to send the encoder its own input.
    const blob=await encodeRgbaPngBlob(imageData.width,imageData.height,rgba,{transferOwnership:true});
    guard();ready={key,blob};
    document.body.dataset.uvMergeFinalPreparation='ready';
    document.body.dataset.uvMergeFinalPreparationMs=String(performance.now()-startedAt);
    await prepareMergePreview(blob);
  } finally {if(pending===current) pending=undefined;}
}
