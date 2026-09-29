import type * as THREE from 'three';
import type {Layer} from '@/types/layer';
import type {BakeProjectedLayerResult,UvBakeResolution} from './uvBakeTypes';
import {useAuthStore} from '@/stores/authStore';
import {getDebugUvBakeStatus} from './uvBakeDebugControls';
import {getMergeUvPostprocessOptions} from '@/engine/layers/mergeUvComposition';
import {waitForBrowserPaint,yieldToBrowserTask} from '@/utils/browserScheduling';
import {waitForViewportInteractionIdle} from '@/engine/viewport/input';
const CACHE='li3d-verified-merge-preparation-v1';
const hash=async(bytes:Uint8Array<ArrayBuffer>)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');
const textBytes=(value:unknown)=>new TextEncoder().encode(JSON.stringify(value));
type PersistentMergeInput={projectId:string;objectId:string;resolution:UvBakeResolution;group:THREE.Group;layers:Layer[];purpose?:string};
export const persistentMergeScope=(input:PersistentMergeInput)=>JSON.stringify([
  input.projectId,input.objectId,input.resolution,input.purpose,
  input.layers.map(({id,contentRevision,opacity,order})=>[id,contentRevision??0,opacity,order]),
]);

async function runBounded(jobs:Array<()=>Promise<void>>,limit:number) {
  let next=0;
  await Promise.all(Array.from({length:Math.min(limit,jobs.length)},async()=>{
    while(next<jobs.length) await jobs[next++]();
  }));
}

/** UV-PERSISTENT-MERGE-KEY/1.1.0. Hash actual geometry and source bytes:
 * runtime UUIDs and blob URLs are not identity. Independent geometry and asset
 * verification queues overlap, but remain bounded and preserve the same key. */
export async function persistentMergeKey(input:PersistentMergeInput) {
  const userId=useAuthStore.getState().user?.id;
  if(!userId || !globalThis.crypto?.subtle || !('caches' in window)) return undefined;
  try {
    input.group.updateMatrixWorld(true);
    const nodes:THREE.Object3D[]=[];input.group.traverse(node=>nodes.push(node));
    const geometry=[];
    const geometryDigests=new WeakMap<ArrayBufferLike,Map<string,{records:unknown[][]}>>();
    const geometryJobs:Array<()=>Promise<void>>=[];
    for(const node of nodes) {
      const mesh=node as THREE.Mesh;
      if(node.userData.liclickPaintOverlay || node.userData.liclickWireframeOverlay || node.userData.liclickLocalRepaintGpuOverlay) continue;
      const record:unknown[]=[node.visible,[...node.matrixWorld.elements]];
      if(mesh.isMesh) {
        if((mesh as THREE.SkinnedMesh).isSkinnedMesh) return undefined;
        for(const name of ['position','normal','uv','index']) {
          const attribute=name==='index' ? mesh.geometry.index : mesh.geometry.getAttribute(name);
          if(!attribute) {record.push(null);continue;}
          const array='data' in attribute ? attribute.data.array : attribute.array;
          let spans=geometryDigests.get(array.buffer);
          if(!spans) {spans=new Map();geometryDigests.set(array.buffer,spans);}
          const span=`${array.byteOffset}:${array.byteLength}`;
          let digest=spans.get(span);
          if(!digest) {
            digest={records:[]};spans.set(span,digest);
            geometryJobs.push(async()=>{
              await waitForViewportInteractionIdle();
              const value=await hash(new Uint8Array(array.buffer,array.byteOffset,array.byteLength).slice());
              for(const target of digest!.records) target[target.length-1]=value;
            });
          }
          const attributeRecord:unknown[]=[name,attribute.itemSize,attribute.normalized,attribute.count,
            'data' in attribute ? [attribute.offset,attribute.data.stride] : null,''];
          digest.records.push(attributeRecord);record.push(attributeRecord);
        }
        record.push(mesh.geometry.drawRange,mesh.geometry.groups);
      }
      geometry.push(record);
    }
    const assets=new Map<string,string>();
    const layers=[...input.layers].sort((a,b)=>b.order-a.order || a.id.localeCompare(b.id)).map(layer=>({...layer}));
    for(const layer of layers) {
      for(const key of ['imageUrl','maskUrl','depthUrl','normalUrl'] as const) {
        const url=layer[key];if(!url) continue;
        if(!/^(https?:|blob:|data:|\/)/.test(url)) return undefined;
        assets.set(url,'');
      }
    }
    // Verify source bytes concurrently, but bound decoded response memory. Run
    // this independently from the bounded geometry queue so network/crypto wait
    // overlaps without creating unbounded copies of large model attributes.
    const urls=[...assets.keys()];let next=0;
    const assetVerification=Promise.all(Array.from({length:Math.min(3,urls.length)},async()=>{
      while(next<urls.length) {
        const url=urls[next++];
        const response=await fetch(url);
        if(!response.ok) throw new Error('Merge source unavailable.');
        await waitForViewportInteractionIdle();
        assets.set(url,await hash(new Uint8Array(await response.arrayBuffer())));
      }
    }));
    await Promise.all([runBounded(geometryJobs,2),assetVerification]);
    for(const layer of layers) {
      for(const key of ['imageUrl','maskUrl','depthUrl','normalUrl'] as const) {
        const url=layer[key];if(url) layer[key]=assets.get(url)!;
      }
    }
    return await hash(textBytes({version:'uv-composition-14/resident-2.2.2/persistent-6',
      purpose:input.purpose,userId,projectId:input.projectId,objectId:input.objectId,resolution:input.resolution,
      geometry,layers,options:getMergeUvPostprocessOptions(input.resolution),debug:getDebugUvBakeStatus()}));
  } catch {return undefined;}
}

