import { createRequire } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
const require = createRequire(import.meta.url);
const { createServer } = require('vite');
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
assert(process.env.LICLICK_UV_PROJECT_FILE, 'Provide a local project document for read-only asset testing');
const projectFile = path.resolve(process.env.LICLICK_UV_PROJECT_FILE);
const assetRoot = path.dirname(projectFile);
const saved = JSON.parse(await readFile(projectFile, 'utf8'));
const root = fileURLToPath(new URL('..', import.meta.url)).replaceAll('\\', '/').replace(/\/$/, '');
const baseline = new Map();
if(process.env.LICLICK_UV_BASELINE)for(const file of ['engine/bake/gpuUvBakeRenderer.ts','engine/bake/dilation.ts',
  'engine/bake/uvSeamReconciliation.ts','engine/bake/uvSeamGeometrySnapshot.ts','engine/bake/uvRasterizer.ts',
  'engine/bake/webGpuUvTopologyRaster.ts','engine/bake/residentQualityComposite.ts','workers/qualityBlend.worker.ts'])
  baseline.set(root+'/src/'+file,execFileSync('git',['show','HEAD:apps/web/src/'+file],{cwd:root,encoding:'utf8',maxBuffer:4*1024*1024}));
const rewrite = value => typeof value === 'string' && value.startsWith('assets/') ? '/__asset/' + value :
  Array.isArray(value) ? value.map(rewrite) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k,v])=>[k,rewrite(v)])) : value;
const project = rewrite({id:'isolated-real-uv',name:'Read-only UV comparison',objects:saved.objects,
  layers:saved.layers.filter(layer=>layer.imageUrl),captures:saved.captures,generations:[],references:[],bakedTextures:[]});
