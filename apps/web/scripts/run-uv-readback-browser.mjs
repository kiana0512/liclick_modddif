import {createRequire} from 'node:module';
import {fileURLToPath,pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
const require=createRequire(import.meta.url);
const {createServer}=require('vite');
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE?pathToFileURL(process.env.PLAYWRIGHT_MODULE).href:'playwright');
const root=fileURLToPath(new URL('..',import.meta.url)).replaceAll('\\','/');
const fixture=String.raw`
import * as THREE from 'three';
import {readRenderTargetPixelsInStripes as pipelined} from '/src/engine/bake/gpuReadbackStripes.ts';
import {yieldToBrowserTask} from '/src/utils/browserScheduling.ts';
const renderer=new THREE.WebGLRenderer();
const target=new THREE.WebGLRenderTarget(4096,4096,{depthBuffer:false,stencilBuffer:false});
target.texture.colorSpace=THREE.NoColorSpace;
const scene=new THREE.Scene(),camera=new THREE.Camera();
const material=new THREE.ShaderMaterial({vertexShader:'void main(){gl_Position=vec4(position.xy,0.,1.);}',
 fragmentShader:'void main(){vec2 p=floor(gl_FragCoord.xy);gl_FragColor=vec4(mod(p.x,251.)/255.,mod(p.y,241.)/255.,mod(p.x+p.y,239.)/255.,mod(p.x,3.)/2.);}',
 blending:THREE.NoBlending,depthTest:false,depthWrite:false});
const mesh=new THREE.Mesh(new THREE.PlaneGeometry(2,2),material);mesh.frustumCulled=false;scene.add(mesh);
renderer.setRenderTarget(target);renderer.render(scene,camera);renderer.setRenderTarget(null);
async function serial(){
 const pixels=new Uint8Array(4096*4096*4);
 for(let y=0;y<4096;y+=512){if(y)await yieldToBrowserTask();
 await renderer.readRenderTargetPixelsAsync(target,0,y,4096,512,pixels.subarray(y*4096*4,(y+512)*4096*4));}
 return pixels;
}
window.run=async()=>{
 const gold=await serial();let mismatch=0;
 const trials=[];
 for(let i=0;i<8;i++){
  const mode=i%2?'pipeline':'serial';const gaps=[];let previous=performance.now(),running=true;
  const frame=t=>{gaps.push(t-previous);previous=t;if(running)requestAnimationFrame(frame);};requestAnimationFrame(frame);
  const start=performance.now();const bytes=await(mode==='serial'?serial():pipelined(renderer,target,4096));
  const ms=performance.now()-start;running=false;
  const a=new Uint32Array(bytes.buffer),b=new Uint32Array(gold.buffer);
  for(let j=0;j<a.length;j++)if(a[j]!==b[j])mismatch++;
  trials.push({mode,ms,maxFrameMs:Math.max(0,...gaps)});
  await new Promise(r=>setTimeout(r,50));
 }
 mesh.geometry.dispose();material.dispose();target.dispose();renderer.dispose();
 return {mismatch,trials};
};`;
const server=await createServer({configFile:false,root,resolve:{alias:{'@':root+'/src'}},
 server:{host:'127.0.0.1',port:0,hmr:false,watch:{ignored:['**/*']}},
 plugins:[{name:'readback-fixture',resolveId(id){if(id==='/__fixture.js')return id;},load(id){if(id==='/__fixture.js')return fixture;},configureServer(server){server.middlewares.use((req,res,next)=>{
 if(req.url==='/__fixture'){res.setHeader('Content-Type','text/html');res.end('<script type="module" src="/__fixture.js"></script>');}
 else next();
 });}}]});
await server.listen();
const browser=await chromium.launch({channel:'msedge',headless:true,args:['--enable-webgl','--ignore-gpu-blocklist']});
try{
 const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(server.resolvedUrls.local[0]+'__fixture');await page.waitForFunction(()=>window.run);
 const result=await page.evaluate(()=>window.run());assert.equal(result.mismatch,0);assert.deepEqual(errors,[]);
 console.log(JSON.stringify(result));
}finally{await browser.close();await server.close();}
