/* global requestAnimationFrame, cancelAnimationFrame, CanvasRenderingContext2D, WebGL2RenderingContext, PerformanceObserver */
import * as THREE from 'three';
import { bakeProjectedLayerRastersWithGpu as current } from '../src/engine/bake/gpuUvBakeRenderer.ts';
import { bakeProjectedLayerRastersWithGpu as reference } from 'virtual:uv-source-reference';
import { serializeCamera } from '../src/engine/projection/ProjectionCamera.ts';
import { ProjectedUvRasterCache } from '../src/engine/bake/ProjectedUvRasterCache.ts';

export async function run(resolution=512, count=13, retainRasters=false, fullAlpha=false, mime='image/png', aspect=false, overlap=false) {
  const renderer=new THREE.WebGLRenderer({antialias:false});
  renderer.setSize(64,64);document.body.append(renderer.domElement);
  const group=new THREE.Group(),geometry=new THREE.PlaneGeometry(2,2,12,12),material=new THREE.MeshBasicMaterial();
  group.add(new THREE.Mesh(geometry,material));
  if(overlap)for(let i=1;i<=2;i++){const mesh=new THREE.Mesh(geometry,material);mesh.position.set(i*0.07,0,-i*0.04);group.add(mesh);}
  group.updateMatrixWorld(true);
  const camera=new THREE.PerspectiveCamera(45,1,0.1,100);camera.position.set(0,0,4);camera.lookAt(0,0,0);
  const snapshot=serializeCamera(camera,1,new THREE.Vector3());
  const canvas=document.createElement('canvas');canvas.width=canvas.height=fullAlpha?Math.max(1024,resolution):Math.min(resolution,2048);
  if(mime==='image/jpeg' || aspect){canvas.width=1025;canvas.height=769;}
  const context=canvas.getContext('2d'),data=new ImageData(canvas.width,canvas.height);
  for(let i=0;i<data.data.length;i+=4) data.data.set([i/4%256,(i/4/canvas.width)%253,71,fullAlpha?Math.floor(i/1024)%256:i%28===0?128:255],i);
  context.putImageData(data,0,0);
  const blob=await new Promise(resolve=>canvas.toBlob(resolve,mime));
  const allUrls=[],results=[];
  try {
    // Alternate order; each run uses fresh URLs so decoded-source cache hits cannot favor it.
    for(const algorithm of [reference,current,current,reference]) {
      const layers=Array.from({length:count},(_,i)=>{
        const imageUrl=URL.createObjectURL(blob);allUrls.push(imageUrl);
        return {id:String(i),name:String(i),type:'projected',imageUrl,maskUrl:retainRasters?imageUrl:undefined,
          camera:snapshot,visible:true,opacity:overlap?0.31+i*0.017:1,order:i,blendMode:'normal',strength:1};
      });
      const started=performance.now();
      let lastFrame=started,frameId,maxFrameGapMs=0,frames=0;
      const frame=now=>{maxFrameGapMs=Math.max(maxFrameGapMs,now-lastFrame);lastFrame=now;frames++;frameId=requestAnimationFrame(frame);};
      frameId=requestAnimationFrame(frame);
      const longTasks=[];
      const slowCalls=[],restore=[];
      for(const [owner,key] of [[CanvasRenderingContext2D.prototype,'drawImage'],[CanvasRenderingContext2D.prototype,'getImageData'],
        [window,'createImageBitmap'],[WebGL2RenderingContext.prototype,'readPixels'],[WebGL2RenderingContext.prototype,'texImage2D'],
        [WebGL2RenderingContext.prototype,'texSubImage2D'],[WebGL2RenderingContext.prototype,'bufferData']]) {
        const original=owner[key];
        owner[key]=function(...args){const started=performance.now();try{return original.apply(this,args);}finally{
          const ms=performance.now()-started;if(ms>=20)slowCalls.push({key,ms});}};
        restore.push(()=>{owner[key]=original;});
      }
      const observer=new PerformanceObserver(list=>longTasks.push(...list.getEntries().map(entry=>entry.duration)));
      observer.observe({type:'longtask'});
      try {
        const result=await algorithm({renderer,group,layers,resolution,enableBackfaceCulling:true,
          enableDilation:false,dilationPixels:0,residentQuality:{preserveAlpha:true,retainRasters}});
        longTasks.push(...observer.takeRecords().map(entry=>entry.duration));
        results.push({ms:performance.now()-started,result,interaction:{frames,maxFrameGapMs,
          longTasks:longTasks.length,maxLongTaskMs:Math.max(0,...longTasks),slowCalls}});
      } finally {cancelAnimationFrame(frameId);observer.disconnect();restore.forEach(fn=>fn());}
    }
    const expected=results[0].result;
    if(!expected.residentQuality.writtenTexels)throw Error('fixture must have covered pixels');
    for(const {result} of results.slice(1)) {
      for(const field of ['coveredPixels','processedTriangles']) if(result[field]!==expected[field])throw Error(`Changed ${field}`);
      if(retainRasters)for(let layer=0;layer<count;layer++)for(const field of ['data','coverage','quality']) {
        const a=field==='data'?expected.rasters[layer].imageData.data:expected.rasters[layer][field];
        const b=field==='data'?result.rasters[layer].imageData.data:result.rasters[layer][field];
        for(let i=0;i<a.length;i++)if(a[i]!==b[i])throw Error(`Changed retained ${layer} ${field} at ${i}`);
      }
      for(const field of ['data','coverage']) {
        const a=field==='data'?expected.residentQuality.imageData.data:expected.residentQuality.coverage;
        const b=field==='data'?result.residentQuality.imageData.data:result.residentQuality.coverage;
        for(let i=0;i<a.length;i++)if(a[i]!==b[i])throw Error(`Changed ${field} byte ${i}: ${a[i]} / ${b[i]}`);
      }
    }
    return {resolution,count,retainRasters,fullAlpha,mime,overlap,referenceMs:[results[0].ms,results[3].ms],currentMs:[results[1].ms,results[2].ms],
      differences:0,coveredPixels:expected.residentQuality.writtenTexels,
      interaction:results.map(({interaction})=>interaction),
      stages:results.slice(1,3).map(({result:r})=>({source:r.sourcePreparationWaitMs,upload:r.textureUploadMs,readback:r.layerReadbackWaitMs}))};
  } finally {for(const url of allUrls)URL.revokeObjectURL(url);geometry.dispose();material.dispose();renderer.dispose();renderer.domElement.remove();}
}

