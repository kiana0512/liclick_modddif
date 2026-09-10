/* global createImageBitmap, fetch */
import * as THREE from 'three';
import { createProjectedLayerMaterial, createProjectedLayerStackMaterial, createUvOverlayPreviewMaterial } from '../src/engine/projection/ProjectedLayerMaterial.ts';
import { serializeCamera } from '../src/engine/projection/ProjectionCamera.ts';
import { projectionGapMaskFromAlpha } from '../src/engine/projection/projectionCoverageContract.mjs';
import { prepareSingleViewTextureCompletion } from '../src/engine/localRepaint/generationInputWorker.ts';
import { bakeProjectedLayerRastersWithGpu } from '../src/engine/bake/gpuUvBakeRenderer.ts';
import { useLayerStore } from '../src/stores/layerStore.ts';

const check = (value, message) => { if (!value) throw new Error(message); };
const imageUrl = (color, alpha = 1) => {
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 16;
  const ctx = canvas.getContext('2d'); ctx.globalAlpha = alpha; ctx.fillStyle = color; ctx.fillRect(0,0,16,16);
  return canvas.toDataURL();
};
export async function run() {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(128,128); renderer.outputColorSpace = THREE.SRGBColorSpace;
  const errors = [];
  renderer.debug.onShaderError = (gl, program, vs, fs) => errors.push([gl.getProgramInfoLog(program), gl.getShaderInfoLog(vs), gl.getShaderInfoLog(fs)].join('\n'));
  const camera = new THREE.PerspectiveCamera(40,1,0.1,20); camera.position.z = 5; camera.updateMatrixWorld(true);
  const snapshot = serializeCamera(camera,1,new THREE.Vector3());
  const scene = new THREE.Scene();
  const geometry = new THREE.PlaneGeometry(2,2);
  const mesh = new THREE.Mesh(geometry); scene.add(mesh);
  const target = new THREE.WebGLRenderTarget(128,128, { samples: 4 });
  const pixels = new Uint8Array(128*128*4);
  const render = (material, angle = 0, mode = 2) => {
    mesh.material = material; mesh.rotation.y = angle; scene.updateMatrixWorld(true);
    material.uniforms.previewLightingEnabled.value = 0;
    material.uniforms.showEmptyProjectionHatch.value = mode;
    renderer.setRenderTarget(target); renderer.setClearColor(0,0); renderer.clear(); renderer.render(scene,camera);
    renderer.readRenderTargetPixels(target,0,0,128,128,pixels); renderer.setRenderTarget(null);
    check(errors.length === 0, errors.join('\n'));
    return [...pixels.slice((64*128+64)*4,(64*128+64)*4+4)];
  };
  const layer = (id, alpha = 1) => ({ layerId:id, imageUrl:imageUrl('#b57632',alpha), objectId:'test', camera:snapshot,
    opacity:1, visible:true, depthTest:true, minimumProjectionFacing:0.18 });
  const single = await createProjectedLayerMaterial(layer('single'));
  check(single.uniforms.showEmptyProjectionHatch.value === 1, 'visible projection defaults to hatch');
  // Same result/capture through the actual two generation entry policies.
  const parityCapture = { id: 'parity', objectId: 'test', camera: snapshot, maskUrl: imageUrl('#fff') };
  const parityMaterials = [];
  for (const mode of ['single', 'multiview']) {
    const row = useLayerStore.getState().addProjectedLayerFromGeneration({
      id: `parity-${mode}`, mode, resultUrl: imageUrl('#b57632', 0.5), prompt: '',
      metadata: { workflow: 'texture-map', multiview: mode === 'multiview' },
    }, parityCapture, 'test');
    parityMaterials.push(await createProjectedLayerMaterial({ ...row, layerId: row.id, depthTest: true }));
  }
  let parityCases = 0;
  for (const mode of [0, 2]) for (const angle of [0, 0.8, Math.acos(0.21)]) {
    render(parityMaterials[0], angle, mode); const expected = pixels.slice();
    render(parityMaterials[1], angle, mode);
    check(pixels.every((value, index) => value === expected[index]), 'single/multiview must be pixel-identical for the same capture and result');
    parityCases++;
  }
  const front = render(single);
  check(front[3] === 255, 'front must retain full coverage');
  const weak = render(single,Math.acos(0.21));
  check(weak[3] === 0, `grazing transition must be clipped: ${weak}`);
  const weakVisible = render(single,Math.acos(0.21),1);
  check(weakVisible[3] === 255 && Math.max(...weakVisible.slice(0,3)) < 120, `viewport cut must reveal dark hatch: ${weakVisible}`);
  check(Math.min(...weak.slice(0,3)) > 150, 'coverage capture remains clean clay, not hatch');
  let stackCount = 0;
  for (const preferTextureArrays of [false,true]) {
    const material = await createProjectedLayerStackMaterial({ objectId:'test',opacity:1,visible:true,depthTest:true,layers:[layer('a'),layer('b')] }, { renderer,preferTextureArrays });
    check(material.uniforms.showEmptyProjectionHatch.value === 1, 'stack defaults to hatch');
    check(Math.max(...render(material,Math.acos(0.21),1).slice(0,3)) < 120, 'stack cut uses dark hatch');
    check(render(material)[3] === 255, 'stack front');
    check(render(material,Math.acos(0.21))[3] === 0, 'stack grazing clip');
    const partial = await createProjectedLayerStackMaterial({ objectId:'test',opacity:1,visible:true,depthTest:true,layers:[layer('c',0.5),layer('d',0.5)] }, { renderer,preferTextureArrays });
    check(render(partial)[3] === 255, 'combined coverage must not be replaced by maximum layer alpha');
    stackCount++;
  }
  const uv = new THREE.DataTexture(new Uint8Array([100,50,20,255]),1,1); uv.needsUpdate=true;
  const uvOnly = createUvOverlayPreviewMaterial({ displayMode:'material', selected:false, uvOverlayTexture:uv });
  check(render(uvOnly)[3] === 255, 'merged UV remains authoritative');
  const emptyUv = new THREE.DataTexture(new Uint8Array([0,0,0,0]),1,1); emptyUv.needsUpdate=true;
  const emptyUvMaterial = createUvOverlayPreviewMaterial({ displayMode:'material', selected:false, uvOverlayTexture:emptyUv });
  check(emptyUvMaterial.uniforms.showEmptyProjectionHatch.value === 1, 'UV defaults to hatch');
  check(Math.max(...render(emptyUvMaterial,0,1).slice(0,3)) < 120, 'UV gap hatch');
  const uvCapture = render(emptyUvMaterial,0,2);
  check(uvCapture[3] === 0 && Math.min(...uvCapture.slice(0,3)) > 150, 'UV capture clean clay and empty coverage');
  const onUv = await createProjectedLayerMaterial({ ...layer('on-uv'),baseTexture:uv });
  check(render(onUv,Math.acos(0.21))[3] === 255, 'cut projection must retain valid UV underneath');
  // Real Worker and PNG alpha transport: left half black artwork, right half gap.
  const canvas = document.createElement('canvas'); canvas.width=canvas.height=64;
  const ctx=canvas.getContext('2d'); ctx.fillStyle='#000'; ctx.fillRect(0,0,32,64);
  const guide=canvas.toDataURL(); ctx.fillStyle='#bbb';ctx.fillRect(0,0,64,64);const clay=canvas.toDataURL();
  ctx.fillStyle='#fff';ctx.fillRect(0,0,64,64);const mask=canvas.toDataURL();
  const result=await prepareSingleViewTextureCompletion({currentEffectUrl:guide,clayPreviewUrl:clay,objectMaskUrl:mask});
  check(result.hasVisibleTexture && result.uncoveredPixelCount===2048 && result.imageUrl, 'Worker must use alpha, not black RGB');
  const bitmap=await createImageBitmap(await (await fetch(result.imageUrl)).blob()); ctx.clearRect(0,0,64,64);ctx.drawImage(bitmap,0,0);
  const output=ctx.getImageData(0,0,64,64).data;
  check(output[(32*64+16)*4]===0 && output[(32*64+48)*4]===187, 'black artwork preserved, whole gap becomes clay');
  check(output[(32*64+48)*4+3]===255, 'GPT composite is opaque clay, never a hole');
  const gap=projectionGapMaskFromAlpha({width:128,height:128,data:pixels},{width:128,height:128,data:new Uint8Array(128*128).fill(255)});
  check(gap.data.length===128*128, 'coverage dimensions');
  const group=new THREE.Group();group.add(mesh);
  const baked=[];
  for(const angle of [0,Math.acos(0.21)]) {
    mesh.rotation.y=angle;group.updateMatrixWorld(true);
    const output=await bakeProjectedLayerRastersWithGpu({renderer,group,layers:[{...layer('bake'),id:'bake',type:'projected',name:'test'}],resolution:128,enableBackfaceCulling:false,enableDilation:false,dilationPixels:0});
    check(errors.length===0,errors.join('\n'));
    const alpha=output.rasters[0].imageData.data[(64*128+64)*4+3];
    baked.push(alpha);
    check(alpha===(angle===0?255:0),`GPU UV coverage must match viewport cutoff: ${alpha}`);
  }
  renderer.dispose(); target.dispose(); geometry.dispose(); bitmap.close();
  return {single: {front,weak,weakVisible},parityCases,stackCount,workerGapPixels:result.uncoveredPixelCount,baked,shaderErrors:errors};
}