let fixture = await readFile(root + '/scripts/uv-repaint-viewport-fixture.mjs', 'utf8');
fixture = fixture.slice(0, fixture.indexOf("  const source = document.createElement('canvas');")).replaceAll("'../src/", "'/src/").replace('25000','180000');
const start = fixture.indexOf('  const group = new THREE.Group();');
const end = fixture.indexOf('  useProjectStore.setState');
fixture = fixture.slice(0,start) + String.raw`
  const project=await (await fetch('/__project')).json();
  const object=project.objects[0];
  const {FBXLoader}=await import('three/examples/jsm/loaders/FBXLoader.js');
  const group=await new FBXLoader().loadAsync(object.sourcePath);
  group.position.fromArray(object.transform.position);group.rotation.fromArray(object.transform.rotation);group.scale.fromArray(object.transform.scale);group.updateMatrixWorld(true);
  const model={objectId:object.id,name:object.name,format:'fbx',group,sourceFileName:'comparison.fbx',
    materialSlots:object.materialSlots.map(slot=>slot.name),uvSets:object.uvSets,boundingBox:object.boundingBox,
    originalBoundingBox:object.originalBoundingBox,childMeshCount:object.childMeshCount,warnings:[],restoreStage:'full'};
` + fixture.slice(end);
fixture = fixture.replace("resolution: '1K'", "resolution: '4K'");
if(process.env.LICLICK_UV_RELOAD_TEST)fixture=fixture.replace("  const project=await", "  const {useAuthStore}=await import('/src/stores/authStore.ts');useAuthStore.setState({user:{id:'isolated-uv-cache-owner'}});\n  const project=await");
fixture += String.raw`
  await new Promise(resolve=>setTimeout(resolve,1500));
  const center=new THREE.Vector3().fromArray(object.boundingBox.center);
  runtime.controls.target.copy(center);runtime.camera.position.copy(center).add(new THREE.Vector3(4,1.5,5));runtime.camera.lookAt(center);runtime.controls.update();
  const original=project.layers.map(layer=>({...layer,visible:layer.type==='projected'||layer.role==='content-aware-underlay'}));
  useLayerStore.setState({layers:original});
  await until(()=>document.body.dataset.residentUvProjectionStatus==='ready','full UV buffer');await tick();await tick();
  const {waitForResidentUvPresentation}=await import('/src/engine/projection/residentUvPresentation.ts');
  await waitForResidentUvPresentation(runtime.scene,object.id);
  const pixels=()=>{runtime.gl.setRenderTarget(null);runtime.gl.render(runtime.scene,runtime.camera);
    const gl=runtime.gl.getContext(),rgba=new Uint8Array(gl.drawingBufferWidth*gl.drawingBufferHeight*4);
    gl.readPixels(0,0,gl.drawingBufferWidth,gl.drawingBufferHeight,gl.RGBA,gl.UNSIGNED_BYTE,rgba);return rgba;};
  const initial=pixels();
  const initialUv=window.fixtureLastUv;
  const uniforms=()=>{let value;group.traverse(child=>{if(child.isMesh&&!child.userData.liclickPaintOverlay&&child.material?.uniforms)value=Object.fromEntries(Object.entries(child.material.uniforms).map(([k,v])=>[k,v.value?.isTexture?{width:v.value.image?.width,height:v.value.image?.height,minFilter:v.value.minFilter,flipY:v.value.flipY,colorSpace:v.value.colorSpace}:typeof v.value==='number'?v.value:undefined]));});return value;};
  const initialUniforms=uniforms();
  const texturePixels=name=>{let texture;group.traverse(child=>{if(child.isMesh&&!child.userData.liclickPaintOverlay&&child.material?.uniforms)texture=child.material.uniforms[name].value;});
    const gl=runtime.gl.getContext(),previous=gl.getParameter(gl.FRAMEBUFFER_BINDING),frame=gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER,frame);gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,runtime.gl.properties.get(texture).__webglTexture,0);
    if(gl.checkFramebufferStatus(gl.FRAMEBUFFER)!==gl.FRAMEBUFFER_COMPLETE)throw Error('Invalid texture framebuffer');
    const rgba=new Uint8Array(texture.image.width*texture.image.height*4);gl.readPixels(0,0,texture.image.width,texture.image.height,gl.RGBA,gl.UNSIGNED_BYTE,rgba);
    gl.bindFramebuffer(gl.FRAMEBUFFER,previous);gl.deleteFramebuffer(frame);return rgba;};
  const initialGpu=texturePixels(initialUniforms.uvOverlayOpacity>0?'uvOverlayMap':'baseMap');
  window.projectUvFixture={async toggle(id,visible){
    const revision=document.body.dataset.residentUvProjectionRevision,start=performance.now();
    useLayerStore.setState({layers:useLayerStore.getState().layers.map(layer=>layer.id===id?{...layer,visible}:layer)});
    await until(()=>document.body.dataset.residentUvProjectionRevision!==revision && document.body.dataset.residentUvProjectionStatus==='ready','toggle');await tick();
    await waitForResidentUvPresentation(runtime.scene,object.id);
    return {ms:performance.now()-start,stages:JSON.parse(document.body.dataset.residentUvProjectionStages)};
  },async manual(){
    const {prepareMergeProjectionLayers}=await import('/src/engine/bake/prepareMergeProjectionLayers.ts');
    const {bakeVisibleProjectedLayersToTexture}=await import('/src/engine/bake/bakeProjectedLayerToTexture.ts');
    const {getMergeUvPostprocessOptions}=await import('/src/engine/layers/mergeUvComposition.ts');
    const {encodeRgbaPngBlob}=await import('/src/utils/encodeRgbaPng.ts');
    const layers=await prepareMergeProjectionLayers(original.filter(layer=>layer.type==='projected').sort((a,b)=>b.order-a.order));
    const result=await bakeVisibleProjectedLayersToTexture({objectId:object.id,sourceModel:model,transientLayers:layers,
      resolution:4096,enableBackfaceCulling:true,enableDilation:false,dilationPixels:0,...getMergeUvPostprocessOptions(4096),
      repairMissingUvSeams:true,outputAlpha:'transparent',commitToProject:false,markSourceLayersBaked:false,skipImageEncoding:true,skipCanvasUpload:true});
    let uvChanged=0,uvMax=0,alphaChanged=0;
    if(initialUv)for(let i=0;i<result.imageData.data.length;i++){const delta=Math.abs(initialUv[i]-result.imageData.data[i]);if(delta){uvChanged++;if(i%4===3)alphaChanged++;}uvMax=Math.max(uvMax,delta);}
    const {compositeRgbaUrlUnderWithWebGpu}=await import('/src/engine/performance/webGpuRgbaComposite.ts');
    for(const layer of original.filter(layer=>layer.visible&&layer.role==='content-aware-underlay')){
      const combined=await compositeRgbaUrlUnderWithWebGpu(result.imageData.data,layer.imageUrl,4096,4096,layer.opacity);
      result.imageData=new ImageData(combined.data,4096,4096);
    }
    const blob=await encodeRgbaPngBlob(4096,4096,result.imageData.data),url=URL.createObjectURL(blob);
    const merged={id:'comparison-merged',objectId:object.id,name:'Comparison UV',type:'uv',role:'merged-uv',imageUrl:url,visible:true,opacity:1,blendMode:'normal',order:-1,renderedColor:false};
    useLayerStore.setState({layers:[merged,...original.map(layer=>layer.role==='content-aware-underlay'?{...layer,visible:false}:layer)]});
    await until(()=>{let ready=false;group.traverse(child=>{if(child.isMesh && !child.userData.liclickPaintOverlay && child.material?.name==='LiclickUvOverlayPreview' && !child.material.userData.liclickResidentUvProjectionLayers && child.material.uniforms.uvOverlayMap.value.userData.liclickPreviewSourceUrl===url)ready=true;});return ready;},'manual UV display');
    await tick();await tick();const actual=pixels();let changed=0,total=0,max=0;
    const manualGpu=texturePixels('uvOverlayMap');let gpuChanged=0,gpuAlphaChanged=0,gpuMax=0,gpuFlipChanged=0;
    for(let i=0;i<manualGpu.length;i++){const delta=Math.abs(initialGpu[i]-manualGpu[i]);if(delta){gpuChanged++;if(i%4===3)gpuAlphaChanged++;}gpuMax=Math.max(gpuMax,delta);}
    for(let y=0;y<4096;y++)for(let x=0;x<4096*4;x++)if(manualGpu[y*4096*4+x]!==initialGpu[(4095-y)*4096*4+x])gpuFlipChanged++;
    for(let i=0;i<actual.length;i++){const delta=Math.abs(actual[i]-initial[i]);if(delta)changed++;total+=delta;max=Math.max(max,delta);}
    return {changed,mean:total/actual.length,max,uvChanged,uvMax,alphaChanged,gpuChanged,gpuAlphaChanged,gpuMax,gpuFlipChanged,uvCaptured:!!initialUv,initialUniforms,manualUniforms:uniforms()};
  },normalId:original.find(layer=>layer.type==='projected'&&!layer.id.startsWith('local-repaint-')).id,
    localId:original.find(layer=>layer.id.startsWith('local-repaint-')).id};
}
`;
const server=await createServer({root,configFile:false,resolve:{alias:{'@':root+'/src'}},server:{host:'127.0.0.1',port:0,hmr:false,watch:{ignored:['**/*']}},
  cacheDir:'node_modules/.vite-project-uv-qa',optimizeDeps:{entries:['scripts/uv-repaint-viewport-fixture.mjs']},plugins:[{
    name:'read-only-project-uv',configureServer(s){
      s.middlewares.use('/__project',(_,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(project));});
      s.middlewares.use('/__asset/',async(req,res)=>{try{
        const file=path.resolve(assetRoot,decodeURIComponent(req.url.split('?')[0]).replace(/^\//,''));
        if(!file.startsWith(assetRoot+path.sep)){res.statusCode=403;res.end();return;}
        res.end(await readFile(file));
      }catch{res.statusCode=404;res.end();}});
      s.middlewares.use('/__fixture',(_,res)=>{res.setHeader('Content-Type','text/html');res.end('<!doctype html><title>Read-only model UV comparison</title>');});
    },resolveId(id){if(id==='/__project-fixture.mjs')return root+'/__project-fixture.mjs';},load(id){if(id===root+'/__project-fixture.mjs')return fixture;}
  },{name:'frozen-head-uv-algorithms',enforce:'pre',load(id){return baseline.get(id.split('?')[0]);}}]});
await server.listen();
const browser=await chromium.launch({channel:'msedge',headless:true});
try{
  const page=await browser.newPage({viewport:{width:1100,height:900}});const errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto(server.resolvedUrls.local[0]+'__fixture');
  const setup=()=>page.evaluate(async()=>{
    const originalDigest=crypto.subtle.digest.bind(crypto.subtle);window.fixtureCacheKeys=[];
    crypto.subtle.digest=async(algorithm,data)=>{if(data.byteLength<100000&&new Uint8Array(data.buffer??data,data.byteOffset??0,1)[0]===123){try{const value=JSON.parse(new globalThis.TextDecoder().decode(data));if(value.purpose)window.fixtureCacheKeys.push(value);}catch{/* Non-JSON digests are unrelated to cache identity. */}}return originalDigest(algorithm,data);};
    const original=window.createImageBitmap;window.createImageBitmap=(...args)=>{
    if(args[0] instanceof ImageData&&args[0].width===4096&&args[1]?.imageOrientation==='flipY')window.fixtureLastUv=args[0].data.slice();
    return original(...args);
  };const module=await import('/__project-fixture.mjs');await module.setup();});
  await setup();
  const prefix=path.join(tmpdir(),process.env.LICLICK_UV_BASELINE?'li3d-baseline-uv':'li3d-real-uv');
  await page.screenshot({path:prefix+'-resident.png'});
  if(process.env.LICLICK_UV_RELOAD_TEST){
    await page.waitForFunction(()=>!!document.body.dataset.residentUvCacheWrite,{},{timeout:60000});
    console.log('disk write',await page.evaluate(()=>document.body.dataset.residentUvCacheWrite));
    const before=await page.evaluate(()=>window.fixtureCacheKeys);
    const diskBefore=await page.evaluate(async()=>{const cache=await window.caches.open('li3d-resident-uv-display-v1');return Promise.all((await cache.keys()).map(async key=>({url:key.url,headers:Object.fromEntries((await cache.match(key)).headers)})));});
    const started=Date.now();await page.reload();await setup();
    const stages=await page.evaluate(()=>JSON.parse(document.body.dataset.residentUvProjectionStages));
    const after=await page.evaluate(()=>window.fixtureCacheKeys);
    const miss=await page.evaluate(()=>document.body.dataset.residentUvCacheMiss);
    const report={reloadMs:Date.now()-started,stages,errors,before,after,diskBefore,miss};
    await writeFile(prefix+'-reload.json',JSON.stringify(report,null,2));
    console.log(JSON.stringify({reloadMs:report.reloadMs,stages,errors}));
    assert(Number.isFinite(stages.compressedUvRestoreMs),'F5 must restore verified UV instead of reprojecting');assert.deepEqual(errors,[]);
  }else{
  const timing=[];
  for(const type of ['localId','normalId']) for(const visible of [false,true]) timing.push({type,visible,...await page.evaluate(async({type,visible})=>window.projectUvFixture.toggle(window.projectUvFixture[type],visible),{type,visible})});
  const comparison=await page.evaluate(()=>window.projectUvFixture.manual());
  await page.screenshot({path:prefix+'-manual.png'});
  const result={errors,timing,comparison};await writeFile(prefix+'.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));assert.deepEqual(errors,[]);
  }
}finally{await browser.close();await server.close();}