// Each run owns and disposes its entire cache; compare every complete output by
// SHA-256 without retaining four sets of 4K snapshots alongside GPU resources.
export async function runCached(resolution=4096,count=6) {
  const records=[],urls=[];
  const canvas=document.createElement('canvas');canvas.width=canvas.height=1024;
  const ctx=canvas.getContext('2d'),pixels=new ImageData(1024,1024);
  for(let i=0;i<pixels.data.length;i+=4)pixels.data.set([i%251,(i>>>9)%239,91,32+(i>>>8)%224],i);
  const blobs=[];
  for(let layer=0;layer<count;layer++) {
    for(let i=0;i<pixels.data.length;i+=4){pixels.data[i]=(i+layer*43)%251;pixels.data[i+2]=(91+layer*31)%256;}
    ctx.putImageData(pixels,0,0);
    blobs.push(await new Promise(resolve=>canvas.toBlob(resolve)));
  }
  const hash=async data=>Array.from(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256',data)),v=>v.toString(16).padStart(2,'0')).join('');
  try {
    for(const algorithm of [reference,current,current,reference]) {
      const renderer=new THREE.WebGLRenderer({antialias:false}),cache=new ProjectedUvRasterCache();
      const geometry=new THREE.PlaneGeometry(2,2,200,200),material=new THREE.MeshBasicMaterial(),group=new THREE.Group();
      group.add(new THREE.Mesh(geometry,material));group.updateMatrixWorld(true);
      const camera=new THREE.PerspectiveCamera(45,1,0.1,100);camera.position.set(0,0,4);camera.lookAt(0,0,0);
      const layers=Array.from({length:count},(_,i)=>{
        const imageUrl=URL.createObjectURL(blobs[i]);urls.push(imageUrl);
        return {id:String(i),name:String(i),type:'projected',imageUrl,camera:serializeCamera(camera,1,new THREE.Vector3()),visible:true,opacity:0.4+i*0.07,order:i,blendMode:'normal',strength:1};
      });
      const states=[];
      try {
        for(const hidden of [-1,count-1,count-2,count-3,-1]) {
          const started=performance.now();
          const result=await algorithm({renderer,group,layers:layers.filter((_,i)=>i!==hidden),resolution,
            enableBackfaceCulling:true,enableDilation:false,dilationPixels:0,rasterCache:cache,
            residentQuality:{preserveAlpha:true,retainRasters:false}});
          const ms=performance.now()-started,base=result.residentQuality;
          states.push({hidden,ms,hits:Number(document.body.dataset.residentUvRasterHits),
            misses:Number(document.body.dataset.residentUvRasterMisses),rgba:await hash(base.imageData.data),
            coverage:await hash(base.coverage),coveredPixels:result.coveredPixels,sourceMs:result.sourcePreparationWaitMs});
        }
        records.push(states);
      }finally{cache.dispose();geometry.dispose();material.dispose();renderer.dispose();}
    }
    if(new Set(records[0].map(state=>state.rgba)).size<3)throw Error('Fixture layer toggles must change visible colors');
    for(const states of records.slice(1))for(let i=0;i<states.length;i++)for(const key of ['rgba','coverage','coveredPixels']) {
      if(states[i][key]!==records[0][i][key])throw Error('Cached state mismatch '+i+' '+key);
    }
    return {cached:true,resolution,count,records,differences:0};
  }finally{urls.forEach(url=>URL.revokeObjectURL(url));}
}
