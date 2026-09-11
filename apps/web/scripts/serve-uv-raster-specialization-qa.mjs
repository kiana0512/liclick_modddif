import { createServer } from 'vite';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
const root = path.resolve(import.meta.dirname, '..');
const oldId = root + '/src/engine/bake/__raster-old.ts';
const nextId = root + '/src/engine/bake/__raster-next.ts';
const old = execFileSync('git', ['show', '5b8dcde:apps/web/src/engine/bake/gpuUvBakeRenderer.ts'], {cwd:root,encoding:'utf8'});
const next = fs.readFileSync(root + '/src/engine/bake/gpuUvBakeRenderer.ts', 'utf8');
const reports=[];
const html=`<!doctype html><html><head><meta charset="utf-8"></head><body><pre id="out">UV 权重光栅化：冻结版本逐像素对照</pre><script type="module">
import * as THREE from '/node_modules/three/build/three.module.js';
import {createLayerMaterial as old} from '/@id/virtual:raster-old';
import {createLayerMaterial as next} from '/@id/virtual:raster-next';
const send=async value=>{document.querySelector('#out').textContent+='\\n'+JSON.stringify(value);await fetch('/__report',{method:'POST',body:JSON.stringify(value)});};
const renderer=new THREE.WebGLRenderer({antialias:false});
const errors=[];renderer.debug.onShaderError=(gl,p,v,f)=>errors.push(gl.getProgramInfoLog(p)+' '+gl.getShaderInfoLog(f));
const group=new THREE.Group(), scene=new THREE.Scene(), geometry=new THREE.PlaneGeometry(3,3,20,20);
for(let i=0;i<2;i++){const mesh=new THREE.Mesh(geometry);mesh.position.z=i*.025;group.add(mesh);}scene.add(group);group.updateMatrixWorld(true);
const camera=new THREE.PerspectiveCamera(45,1,.1,100);camera.position.set(.2,.3,5);camera.lookAt(0,0,0);camera.updateMatrixWorld();
const capture={type:'perspective',projection:'perspective',position:camera.position.toArray(),quaternion:camera.quaternion.toArray(),target:[0,0,0],near:.1,far:100,fov:45,zoom:1,projectionMatrix:camera.projectionMatrix.toArray(),matrixWorld:camera.matrixWorld.toArray(),viewMatrix:camera.matrixWorldInverse.toArray(),aspect:1};
const make=(fn)=>{const bytes=new Uint8Array(64*64*4);for(let i=0;i<4096;i++)bytes.set(fn(i),i*4);const t=new THREE.DataTexture(bytes,64,64);t.needsUpdate=true;return t;};
const source=make(i=>[i%256,(i*31)%256,(i*17)%256,[0,1,2,3,5,70,127,255][i%8]]);
const mask=make(i=>[i%256,i%256,i%256,255]);mask.minFilter=mask.magFilter=THREE.LinearFilter;
const normal=make(()=>[128,128,255,255]),depth=make(()=>[254,0,0,0]);
const textures={projectedTexture:source,maskTexture:mask,normalTexture:normal,depthTexture:depth,useMask:false,useNormalCheck:false,useDepthCheck:false};
const bakeCamera=new THREE.OrthographicCamera(-1,1,1,-1,-1,1);
const materials=[];
const draw=async(material,size,repeats=1)=>{const target=new THREE.WebGLRenderTarget(size,size,{depthBuffer:false,stencilBuffer:false,minFilter:THREE.NearestFilter,magFilter:THREE.NearestFilter});target.texture.colorSpace=THREE.NoColorSpace;group.children.forEach(m=>m.material=material);renderer.setRenderTarget(target);renderer.setClearColor(0,0);renderer.clear();const start=performance.now();for(let i=0;i<repeats;i++){renderer.clear();renderer.render(scene,bakeCamera);}const bytes=new Uint8Array(size*size*4);await renderer.readRenderTargetPixelsAsync(target,0,0,size,size,bytes);const ms=performance.now()-start;renderer.setRenderTarget(null);target.dispose();return {bytes,ms};};
try {
let cases=0,nonzero=0;
for(const mode of ['quality-alpha','coverage-alpha','quality-depth'])for(const ignoreSourceAlpha of [false,true])for(const useMask of [false,true])for(const locked of [false,true])for(const useNormalCheck of [false,true]){
textures.useMask=useMask; textures.useNormalCheck=useNormalCheck;
const layer={id:'fixture',type:'projected',name:'fixture',camera:capture,opacity:.63,strength:1.4,ignoreSourceAlpha,projectionVisibilityPolicy:locked?'surface-locked-v1':'standard',adjustments:{hue:17,saturation:-11,lightness:9}};
const input={group,layer,textures,enableBackfaceCulling:true,compositeMode:mode,projectedImageUvFlipY:false,qualityOnly:mode==='quality-alpha'};
const a=old(input),b=next(input);materials.push(a,b);const expected=await draw(a,256),actual=await draw(b,256);let differences=0;for(let i=0;i<actual.bytes.length;i++){if(i%4===3&&actual.bytes[i])nonzero++;if((mode!=='quality-alpha'||i%4===3)&&actual.bytes[i]!==expected.bytes[i])differences++;}if(differences)throw Error('mismatch '+JSON.stringify({mode,ignoreSourceAlpha,useMask,locked,differences}));cases++;
}
await send({cases,nonzero,differences:0,errors});if(!nonzero||errors.length)throw Error('empty/invalid shader');
textures.useMask=false; textures.useNormalCheck=true;
const input={group,layer:{id:'perf',name:'perf',camera:capture,opacity:1,ignoreSourceAlpha:true,projectionVisibilityPolicy:'surface-locked-v1'},textures,enableBackfaceCulling:true,compositeMode:'quality-alpha',projectedImageUvFlipY:false,qualityOnly:true};
const a=old(input),b=next(input);materials.push(a,b);await draw(a,256);await draw(b,256);
for(let trial=0;trial<3;trial++){const expected=await draw(a,4096,10),actual=await draw(b,4096,10);let differences=0;for(let i=3;i<actual.bytes.length;i+=4)if(actual.bytes[i]!==expected.bytes[i])differences++;await send({trial,resolution:4096,draws:10,oldMs:expected.ms,newMs:actual.ms,differences});if(differences)throw Error('4K alpha mismatch');}
await send({done:true});
}catch(error){await send({error:String(error)});}finally{materials.forEach(m=>m.dispose());geometry.dispose();for(const t of [source,mask,normal,depth])t.dispose();renderer.dispose();}
</script></body></html>`;
const server=await createServer({root,logLevel:'error',server:{host:'127.0.0.1',port:0,watch:{ignored:()=>true}},plugins:[{name:'raster-qa',resolveId(id){if(id==='virtual:raster-old')return oldId;if(id==='virtual:raster-next')return nextId;},load(id){if(id===oldId)return old+'\nexport {createLayerMaterial};';if(id===nextId)return next+'\nexport {createLayerMaterial};';},configureServer(s){s.middlewares.use('/__report',async(req,res)=>{let body='';for await(const c of req)body+=c;reports.push(JSON.parse(body));fs.writeFileSync(path.join(os.tmpdir(), 'li3d-raster-specialization-report.json'),JSON.stringify(reports,null,2));console.log(body);res.end('ok');});s.middlewares.use('/__raster_qa',(_req,res)=>{res.setHeader('Content-Type','text/html; charset=utf-8');res.end(html);});}}]});await server.listen();console.log('http://127.0.0.1:'+server.httpServer.address().port+'/__raster_qa');