const requestFor=(key:string)=>new Request(`${location.origin}/__li3d_internal/merge-preparation/${key}`);
type PersistentReadWorkerResponse=
  | {status:'hit';bytes:ArrayBuffer;pixelOffset:number;metadata:Record<string,unknown>}
  | {status:'miss'}
  | {status:'error';message:string};
async function readPersistentMergeInWorker(key:string,resolution:number):Promise<PersistentReadWorkerResponse|undefined> {
  if(typeof Worker==='undefined') return undefined;
  let worker:Worker;
  try {
    worker=new Worker(new URL('../../workers/payload.worker.ts',import.meta.url),{type:'module'});
  } catch {return undefined;}
  return new Promise(resolve=>{
    const finish=(result:PersistentReadWorkerResponse|undefined)=>{worker.terminate();resolve(result);};
    worker.onmessage=({data}:MessageEvent<PersistentReadWorkerResponse>)=>finish(data);
    worker.onerror=()=>finish(undefined);
    worker.onmessageerror=()=>finish(undefined);
    worker.postMessage({cacheName:CACHE,requestUrl:requestFor(key).url,resolution});
  });
}
export async function readPersistentMerge(key:string|undefined,resolution:number):Promise<BakeProjectedLayerResult|undefined> {
  if(!key) return undefined;
  try {
    const threaded=await readPersistentMergeInWorker(key,resolution);
    if(threaded?.status==='miss') return undefined;
    if(threaded?.status==='hit') {
      const metadata=threaded.metadata as Pick<BakeProjectedLayerResult,'report'|'bakedTexture'>;
      const canvas=document.createElement('canvas');canvas.width=canvas.height=resolution;
      return {...metadata,canvas,imageUrl:'',imageData:new ImageData(
        new Uint8ClampedArray(threaded.bytes,threaded.pixelOffset,resolution*resolution*4),resolution,resolution)};
    }
    const response=await (await caches.open(CACHE)).match(requestFor(key));
    if(!response) return undefined;
    // A verified 4K entry is about 64 MiB. Response.arrayBuffer() materializes
    // it on the main thread in Chromium, so never let a cold disk hit contend
    // with pointer/wheel frames.
    await waitForViewportInteractionIdle();
    const bytes=new Uint8Array(await response.arrayBuffer());
    if(bytes.length<4 || await hash(bytes)!==response.headers.get('x-li3d-sha256')) return undefined;
    const size=new DataView(bytes.buffer).getUint32(0,true);
    if(size>1_000_000 || bytes.length!==4+size+resolution*resolution*4) return undefined;
    const metadata=JSON.parse(new TextDecoder().decode(bytes.subarray(4,4+size)));
    if(metadata.report.width!==resolution || metadata.report.height!==resolution) return undefined;
    const canvas=document.createElement('canvas');canvas.width=canvas.height=resolution;
    return {...metadata,canvas,imageUrl:'',imageData:new ImageData(new Uint8ClampedArray(bytes.buffer,4+size),resolution,resolution)};
  } catch {return undefined;}
}

export async function writePersistentMerge(key:string|undefined,result:BakeProjectedLayerResult) {
  if(!key || !result.imageData) return;
  try {
    const metadata=textBytes({report:result.report,bakedTexture:result.bakedTexture});
    const chunk=1048576;
    const bytes=new Uint8Array(4+metadata.length+result.imageData.data.length);
    new DataView(bytes.buffer).setUint32(0,metadata.length,true);bytes.set(metadata,4);
    // UV-CACHE-WRITE/1.1.0: completed bake pixels are immutable. Keep a private
    // verified snapshot, but bound each main-thread copy and response chunk.
    for(let offset=0;offset<result.imageData.data.length;offset+=chunk) {
      await waitForViewportInteractionIdle();
      bytes.set(result.imageData.data.subarray(offset,offset+chunk),4+metadata.length+offset);
      // scheduler.yield continuations may all run before a paint. Force a real
      // presentation after each bounded 4 MiB batch while retaining cheap task
      // yields between the individual 1 MiB exact copies.
      await ((Math.floor(offset/chunk)&3)===3 ? waitForBrowserPaint() : yieldToBrowserTask());
    }
    await waitForViewportInteractionIdle();
    const digest=await hash(bytes);
    const cache=await caches.open(CACHE);
    let offset=0;
    const body=new ReadableStream<Uint8Array>({pull(controller){
      controller.enqueue(bytes.subarray(offset,offset+chunk));
      offset+=chunk;
      if(offset>=bytes.length) controller.close();
    }});
    await cache.put(requestFor(key),new Response(body,{headers:{'content-type':'application/octet-stream','x-li3d-sha256':digest}}));
    const keys=await cache.keys();
    for(const old of keys.slice(0,Math.max(0,keys.length-2))) await cache.delete(old);
  } catch { /* Optional derived cache: authoritative project assets are unchanged. */ }
}
