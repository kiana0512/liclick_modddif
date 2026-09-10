import * as THREE from 'three';
import { ResidentQualityComposite } from '../src/engine/bake/residentQualityComposite.ts';
import {createTopK,accumulate,resolveCpu} from 'virtual:resident-cpu-oracle';
import {uploadPreviewTextureInStripes} from '../src/engine/viewport/previewTextureCache.ts';
import {registerPreviewTextureRenderer,residentPreviewTextureCache,loadPreviewTexture,prewarmPreviewTextures,releasePreviewTexture} from '../src/engine/viewport/previewTextureCache.ts';
import {prepareMergePreview,adoptPreparedMergePreview,clearPreparedMergePreview} from '../src/engine/bake/preparedMergePreview.ts';

const check=(value,message)=>{ if(!value) throw new Error(message); };
export async function verifyPreparedHandoff(resolution=4096) {
  window.history.replaceState(null,'','?');
  const renderer=new THREE.WebGLRenderer({antialias:false});document.body.append(renderer.domElement);
  registerPreviewTextureRenderer(renderer);
  const canvas=document.createElement('canvas');canvas.width=canvas.height=resolution;
  const ctx=canvas.getContext('2d');const rgba=new Uint8ClampedArray(resolution*resolution*4);
  for(let i=0;i<rgba.length;i+=4) rgba.set([i/4%251,Math.floor(i/4/resolution)%253,71,255],i);
  ctx.putImageData(new ImageData(rgba,resolution,resolution),0,0);
  const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
  const finalUrl=URL.createObjectURL(blob),referenceUrl=URL.createObjectURL(blob);
  const target=new THREE.WebGLRenderTarget(resolution,resolution),scene=new THREE.Scene();
  const camera=new THREE.OrthographicCamera(-1,1,1,-1,0,2);camera.position.z=1;
  const geometry=new THREE.PlaneGeometry(2,2);let material;
  const draw=async(texture)=>{
    material?.dispose();material=new THREE.MeshBasicMaterial({map:texture,toneMapped:false});
    scene.clear();scene.add(new THREE.Mesh(geometry,material));
    renderer.setRenderTarget(target);renderer.render(scene,camera);
    const output=new Uint8Array(resolution*resolution*4);
    await renderer.readRenderTargetPixelsAsync(target,0,0,resolution,resolution,output);renderer.setRenderTarget(null);return output;
  };
  try {
    const prior=new Set(residentPreviewTextureCache.keys());
    await prepareMergePreview(blob);
    const source=[...residentPreviewTextureCache.entries()].find(([url])=>!prior.has(url));
    check(!!source,'prepared texture missing');
    const start=performance.now();
    check(adoptPreparedMergePreview(blob,finalUrl),'prepared GPU handoff rejected');
    const texture=await loadPreviewTexture(finalUrl);
    await prewarmPreviewTextures([finalUrl]);
    const handoffMs=performance.now()-start;
    check(texture===source[1],'texture was decoded/uploaded again');
    check(!residentPreviewTextureCache.has(source[0]),'temporary alias retained');
    const actual=await draw(texture);
    await prewarmPreviewTextures([referenceUrl]);
    const expected=await draw(await loadPreviewTexture(referenceUrl));
    let differences=0;for(let i=0;i<actual.length;i++) if(actual[i]!==expected[i]) differences++;
    check(differences===0,`handoff pixel differences: ${differences}`);
    return {resolution,handoffMs,differences,sameGpuTexture:true};
  } finally {
    clearPreparedMergePreview();releasePreviewTexture(finalUrl);releasePreviewTexture(referenceUrl);
    URL.revokeObjectURL(finalUrl);URL.revokeObjectURL(referenceUrl);
    registerPreviewTextureRenderer(undefined);material?.dispose();geometry.dispose();target.dispose();renderer.dispose();renderer.domElement.remove();
  }
}
export async function run(resolution=128, layerCount=23) {
  const renderer=new THREE.WebGLRenderer({antialias:false});
  const gl=renderer.getContext();
  const errors=[];
  renderer.debug.onShaderError=(ctx,program,vs,fs)=>errors.push([ctx.getProgramInfoLog(program),ctx.getShaderInfoLog(vs),ctx.getShaderInfoLog(fs)].join('\n'));
  const composite=new ResidentQualityComposite(renderer,resolution);
  const layers=[];
  let seed=7921;
  const random=()=>((seed=(Math.imul(seed,1664525)+1013904223)>>>0)>>>16);
  const start=performance.now();
  try {
    for(let layer=0;layer<layerCount;layer++) {
      const color=new Uint8Array(resolution*resolution*4);
      const straight=new Uint8ClampedArray(color.length);
      const quality=new Uint8Array(color.length);
      const qmap=new Float32Array(resolution*resolution);
      for(let i=0;i<qmap.length;i++) {
        const a=[0,1,5,6,66,70,128,254,255,random()%256][(i+layer)%10];
        const q=(i%3===0 ? 0 : random()%256);
        for(let c=0;c<3;c++) {
          color[i*4+c]=random()%256;
          straight[i*4+c]=a>0 ? Math.min(255,Math.round(color[i*4+c]/(a/255))) : 0;
        }
        color[i*4+3]=straight[i*4+3]=a;
        quality[i*4+3]=q; qmap[i]=q/255;
      }
      const ct=new THREE.DataTexture(color,resolution,resolution);
      const qt=new THREE.DataTexture(quality,resolution,resolution);
      ct.needsUpdate=qt.needsUpdate=true;
      renderer.initTexture(ct); renderer.initTexture(qt);
      composite.push(ct,qt);
      ct.dispose();qt.dispose();
      layers.push({color:straight.buffer,quality:qmap.buffer});
    }
    check(!errors.length,errors.join('\n'));
    let expectedCoverage=0;
    for(const layer of layers) {
      const color=new Uint8Array(layer.color);
      for(let i=3;i<color.length;i+=4) if(color[i]>0) expectedCoverage++;
    }
    check(await composite.countLayerCoverage()===expectedCoverage,'GPU per-layer coverage count differs');
    const top=createTopK(resolution*resolution);
    await accumulate(top,{resolution,layers});
    const results=[];
    for(const preserveAlpha of [false,true]) {
      const {output:gpu,correctedPixels}=await composite.readCorrected(preserveAlpha);
      const cpu=(await resolveCpu(top,preserveAlpha)).output;
      let mismatches=0,alphaMismatches=0,maxDelta=0,first;
      for(let i=0;i<gpu.length;i++) {
        const delta=Math.abs(gpu[i]-cpu[i]);
        if(delta){mismatches++;if(i%4===3)alphaMismatches++;maxDelta=Math.max(maxDelta,delta);first??={offset:i,cpu:cpu[i],gpu:gpu[i]};}
      }
      results.push({preserveAlpha,mismatches,alphaMismatches,maxDelta,ratio:mismatches/gpu.length,correctedPixels,first});
      check(alphaMismatches===0 && maxDelta<=1 && mismatches/gpu.length<=0.00001,
        `Canonical quality gate failed: ${JSON.stringify(results.at(-1))}`);
    }
    check(!errors.length,errors.join('\n'));
    check(gl.getError()===gl.NO_ERROR,'WebGL error');
    return {resolution,layerCount,totalMs:performance.now()-start,results};
  } finally {composite.dispose();renderer.dispose();}
}

