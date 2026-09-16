import fs from 'node:fs';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const require=createRequire(root+'/package.json');
const {createServer}=require('vite');
const source=execFileSync('git',['show','055650fe:apps/web/src/engine/bake/gpuReadbackStripes.ts'],{cwd:root,encoding:'utf8'}).replace("'@/utils/browserScheduling'","'/src/utils/browserScheduling.ts'");
const candidate=fs.readFileSync(root+'/src/engine/bake/gpuReadbackStripes.ts','utf8').replace("'@/utils/browserScheduling'","'/src/utils/browserScheduling.ts'");
const fixture=String.raw`
import * as THREE from 'three';
import {readRenderTargetPixelsInStripes as oldRead} from '/__old.ts';
import {readRenderTargetPixelsInStripes as nextRead} from '/__next.ts';
const status=document.querySelector('pre');
const gl=new THREE.WebGLRenderer();
const target=new THREE.WebGLRenderTarget(4096,4096,{depthBuffer:false});
const scene=new THREE.Scene(),camera=new THREE.Camera();
const material=new THREE.ShaderMaterial({vertexShader:'void main(){gl_Position=vec4(position.xy,0.,1.);}',fragmentShader:'void main(){vec2 p=floor(gl_FragCoord.xy);gl_FragColor=vec4(mod(p.x,251.)/255.,mod(p.y,241.)/255.,mod(p.x+p.y,239.)/255.,mod(p.x,3.)/2.);}',blending:THREE.NoBlending,depthTest:false,depthWrite:false});
const mesh=new THREE.Mesh(new THREE.PlaneGeometry(2,2),material);mesh.frustumCulled=false;scene.add(mesh);
gl.setRenderTarget(target);gl.render(scene,camera);gl.setRenderTarget(null);
const reference=new Uint8Array(4096*4096*4);
await gl.readRenderTargetPixelsAsync(target,0,0,4096,4096,reference);
const results=[];
for(let i=0;i<12;i++){
 status.textContent='Trial '+(i+1)+'/12';
 const gaps=[];let active=true,previous=performance.now();
 function frame(time){if(!active)return;gaps.push(time-previous);previous=time;requestAnimationFrame(frame);}
 requestAnimationFrame(frame);
 const started=performance.now(),bytes=await (i%2?nextRead:oldRead)(gl,target,4096),elapsed=performance.now()-started;
 await new Promise(r=>requestAnimationFrame(r));active=false;
 let mismatch=0;const a=new Uint32Array(bytes.buffer),b=new Uint32Array(reference.buffer);
 for(let j=0;j<a.length;j++)if(a[j]!==b[j])mismatch++;
 results.push({mode:i%2?'refill-first':'current',elapsed,maxFrame:Math.max(...gaps),mismatch});
 await new Promise(r=>setTimeout(r,30));
}
mesh.geometry.dispose();material.dispose();target.dispose();gl.dispose();gl.forceContextLoss();
status.textContent=JSON.stringify({results},null,2);
`;
const server=await createServer({configFile:false,root,resolve:{alias:{'@':root+'/src'}},server:{host:'127.0.0.1',port:0,hmr:false,watch:{ignored:['**/*']}},plugins:[{name:'qa',resolveId(id){if(['/__old.ts','/__next.ts','/__fixture.js'].includes(id))return id;},load(id){if(id==='/__old.ts')return source;if(id==='/__next.ts')return candidate;if(id==='/__fixture.js')return fixture;},configureServer(server){server.middlewares.use((req,res,next)=>{if(req.url==='/__readback-qa'){res.setHeader('Content-Type','text/html');res.end('<title>LI3D readback comparison</title><pre>Starting</pre><script type="module" src="/__fixture.js"></script>');}else next();});}}]});
await server.listen();console.log(server.resolvedUrls.local[0]+'__readback-qa');

