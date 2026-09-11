import assert from 'node:assert/strict';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createServer} from 'vite';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const root=path.resolve(import.meta.dirname,'..');
const server=await createServer({root,logLevel:'error',server:{host:'127.0.0.1',port:0,watch:{ignored:()=>true}}});
server.middlewares.use('/__quality',(_req,res)=>{res.setHeader('Content-Type','text/html');res.end('<title>Quality readback parity</title>');});
let browser;
try {
  await server.listen();
  browser=await chromium.launch({channel:'msedge',headless:true});
  const page=await browser.newPage(),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  page.on('console',message=>{if(message.type()==='error'&&!message.text().includes('404'))errors.push(message.text());});
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__quality`);
  const result=await page.evaluate(async()=>{
    const THREE=await import('/node_modules/three/build/three.module.js');
    const {QualityAlphaReadback}=await import('/src/engine/bake/qualityAlphaReadback.ts');
    const {readRenderTargetPixelsInStripes}=await import('/src/engine/bake/gpuReadbackStripes.ts');
    const {convertQualityGpuReadbackInWorker}=await import('/src/engine/bake/gpuReadbackConversionWorker.ts');
    const {calibrateResidentQuality}=await import('/src/engine/bake/residentQualityCalibration.ts');
    const {residentQualityPolicy}=await import('/src/engine/bake/residentQualityComposite.ts');
    const renderer=new THREE.WebGLRenderer({antialias:false});
    const material=new THREE.RawShaderMaterial({glslVersion:THREE.GLSL3,
      vertexShader:'in vec3 position;void main(){gl_Position=vec4(position,1.);}',
      fragmentShader:'precision highp float;out vec4 color;void main(){float a=mod(floor(gl_FragCoord.x)*17.+floor(gl_FragCoord.y)*71.,256.)/255.;color=vec4(.2,.4,.8,a);}',
      blending:THREE.NoBlending,depthTest:false,depthWrite:false});
    const geometry=new THREE.PlaneGeometry(2,2),mesh=new THREE.Mesh(geometry,material),camera=new THREE.Camera();
    const results=[];
    for(const resolution of [16,512,4096]) {
      const source=new THREE.WebGLRenderTarget(resolution,resolution,{depthBuffer:false});
      renderer.setRenderTarget(source);renderer.setViewport(0,0,resolution,resolution);renderer.render(mesh,camera);
      renderer.setPixelRatio(2);
      renderer.setRenderTarget(null);renderer.setViewport(1,2,11,12);renderer.setScissor(2,3,8,9);renderer.setScissorTest(true);renderer.autoClear=false;
      const reader=new QualityAlphaReadback(renderer,resolution);
      const start=performance.now();
      const reference=await convertQualityGpuReadbackInWorker(await readRenderTargetPixelsInStripes(renderer,source,resolution),resolution);
      const legacyMs=performance.now()-start;
      const started=performance.now(),promise=reader.read(source);
      if(renderer.getRenderTarget()!==null || renderer.getViewport(new THREE.Vector4()).toArray().join()!=='1,2,11,12' ||
        !renderer.getScissorTest() || renderer.autoClear || renderer.getPixelRatio()!==2)throw Error('Packing leaked renderer state');
      const actual=await promise,packedMs=performance.now()-started;
      let changed=0;for(let i=0;i<reference.length;i++)if(reference[i]!==actual[i])changed++;
      results.push({resolution,changed,legacyMs,packedMs});
      reader.dispose();source.dispose();renderer.setScissorTest(false);renderer.setPixelRatio(1);
    }
    let rejected=false;
    try{await convertQualityGpuReadbackInWorker(new Uint8Array(15),4,true);}catch{rejected=true;}
    const calibration=[];
    for(const preserve of [false,true]) {
      await calibrateResidentQuality(renderer,preserve);
      calibration.push(residentQualityPolicy(renderer,preserve).retainRasters);
    }
    renderer.dispose();material.dispose();geometry.dispose();
    return {results,rejected,calibration};
  });
  console.log(JSON.stringify({result,errors},null,2));
  assert.deepEqual(errors,[]);assert(result.rejected);
  assert.deepEqual(result.calibration,[false,false]);
  for(const item of result.results)assert.equal(item.changed,0);
} finally {await browser?.close();await server.close();}