export async function benchmark(resolution=4096,layerCount=23) {
  const renderer=new THREE.WebGLRenderer({antialias:false});
  const composite=new ResidentQualityComposite(renderer,resolution);
  const color=new Uint8Array(resolution*resolution*4);
  for(let i=0;i<color.length;i+=4) color.set([127,89,55,255],i);
  const ct=new THREE.DataTexture(color,resolution,resolution);ct.needsUpdate=true;
  renderer.initTexture(ct);
  const output=new Uint8Array(color.length);
  const rounds=[];
  try {
    for(let round=0;round<4;round++) {
      composite.reset();
      const start=performance.now();
      for(let layer=0;layer<layerCount;layer++) composite.push(ct,ct);
      const submitted=performance.now();
      const corrected=await composite.readCorrected(false);
      output.set(corrected.output);
      const completed=performance.now();
      let mismatches=0;
      for(let i=0;i<output.length;i++) if(output[i]!==color[i])mismatches++;
      check(mismatches===0,`constant-color exact result differs at ${mismatches} bytes`);
      rounds.push({round,submissionMs:submitted-start,completedWithReadbackMs:completed-start});
    }
    const gl=renderer.getContext(), debug=gl.getExtension('WEBGL_debug_renderer_info');
    return {kind:'isolated-resident-kernel-not-end-to-end-merge',resolution,layerCount,
      renderer:debug?gl.getParameter(debug.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER),rounds};
  } finally {ct.dispose();composite.dispose();renderer.dispose();}
}

export async function benchmarkUpload(resolution=4096) {
  const renderer=new THREE.WebGLRenderer({antialias:false});
  document.body.append(renderer.domElement);
  const rgba=new Uint8ClampedArray(resolution*resolution*4);
  for(let i=0;i<rgba.length;i+=4) rgba.set([i/4%251,Math.floor(i/4/resolution)%253,71,255],i);
  const bitmap=await window.createImageBitmap(new ImageData(rgba,resolution,resolution));
  const scene=new THREE.Scene(), camera=new THREE.OrthographicCamera(-1,1,1,-1,0,2);
  camera.position.z=1;
  const geometry=new THREE.PlaneGeometry(2,2);
  const target=new THREE.WebGLRenderTarget(resolution,resolution,{depthBuffer:false});
  const results=[];
  let reference;
  const original=window.location.href;
  try {
    for(const enabled of [false,true]) {
      window.history.replaceState(null,'',enabled ? '?' : '?perfLab=1&perfResidentQuality=0');
      const texture=new THREE.Texture(bitmap);texture.flipY=false;texture.generateMipmaps=false;
      texture.minFilter=texture.magFilter=THREE.NearestFilter;
      const material=new THREE.MeshBasicMaterial({map:texture,toneMapped:false});
      try {
        const start=performance.now();
        await uploadPreviewTextureInStripes(renderer,texture);
        const uploadMs=performance.now()-start;
        scene.clear();scene.add(new THREE.Mesh(geometry,material));
        renderer.setRenderTarget(target);renderer.render(scene,camera);
        const output=new Uint8Array(rgba.length);
        await renderer.readRenderTargetPixelsAsync(target,0,0,resolution,resolution,output);
        let differences=0;
        if(reference) {
          for(let i=0;i<output.length;i++) if(output[i]!==reference[i]) differences++;
        } else reference=output;
        check(differences===0,'Batched preview upload changed pixels');
        results.push({enabled,resolution,uploadMs,differences,
          stripes:document.body.dataset.previewTextureStripedUploadCount});
      } finally {material.dispose();texture.dispose();}
    }
    return results;
  } finally {
    window.history.replaceState(null,'',original);bitmap.close();target.dispose();geometry.dispose();
    renderer.domElement.remove();renderer.dispose();
  }
}
