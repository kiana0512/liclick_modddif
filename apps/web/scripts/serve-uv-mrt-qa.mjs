import { createServer } from 'vite';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const moduleId = path.join(root, 'src/engine/bake/gpuUvBakeRenderer.ts').replaceAll('\\', '/');
const reports = [];
const html = `<!doctype html><html><head><meta charset="utf-8"><link rel="icon" href="data:,"></head><body><pre id="out">UV MRT：双 pass 与单 pass 逐字节对照</pre><script type="module">
import * as THREE from '/node_modules/three/build/three.module.js';
import {createLayerMaterial,createLayerMrtTarget} from '/@id/virtual:uv-mrt';
const out=document.querySelector('#out'),send=async value=>{out.textContent+='\\n'+JSON.stringify(value);await fetch('/__report',{method:'POST',body:JSON.stringify(value)});};
const renderer=new THREE.WebGLRenderer({antialias:false});
const gl=renderer.getContext();
const errors=[];renderer.debug.onShaderError=(context,program,vertex,fragment)=>errors.push(context.getProgramInfoLog(program)+' '+context.getShaderInfoLog(fragment));
const group=new THREE.Group(),scene=new THREE.Scene(),geometry=new THREE.PlaneGeometry(3,3,20,20);
for(let i=0;i<2;i++){const mesh=new THREE.Mesh(geometry);mesh.position.z=i*.025;group.add(mesh);}scene.add(group);group.updateMatrixWorld(true);
const camera=new THREE.PerspectiveCamera(45,1,.1,100);camera.position.set(.2,.3,5);camera.lookAt(0,0,0);camera.updateMatrixWorld();
const capture={type:'perspective',projection:'perspective',position:camera.position.toArray(),quaternion:camera.quaternion.toArray(),target:[0,0,0],near:.1,far:100,fov:45,zoom:1,projectionMatrix:camera.projectionMatrix.toArray(),matrixWorld:camera.matrixWorld.toArray(),viewMatrix:camera.matrixWorldInverse.toArray(),aspect:1};
const make=fn=>{const bytes=new Uint8Array(64*64*4);for(let i=0;i<4096;i++)bytes.set(fn(i),i*4);const texture=new THREE.DataTexture(bytes,64,64);texture.needsUpdate=true;return texture;};
const source=make(i=>[i%256,(i*31)%256,(i*17)%256,[0,1,2,3,5,70,127,255][i%8]]),mask=make(i=>[i%256,i%256,i%256,255]),normal=make(()=>[128,128,255,255]),depth=make(()=>[254,0,0,0]);
mask.minFilter=mask.magFilter=THREE.LinearFilter;
const textures={projectedTexture:source,maskTexture:mask,normalTexture:normal,depthTexture:depth,useMask:false,useNormalCheck:false,useDepthCheck:false};
const bakeCamera=new THREE.OrthographicCamera(-1,1,1,-1,-1,1),materials=[],targets=[];
const target=(size,format=THREE.RGBAFormat)=>{const value=new THREE.WebGLRenderTarget(size,size,{format,depthBuffer:false,stencilBuffer:false,minFilter:THREE.NearestFilter,magFilter:THREE.NearestFilter});targets.push(value);return value;};
const draw=(material,renderTarget)=>{group.children.forEach(mesh=>mesh.material=material);renderer.setRenderTarget(renderTarget);renderer.setClearColor(0,0);renderer.clear();renderer.render(scene,bakeCamera);};
const read=(renderTarget,index,format,length)=>{renderer.setRenderTarget(renderTarget);gl.readBuffer(gl.COLOR_ATTACHMENT0+index);const bytes=new Uint8Array(length);gl.readPixels(0,0,renderTarget.width,renderTarget.height,format,gl.UNSIGNED_BYTE,bytes);gl.readBuffer(gl.COLOR_ATTACHMENT0);renderer.setRenderTarget(null);return bytes;};
const compare=(a,b)=>{let differences=0,maximum=0;for(let i=0;i<a.length;i++){const delta=Math.abs(a[i]-b[i]);if(delta){differences++;maximum=Math.max(maximum,delta);}}return {differences,maximum};};
try {
let cases=0;
for(const ignoreSourceAlpha of [false,true])for(const useMask of [false,true])for(const locked of [false,true])for(const useNormalCheck of [false,true]){
  textures.useMask=useMask;textures.useNormalCheck=useNormalCheck;
  const layer={id:'fixture',name:'fixture',camera:capture,opacity:.63,strength:1.4,ignoreSourceAlpha,projectionVisibilityPolicy:locked?'surface-locked-v1':'standard',adjustments:{hue:17,saturation:-11,lightness:9}};
  const common={group,layer,textures,enableBackfaceCulling:true,projectedImageUvFlipY:false};
  const colorMaterial=createLayerMaterial({...common,compositeMode:'coverage-alpha'}),qualityMaterial=createLayerMaterial({...common,compositeMode:'quality-alpha',qualityOnly:true}),mrtMaterial=createLayerMaterial({...common,compositeMode:'coverage-alpha',mrt:true});materials.push(colorMaterial,qualityMaterial,mrtMaterial);
  const colorTarget=target(256),qualityTarget=target(256,THREE.RedFormat),mrtTarget=createLayerMrtTarget(256);targets.push(mrtTarget);
  draw(colorMaterial,colorTarget);draw(qualityMaterial,qualityTarget);draw(mrtMaterial,mrtTarget);
  const expectedColor=read(colorTarget,0,gl.RGBA,256*256*4),actualColor=read(mrtTarget,0,gl.RGBA,256*256*4),expectedQuality=read(qualityTarget,0,gl.RED,256*256),actualQuality=read(mrtTarget,1,gl.RED,256*256);
  const color=compare(expectedColor,actualColor),quality=compare(expectedQuality,actualQuality);
  if(color.differences||quality.differences){renderer.setRenderTarget(mrtTarget);const status=gl.checkFramebufferStatus(gl.FRAMEBUFFER);renderer.setRenderTarget(null);throw Error('MRT mismatch '+JSON.stringify({ignoreSourceAlpha,useMask,locked,useNormalCheck,color,quality,status,complete:gl.FRAMEBUFFER_COMPLETE,errors,expectedColor:[...expectedColor.slice(0,16)],actualColor:[...actualColor.slice(0,16)],expectedQuality:[...expectedQuality.slice(0,8)],actualQuality:[...actualQuality.slice(0,8)]}));}cases++;
}
await send({cases,differences:0,errors});if(errors.length)throw Error('shader errors');
group.clear();const denseGeometry=new THREE.SphereGeometry(1.5,512,256),denseMesh=new THREE.Mesh(denseGeometry);group.add(denseMesh);group.updateMatrixWorld(true);
textures.useMask=false;textures.useNormalCheck=true;
const layer={id:'perf',name:'perf',camera:capture,opacity:1,ignoreSourceAlpha:true,projectionVisibilityPolicy:'surface-locked-v1'};
const common={group,layer,textures,enableBackfaceCulling:true,projectedImageUvFlipY:false};
const colorMaterial=createLayerMaterial({...common,compositeMode:'coverage-alpha'}),qualityMaterial=createLayerMaterial({...common,compositeMode:'quality-alpha',qualityOnly:true}),mrtMaterial=createLayerMaterial({...common,compositeMode:'coverage-alpha',mrt:true});materials.push(colorMaterial,qualityMaterial,mrtMaterial);
const colorTarget=target(4096),qualityTarget=target(4096,THREE.RedFormat),mrtTarget=createLayerMrtTarget(4096);targets.push(mrtTarget);
draw(colorMaterial,colorTarget);draw(qualityMaterial,qualityTarget);draw(mrtMaterial,mrtTarget);gl.finish();
renderer.info.autoReset=false;
for(let trial=0;trial<3;trial++){renderer.info.reset();let started=performance.now();for(let i=0;i<6;i++){draw(colorMaterial,colorTarget);draw(qualityMaterial,qualityTarget);}gl.finish();const twoPassMs=performance.now()-started,twoPass={...renderer.info.render};renderer.info.reset();started=performance.now();for(let i=0;i<6;i++)draw(mrtMaterial,mrtTarget);gl.finish();const mrtMs=performance.now()-started,mrt={...renderer.info.render};await send({trial,resolution:4096,layers:6,twoPassMs,mrtMs,twoPass,mrt});}
await send({done:true});denseGeometry.dispose();
}catch(error){await send({error:String(error),stack:error?.stack});}finally{materials.forEach(value=>value.dispose());targets.forEach(value=>value.dispose());geometry.dispose();for(const value of [source,mask,normal,depth])value.dispose();renderer.dispose();}
</script></body></html>`;

const server = await createServer({
  root,
  logLevel: 'error',
  server: { host: '127.0.0.1', port: 0, watch: { ignored: () => true } },
  plugins: [{
    name: 'uv-mrt-qa',
    resolveId(id) { if (id === 'virtual:uv-mrt') return moduleId; },
    transform(code, id) {
      if (id.split('?')[0].replaceAll('\\', '/') === moduleId) return `${code}\nexport {createLayerMaterial,createLayerMrtTarget};`;
    },
    configureServer(instance) {
      instance.middlewares.use('/__report', async (request, response) => {
        let body = ''; for await (const chunk of request) body += chunk;
        reports.push(JSON.parse(body)); console.log(body); response.end('ok');
      });
      instance.middlewares.use('/__mrt_qa', (_request, response) => {
        response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(html);
      });
    },
  }],
});
await server.listen();
console.log(`http://127.0.0.1:${server.httpServer.address().port}/__mrt_qa`);
