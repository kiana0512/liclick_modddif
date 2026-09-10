// Manual WebGL2 test: set PLAYWRIGHT_MODULE to an installed module entry and BROWSER_CHANNEL (e.g. msedge).
// Exercises production materials. Counts only fully covered interior pixels, excluding a 2px AA/capture boundary.
import assert from 'node:assert/strict';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
import { createServer } from 'vite';
const server = await createServer({ root: path.resolve(import.meta.dirname, '..'), appType:'custom', logLevel:'error', server: { host:'127.0.0.1', port:0 } });
server.middlewares.use('/__qa', (_req,res)=>{res.setHeader('Content-Type','text/html');res.end('<html><head><link rel="icon" href="data:,"></head><body></body></html>');});
await server.listen();
const browser = await chromium.launch({channel: process.env.BROWSER_CHANNEL, headless:true});
try {
 const page=await browser.newPage();page.on('console',m=>{if(m.type()==='error')process.stderr.write(m.text()+'\n');});
 await page.goto(server.resolvedUrls.local[0]+'__qa');
 const report=await page.evaluate(async()=>{
  const THREE=await import('/node_modules/three/build/three.module.js');
  const p=await import('/src/engine/projection/ProjectedLayerMaterial.ts');
  const renderer=new THREE.WebGLRenderer({antialias:false});renderer.setSize(256,256);renderer.setClearColor(0);renderer.toneMapping=THREE.NoToneMapping;
  const camera=new THREE.PerspectiveCamera(45,1,.1,100);camera.position.set(.2,.3,5);camera.lookAt(0,0,0);camera.updateMatrixWorld();
  const capture={type:'perspective',projection:'perspective',position:camera.position.toArray(),quaternion:camera.quaternion.toArray(),target:[0,0,0],near:.1,far:100,fov:45,zoom:1,projectionMatrix:camera.projectionMatrix.toArray(),matrixWorld:camera.matrixWorld.toArray(),viewMatrix:camera.matrixWorldInverse.toArray(),aspect:1};
  const texture=new THREE.DataTexture(new Uint8Array([255,0,0,255]),1,1);texture.needsUpdate=true;
  const uv=p.createUvOverlayPreviewMaterial({displayMode:'flat',selected:false,uvOverlayTexture:texture});
  const c=document.createElement('canvas');c.width=c.height=2;const ctx=c.getContext('2d');ctx.fillStyle='#00ff00';ctx.fillRect(0,0,2,2);
  const overlay=await p.createProjectedLayerMaterial({layerId:'repaint',imageUrl:c.toDataURL(),objectId:'model',camera:capture,opacity:1,visible:true,depthTest:true,transparentProjectionOnly:true,useDepthCheck:false,enableBackfaceCulling:false,edgeFeather:0});
  const scene=new THREE.Scene();const geo=new THREE.PlaneGeometry(3,3);const mesh=new THREE.Mesh(geo,uv);scene.add(mesh);
  const paint=new THREE.Mesh(geo,overlay);paint.renderOrder=10;scene.add(paint);
  const target=new THREE.WebGLRenderTarget(256,256);target.samples=4;
  const read=()=>{renderer.setRenderTarget(target);renderer.render(scene,camera);const out=new Uint8Array(256*256*4);renderer.readRenderTargetPixels(target,0,0,256,256,out);return out;};
  const original=uv.fragmentShader.replace('gl_FragDepthEXT = gl_FragCoord.z;', '');const originalVertex=uv.vertexShader;const report=[];
  for(const angle of [0,.37,.8]) {
   mesh.rotation.set(.15,angle,.05);paint.rotation.copy(mesh.rotation);mesh.position.z=.37;paint.position.z=.37;
   mesh.visible=false;const expected=read();mesh.visible=true;
   const errors=(actual)=>{let n=0;for(let y=2;y<254;y++)for(let x=2;x<254;x++){const i=(y*256+x)*4;let interior=true;for(let dy=-2;dy<=2;dy++)for(let dx=-2;dx<=2;dx++)if(expected[i+(dy*256+dx)*4+1]<100)interior=false;if(interior&&actual[i]>20)n++;}return n;};
   uv.vertexShader=originalVertex;overlay.vertexShader=originalVertex;overlay.needsUpdate=true;
   uv.fragmentShader=original;uv.needsUpdate=true;const before=errors(read());
   uv.vertexShader=originalVertex;overlay.vertexShader=originalVertex;overlay.needsUpdate=true;
   uv.fragmentShader=original.replace('void main() {','void main() { gl_FragDepth = gl_FragCoord.z;');uv.needsUpdate=true;const after=errors(read());
   const shell=new THREE.Mesh(new THREE.PlaneGeometry(.6,.6),new THREE.MeshBasicMaterial({color:'#0000ff'}));
   shell.position.z=.95;scene.add(shell);
   mesh.visible=false;paint.visible=false;const shellOnly=read();mesh.visible=true;paint.visible=true;
   const shellAndPaint=read();let shellLeaks=0;
   for(let i=0;i<shellOnly.length;i+=4)if(shellOnly[i+2]===255&&shellAndPaint[i+1]>0)shellLeaks++;
   scene.remove(shell);shell.geometry.dispose();shell.material.dispose();
   report.push({angle,before,after,shellLeaks});
  }
  renderer.dispose();return report;
 });
 for (const row of report) { assert(row.before > 1000, 'Legacy MSAA path must reproduce'); assert.equal(row.after, 0, JSON.stringify(row)); assert.equal(row.shellLeaks,0,'Foreground shell must still occlude repaint'); }
 process.stdout.write(JSON.stringify(report)+'\n');
}finally{await browser.close();await server.close();}
