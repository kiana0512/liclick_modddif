import * as THREE from 'three';
import { bakeVisibleProjectedLayersToTexture as bake } from '../src/engine/bake/bakeProjectedLayerToTexture.ts';
import { getMergeUvPostprocessOptions } from '../src/engine/layers/mergeUvComposition.ts';
import { ProjectedUvRasterCache } from '../src/engine/bake/ProjectedUvRasterCache.ts';

export async function verify(model, camera, resolution=2048) {
  const canvas=document.createElement('canvas');canvas.width=canvas.height=128;
  const ctx=canvas.getContext('2d'), bytes=new Uint8ClampedArray(128*128*4);
  for(let i=0;i<bytes.length;i+=4) bytes.set([(i*17)%255,(i*31)%255,(i*73)%255,40+(i*7)%216],i);
  ctx.putImageData(new ImageData(bytes,128,128),0,0);
  const colors=[canvas.toDataURL()];ctx.fillStyle='#327bc2';ctx.fillRect(0,0,128,128);colors.push(canvas.toDataURL());
  const layers=Array.from({length:5},(_,i)=>({id:'region-'+i,objectId:model.objectId,type:'projected',
    imageUrl:colors[i%2],camera,order:i,visible:true,opacity:.43+i*.11,strength:1,blendMode:'normal'}));
  const mask=document.createElement('canvas');mask.width=mask.height=resolution;
  const m=mask.getContext('2d');m.fillStyle='white';m.fillRect(0,0,resolution,resolution);
  const baseInput={objectId:model.objectId,sourceModel:model,resolution,enableBackfaceCulling:true,
    enableDilation:false,dilationPixels:0,...getMergeUvPostprocessOptions(resolution),repairMissingUvSeams:true,
    outputAlpha:'transparent',commitToProject:false,markSourceLayersBaked:false,skipImageEncoding:true,
    skipCanvasUpload:true,retainRawComposite:true,allowWhileInteracting:true};
  const fullCache=new ProjectedUvRasterCache(),tileCache=fullCache;
  const checks=[];
  try {
    for(const mode of ['normal','overlays','overlap','seam']) {
      let extra;
      if(mode==='overlap') {
        extra=new THREE.Mesh(new THREE.PlaneGeometry(1.4,1.4),new THREE.MeshBasicMaterial());
        extra.position.set(.15,.1,.04);model.group.add(extra);
      }
      if(mode==='seam') {
        extra=new THREE.Mesh(new THREE.BoxGeometry(1.2,1.2,.2),new THREE.MeshBasicMaterial());
        extra.position.z=.15;model.group.add(extra);
      }
      const current=layers.map((l,i)=>mode==='overlays'&&i<2?{...l,id:'local-repaint-region-'+i,
        colorInterpretation:'rendered-color',ignoreSourceAlpha:false}:l);
      m.fillStyle='white';m.fillRect(0,0,resolution,resolution);
      current[2]={...current[2],maskUrl:mask.toDataURL(),maskSpace:'uv'};
      let base=await bake({...baseInput,transientLayers:current,rasterCache:fullCache});
      for(const [x,y] of [[0,0],[256,512],[resolution-512,resolution-512]]) {
        const region={x,y,size:512};
        const gradient=m.createRadialGradient(x+250,y+250,15,x+250,y+250,100);
        gradient.addColorStop(0,'black');gradient.addColorStop(1,'white');m.fillStyle=gradient;
        m.fillRect(x+140,y+140,220,220);
        current[2]={...current[2],maskUrl:mask.toDataURL()};
        const candidate=await bake({...baseInput,transientLayers:current,rasterCache:tileCache,
          incrementalUv:{region,base:base.rawComposite}});
        const gold=await bake({...baseInput,transientLayers:current,rasterCache:fullCache});
        let differences=0,max=0;
        for(let i=0;i<gold.imageData.data.length;i++) {
          const d=Math.abs(gold.imageData.data[i]-candidate.imageData.data[i]);
          if(d){differences++;max=Math.max(max,d);}
        }
        if(differences) throw Error(mode+' region '+x+','+y+' differs: '+differences+' max='+max);
        if(candidate.rawComposite.writtenTexels!==gold.rawComposite.writtenTexels) throw Error('Coverage count mismatch');
        if(candidate.renderedColorMask.length!==gold.renderedColorMask.length ||
          candidate.renderedColorMask.some((v,i)=>v!==gold.renderedColorMask[i])) throw Error('Rendered-color mask mismatch');
        checks.push({mode,x,y,differences,regionMs:candidate.report.durationMs,fullMs:gold.report.durationMs});
        base=candidate;
      }
      if(extra){model.group.remove(extra);extra.geometry.dispose();extra.material.dispose();}
    }
    return checks;
  }finally{fullCache.dispose();}
}
