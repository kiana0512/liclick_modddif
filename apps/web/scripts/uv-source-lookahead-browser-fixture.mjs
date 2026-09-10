import * as THREE from 'three';
import { bakeProjectedLayerRastersWithGpu as current } from '../src/engine/bake/gpuUvBakeRenderer.ts';
import { bakeProjectedLayerRastersWithGpu as reference } from 'virtual:uv-source-reference';
import { serializeCamera } from '../src/engine/projection/ProjectionCamera.ts';

export async function run(resolution=512, count=13, retainRasters=false) {
  const renderer=new THREE.WebGLRenderer({antialias:false});
  renderer.setSize(64,64);document.body.append(renderer.domElement);
  const group=new THREE.Group(),geometry=new THREE.PlaneGeometry(2,2,12,12),material=new THREE.MeshBasicMaterial();
  group.add(new THREE.Mesh(geometry,material));group.updateMatrixWorld(true);
  const camera=new THREE.PerspectiveCamera(45,1,0.1,100);camera.position.set(0,0,4);camera.lookAt(0,0,0);
  const snapshot=serializeCamera(camera,1,new THREE.Vector3());
  const canvas=document.createElement('canvas');canvas.width=canvas.height=Math.min(resolution,2048);
  const context=canvas.getContext('2d'),data=new ImageData(canvas.width,canvas.height);
  for(let i=0;i<data.data.length;i+=4) data.data.set([i/4%251,(i/4/canvas.width)%253,71,i%28===0?128:255],i);
  context.putImageData(data,0,0);
  const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
  const allUrls=[],results=[];
  try {
    // Alternate order; each run uses fresh URLs so decoded-source cache hits cannot favor it.
    for(const algorithm of [reference,current,current,reference]) {
      const layers=Array.from({length:count},(_,i)=>{
        const imageUrl=URL.createObjectURL(blob);allUrls.push(imageUrl);
        return {id:String(i),name:String(i),type:'projected',imageUrl,maskUrl:retainRasters?imageUrl:undefined,
          camera:snapshot,visible:true,opacity:1,order:i,blendMode:'normal',strength:1};
      });
      const started=performance.now();
      const result=await algorithm({renderer,group,layers,resolution,enableBackfaceCulling:true,
        enableDilation:false,dilationPixels:0,residentQuality:{preserveAlpha:true,retainRasters}});
      results.push({ms:performance.now()-started,result});
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
    return {resolution,count,retainRasters,referenceMs:[results[0].ms,results[3].ms],currentMs:[results[1].ms,results[2].ms],
      differences:0,coveredPixels:expected.residentQuality.writtenTexels,
      stages:results.slice(1,3).map(({result:r})=>({source:r.sourcePreparationWaitMs,upload:r.textureUploadMs,readback:r.layerReadbackWaitMs}))};
  } finally {for(const url of allUrls)URL.revokeObjectURL(url);geometry.dispose();material.dispose();renderer.dispose();renderer.domElement.remove();}
}
