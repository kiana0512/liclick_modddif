import React from 'react';
import { createRoot } from 'react-dom/client';
import { invalidate } from '@react-three/fiber';
import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { ViewportCanvas } from '../src/engine/viewport/ViewportCanvas.tsx';
import { useSceneStore } from '../src/stores/sceneStore.ts';
import { useLayerStore } from '../src/stores/layerStore.ts';
import { useProjectStore } from '../src/stores/projectStore.ts';
import { useSettingsStore } from '../src/stores/settingsStore.ts';
import { useEditorHistoryStore } from '../src/stores/editorHistoryStore.ts';
import { useToastStore } from '../src/stores/toastStore.ts';
import { useWorkspaceLayoutStore } from '../src/components/workspace/workspaceLayoutStore.ts';
import { runPaintMaskHistoryAction } from '../src/engine/paint/paintMaskHistoryActions.ts';

const tick = () => new Promise(resolve => requestAnimationFrame(resolve));
const until = async (test) => { const end=performance.now()+60000;while(!test()){if(performance.now()>end)throw Error('Viewport readiness timeout');await tick();} };
export async function setup(car = false) {
  const group = new THREE.Group();
  if (car) {
    const raw=new FBXLoader().parse(await (await fetch('/__selection_car.fbx')).arrayBuffer(),'');
    const box=new THREE.Box3().setFromObject(raw),size=box.getSize(new THREE.Vector3()),center=box.getCenter(new THREE.Vector3());
    raw.scale.multiplyScalar(3/Math.max(size.x,size.y,size.z));
    raw.position.sub(center.multiplyScalar(raw.scale.x));
    raw.traverse(m=>{if(m.isMesh)m.material=new THREE.MeshStandardMaterial({color:'#b8b9bc',roughness:.7,metalness:.1,side:THREE.DoubleSide});});
    group.add(raw);
  } else {
    const geo=new THREE.PlaneGeometry(2,2,16,16).toNonIndexed();
    const uv=geo.attributes.uv;
    for(let i=0;i<uv.count;i++) { const offset=Math.floor(i/3)%2;uv.setXY(i,uv.getX(i)*.45+offset*.5,uv.getY(i)*.45+offset*.5); }
    group.add(new THREE.Mesh(geo,new THREE.MeshStandardMaterial({color:'#989ba5',side:THREE.DoubleSide})));
  }
  group.updateMatrixWorld(true);
  group.traverse(child=>{child.userData.liclickObjectId='selection-editor-test';});
  const box=new THREE.Box3().setFromObject(group), bounds={min:box.min.toArray(),max:box.max.toArray(),center:box.getCenter(new THREE.Vector3()).toArray(),size:box.getSize(new THREE.Vector3()).toArray()};
  const model={objectId:'selection-editor-test',name:'Selection editor test',format:car?'fbx':'glb',group,sourceFileName:car?'car.fbx':'plane.glb',materialSlots:['Base'],uvSets:['UV0'],boundingBox:bounds,originalBoundingBox:bounds,childMeshCount:1,warnings:[],restoreStage:'full'};
  const object={id:model.objectId,name:model.name,type:'mesh',format:model.format,materialSlots:[{id:'Base',name:'Base'}],uvSets:['UV0'],boundingBox:bounds,transform:{position:[0,0,0],rotation:[0,0,0],scale:[1,1,1]},visible:true,selected:true};
  const project={id:'isolated-selection-editor',name:'Local editor selection test',layers:[],bakedTextures:[],captures:[],objects:[object],generations:[],references:[]};
  useProjectStore.setState({projects:[project],currentProjectId:project.id});
  useSettingsStore.setState({resolution:'2K'});useWorkspaceLayoutStore.setState({mode:'texture'});
  useSceneStore.getState().setImportedModel(model,object);useSceneStore.setState({displayMode:'flat',paintTool:'none'});
  useLayerStore.getState().addEmptyLayer();
  document.body.style.cssText='margin:0;background:#0b0c13;color:#eee;font:14px system-ui';
  const header=document.createElement('header');header.style.cssText='height:52px;display:flex;align-items:center;gap:12px;padding:0 20px;box-sizing:border-box;background:#191b26';
  header.textContent='正式编辑器视口 · 投影选区显示 · 本地验收';document.body.append(header);
  const host=document.createElement('div');host.style.cssText='position:absolute;left:0;right:0;top:52px;bottom:0';document.body.append(host);
  createRoot(host).render(React.createElement(ViewportCanvas,{hasImportedModel:true,showCaptureFrame:false,showViewCube:false,onImportModels(){},onImportReferenceImages(){},onOpenImport(){}}));
  await until(()=>useSceneStore.getState().viewport);
  host.firstElementChild.style.cssText='position:absolute;inset:0';
  const runtime=useSceneStore.getState().viewport;
  await until(()=>runtime.gl.domElement.width>400);
  function view(position) {
    runtime.camera.position.fromArray(position);runtime.camera.up.set(0,1,0);
    runtime.camera.lookAt(0,0,0);runtime.camera.updateMatrixWorld();
    runtime.controls.target.set(0,0,0);runtime.controls.update();invalidate();
  }
  const home=car?[2.4,2.25,2.775]:[0,0,4];view(home);
  useSceneStore.getState().setPaintMaskSettings({brushSize:car?50:35});
  useSceneStore.getState().setPaintTool('inpaint-add');
  const samples={frames:[],input:[],up:[],render:[],longTasks:[]};let measuring=false,previous=0;
  new PerformanceObserver(list=>{if(measuring)samples.longTasks.push(...list.getEntries().map(e=>e.duration));}).observe({type:'longtask',buffered:false});
  const loop=t=>{if(measuring&&previous)samples.frames.push(t-previous);previous=t;requestAnimationFrame(loop);};requestAnimationFrame(loop);
  for(const type of ['pointermove','pointerup'])runtime.gl.domElement.addEventListener(type,()=>{if(!measuring)return;const t=performance.now();requestAnimationFrame(()=>samples[type==='pointerup'?'up':'input'].push(performance.now()-t));},true);
  const originalRender=runtime.gl.render.bind(runtime.gl);
  runtime.gl.render=(...args)=>{const t=performance.now();try{return originalRender(...args);}finally{if(measuring)samples.render.push(performance.now()-t);}};
  const overlays=()=>{const found=[];group.traverse(m=>{if(m.userData.liclickAccumulatedInpaintMaskOverlay)found.push(m);});return found;};
  const settle=async()=>{await tick();await tick();};
  const capture=async()=>{
    await settle();const result=await useSceneStore.getState().paintMaskCapture?.({resolution:512});if(!result)return undefined;
    const bitmap=await createImageBitmap(await(await fetch(result)).blob());
    const canvas=document.createElement('canvas');canvas.width=bitmap.width;canvas.height=bitmap.height;
    const ctx=canvas.getContext('2d');ctx.drawImage(bitmap,0,0);bitmap.close();
    const pixels=ctx.getImageData(0,0,canvas.width,canvas.height).data;
    const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',pixels))].map(v=>v.toString(16).padStart(2,'0')).join('');
    return `${canvas.width}x${canvas.height}:${hash}`;
  };
  const state=()=>({content:useSceneStore.getState().paintMaskHasContent,past:useEditorHistoryStore.getState().past.length,future:useEditorHistoryStore.getState().future.length,overlays:overlays().map(m=>({visible:m.visible,count:m.material.uniforms.count?.value,live:m.material.uniforms.liveReady?.value,inverted:m.material.uniforms.inverted?.value})),warnings:useToastStore.getState().toasts.filter(t=>t.tone==='error'||t.tone==='warning').map(t=>t.description)});
  const actions={add:()=>useSceneStore.getState().setPaintTool('inpaint-add'),erase:()=>useSceneStore.getState().setPaintTool('inpaint-subtract'),undo:()=>useEditorHistoryStore.getState().undo(),redo:()=>useEditorHistoryStore.getState().redo(),clear:()=>runPaintMaskHistoryAction('clear'),invert:()=>runPaintMaskHistoryAction('invert'),home:()=>view(home)};
  for(const [key,label]of Object.entries({add:'绘制',erase:'擦除',undo:'撤销',redo:'重做',clear:'清空',invert:'反选',home:'原视角'})){const b=document.createElement('button');b.textContent=label;b.onclick=actions[key];b.style.cssText='color:white;background:#343448;border:1px solid #56576c;border-radius:5px;padding:5px 10px';header.append(b);}
  const extension=runtime.gl.getContext().getExtension('WEBGL_debug_renderer_info');
  window.selectionFixture={...actions,view,settle,state,capture,
    renderer:extension?runtime.gl.getContext().getParameter(extension.UNMASKED_RENDERER_WEBGL):'unknown',
    start(){for(const k in samples)samples[k]=[];measuring=true;previous=0;},
    stop(){measuring=false;return structuredClone(samples);},
    pixels(){runtime.gl.render(runtime.scene,runtime.camera);const c=runtime.gl.domElement,g=runtime.gl.getContext(),p=new Uint8Array(c.width*c.height*4);g.readPixels(0,0,c.width,c.height,g.RGBA,g.UNSIGNED_BYTE,p);return Array.from(p);},
    async uvIndependent(){
      await settle();const saved=[];group.traverse(m=>{if(m.isMesh&&!m.userData.liclickPaintOverlay&&m.geometry.attributes.uv){const a=m.geometry.attributes.uv;saved.push([a,a.array.slice()]);}});
      const r=runtime.gl,target=new THREE.WebGLRenderTarget(r.domElement.width,r.domElement.height);
      const read=()=>{r.setRenderTarget(target);r.render(runtime.scene,runtime.camera);const p=new Uint8Array(target.width*target.height*4);r.readRenderTargetPixels(target,0,0,target.width,target.height,p);return p;};
      const before=read();saved.forEach(([a])=>{a.array.fill(0);a.needsUpdate=true;});const after=read();saved.forEach(([a,values])=>{a.array.set(values);a.needsUpdate=true;});r.setRenderTarget(null);target.dispose();invalidate();return before.every((v,i)=>v===after[i]);
    },
    async selectView(index){view(car?[2.4+.14*index,2.25,2.775-.1*index]:[.03*index,0,4]);await settle();},
  };
  await settle();
  return {triangles:group.children.reduce((n,c)=>{c.traverse(m=>{if(m.isMesh&&!m.userData.liclickPaintOverlay)n+=(m.geometry.index?.count??m.geometry.attributes.position.count)/3;});return n;},0),renderer:window.selectionFixture.renderer};
}
