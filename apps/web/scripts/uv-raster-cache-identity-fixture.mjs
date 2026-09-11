import * as THREE from 'three';
import {bakeProjectedLayerRastersWithGpu as current} from '../src/engine/bake/gpuUvBakeRenderer.ts';
import {bakeProjectedLayerRastersWithGpu as reference} from 'virtual:uv-source-reference';
import {ProjectedUvRasterCache} from '../src/engine/bake/ProjectedUvRasterCache.ts';
import {serializeCamera} from '../src/engine/projection/ProjectionCamera.ts';
export async function run() {
  const canvas=document.createElement('canvas');canvas.width=canvas.height=64;
  const ctx=canvas.getContext('2d');ctx.fillStyle='red';ctx.fillRect(0,0,32,64);ctx.fillStyle='blue';ctx.fillRect(32,0,32,64);
  const imageUrl=canvas.toDataURL(),rows=[];
  for(const algorithm of [reference,current]) {
    const renderer=new THREE.WebGLRenderer(),cache=new ProjectedUvRasterCache();
    const group=new THREE.Group(),geometry=new THREE.PlaneGeometry(2,2),material=new THREE.MeshBasicMaterial();
    group.add(new THREE.Mesh(geometry,material));group.updateMatrixWorld(true);
    const camera=new THREE.PerspectiveCamera(45,1,.1,100);camera.position.z=4;camera.updateMatrixWorld();
    const input={renderer,group,resolution:512,layers:[{id:'paint',name:'paint',type:'projected',imageUrl,
      camera:serializeCamera(camera,1,new THREE.Vector3()),visible:true,opacity:1,order:0,blendMode:'normal',strength:1}],
      enableBackfaceCulling:true,enableDilation:false,dilationPixels:0,rasterCache:cache,
      residentQuality:{preserveAlpha:true,retainRasters:false}};
    try {
      const before=(await algorithm(input)).residentQuality.imageData.data;
      const uv=geometry.getAttribute('uv').clone();
      for(let i=0;i<uv.count;i++)uv.setX(i,1-uv.getX(i));
      geometry.setAttribute('uv',uv); // Same count/version, different authored mapping.
      const edited=(await algorithm(input)).residentQuality.imageData.data;
      cache.dispose();
      const fresh=(await current({...input,rasterCache:undefined})).residentQuality.imageData.data;
      let changed=0,mismatches=0;for(let i=0;i<fresh.length;i++){if(fresh[i]!==before[i])changed++;if(fresh[i]!==edited[i])mismatches++;}
      if(!changed)throw Error('UV edit fixture must change output');
      rows.push({kernel:algorithm===reference?'reference':'current',changed,mismatches});
    }finally{cache.dispose();geometry.dispose();material.dispose();renderer.dispose();}
  }
  if(!rows[0].mismatches||rows[1].mismatches)throw Error('UV replacement cache regression '+JSON.stringify(rows));
  return {geometryCache:rows};
}
