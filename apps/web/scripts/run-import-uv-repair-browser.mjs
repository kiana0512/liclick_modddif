import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createServer } from 'vite';
import { fileURLToPath, pathToFileURL } from 'node:url';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const root = fileURLToPath(new URL('..', import.meta.url));
process.chdir(root);
const fixture = `
import React from '/node_modules/.vite/deps/react.js';
import ReactDOMClient from '/node_modules/.vite/deps/react-dom_client.js';
import {BoxGeometry, Mesh, MeshStandardMaterial, Group} from '/node_modules/.vite/deps/three.js';
import {GLTFExporter} from '/node_modules/.vite/deps/three-stdlib.js';
import {useModelUvRepairConfirmation} from '/src/components/editor/ModelUvRepairDialog.tsx';
import {loadModelFromFile} from '/src/engine/loaders/loadModelFromFile.ts';
import {prepareModelUvImport,disposeImportCandidate} from '/src/engine/loaders/prepareModelUvImport.ts';
import {inspectModelUv} from '/src/engine/loaders/modelUvValidation.ts';
import '/src/styles/globals.css';
document.body.style.background='#080914';
const host=document.createElement('div');document.body.append(host);const root=ReactDOMClient.createRoot(host);
const fixture=window.fixture={outcome:null,current:true,bytes:{}};
const encode=async(root)=>new GLTFExporter().parseAsync(root,{binary:true});
function App(){const confirmation=useModelUvRepairConfirmation();fixture.confirm=confirmation.confirm;return confirmation.dialog;}
root.render(React.createElement(App));
const group=new Group(),geometry=new BoxGeometry();group.add(new Mesh(geometry,new MeshStandardMaterial()));
fixture.bytes.valid=await encode(group);
geometry.attributes.uv.array.fill(0);fixture.bytes.degenerate=await encode(group);
fixture.start=async(kind='degenerate',triangleCount)=>{
 fixture.current=true;fixture.outcome=null;
 const file=new File([fixture.bytes[kind]],kind+'.glb');
 const normalize={normalize:true,ground:true,targetMaxDimension:3};
 const parsed=await loadModelFromFile(file,normalize);
 // Inject the count at the threshold boundary; the server responses below are controlled fixtures.
 if(triangleCount) {let first=true;parsed.root.traverse(m=>{if(m.isMesh&&first){m.geometry.setDrawRange(0,m.geometry.index.count);m.geometry.index.count=triangleCount*3;first=false;}});}
 let disposed=false;parsed.root.traverse(m=>m.geometry?.addEventListener('dispose',()=>disposed=true));
 try{
  const prepared=await prepareModelUvImport({file,parsed,normalize,resources:[],confirm:fixture.confirm,isCurrent:()=>fixture.current,progress:()=>{}});
  if(!prepared){fixture.outcome={cancelled:true,disposed};return;}
  const reopened=await loadModelFromFile(prepared.file,normalize);
  fixture.outcome={name:prepared.file.name,sameFile:prepared.file===file,report:inspectModelUv(prepared.loaded.root),reopened:inspectModelUv(reopened.root),disposed,
    bounds:prepared.loaded.object.boundingBox,originalBounds:parsed.object.boundingBox};
  disposeImportCandidate(reopened);disposeImportCandidate(prepared.loaded);
 }catch(e){fixture.outcome={error:e.message,disposed};}
};
fixture.validation=()=>{
 const run=(values,indexed=false)=>{const g=new BoxGeometry();g.setDrawRange(0,3);if(!indexed)g.setIndex(null);for(let i=0;i<3;i++)g.attributes.uv.setXY(indexed?g.index.getX(i):i,...values[i]);const m=new Mesh(g);return inspectModelUv(m);};
 return {valid:run([[0,0],[1,0],[0,1]],true),outside:run([[-1e-7,0],[1,0],[0,1]]),tiny:run([[0,0],[1e-8,0],[0,1e-8]]),point:run([[0,0],[0,0],[0,0]]),line:run([[0,0],[.5,.5],[1,1]]),invalid:run([[NaN,0],[1,0],[0,1]])};
};
`;
const server = await createServer({root,configFile:false,appType:'custom',esbuild:{jsx:'automatic'},resolve:{alias:{'@':`${root}/src`}},
 optimizeDeps:{entries:[],include:['react','react-dom/client','three','three-stdlib']},server:{host:'127.0.0.1',port:0}});
server.middlewares.use('/fixture.mjs',(_req,res)=>{res.setHeader('content-type','text/javascript');res.end(fixture);});
server.middlewares.use('/__import-uv',(_req,res)=>{res.setHeader('content-type','text/html');res.end('<!doctype html><script type="module" src="/fixture.mjs"></script>');});
if(process.env.DECIMATE_INPUT)server.middlewares.use('/real-car.glb',(_req,res)=>{res.setHeader('content-type','model/gltf-binary');createReadStream(process.env.DECIMATE_INPUT).pipe(res);});
if(process.env.DECIMATE_OUTPUT)server.middlewares.use('/real-output.glb',(_req,res)=>{res.setHeader('content-type','model/gltf-binary');createReadStream(process.env.DECIMATE_OUTPUT).pipe(res);});
await server.listen();const browser=await chromium.launch({channel:'msedge',headless:true});
try {
 const page=await browser.newPage({viewport:{width:1100,height:760}});
 const errors=[];page.on('pageerror',e=>{errors.push(e.message);console.error(e.message);});
 let requests=0,responseMode='valid',actualResult,decimateMode='valid',decimateRequests=0;
 await page.route('**/api/asset-processing/import-decimate?*',async route=>{
  decimateRequests++;assert.ok(route.request().url().includes('consent=change-topology-v1'));
  if(decimateMode==='failure')return route.fulfill({status:422,json:{error:'fixture decimate failed'}});
  return route.fulfill({body:Buffer.from(await page.evaluate(mode=>[...new Uint8Array(fixture.bytes[mode])],decimateMode)),contentType:'model/gltf-binary'});
 });
 await page.route('**/api/asset-processing/import-uv-repair?*',async route=>{
  requests++;assert.ok(route.request().url().includes('consent=change-uv-v1'));
  assert.equal(route.request().postDataBuffer().subarray(0,4).toString(),'glTF');
  if(responseMode==='failure')return route.fulfill({status:422,json:{error:'fixture repair failed'}});
  const bytes=actualResult??Buffer.from(await page.evaluate(mode=>[...new Uint8Array(fixture.bytes[mode])],responseMode));
  return route.fulfill({body:bytes,contentType:'model/gltf-binary'});
 });
 await page.goto(server.resolvedUrls.local[0]+'__import-uv');await page.waitForFunction(()=>window.fixture?.start&&window.fixture?.confirm);
 const checks=await page.evaluate(()=>fixture.validation());
 assert.equal(checks.valid.degenerate,0);assert.equal(checks.outside.outside,1);assert.equal(checks.tiny.degenerate,0);
 assert.equal(checks.point.degenerate,1);assert.equal(checks.line.degenerate,1);assert.equal(checks.invalid.invalid,1);
 const start=async(kind='degenerate')=>{await page.evaluate(kind=>{void fixture.start(kind);},kind);};
 const outcome=async()=>{await page.waitForFunction(()=>fixture.outcome!==null);return page.evaluate(()=>fixture.outcome);};
 await start('valid');assert.equal((await outcome()).sameFile,true);assert.equal(requests,0);
 await start();await page.getByRole('dialog',{name:'模型 UV 需要修复'}).waitFor();assert.equal(requests,0);
 if(process.env.UV_REPAIR_SCREENSHOT)await page.screenshot({path:process.env.UV_REPAIR_SCREENSHOT});
 await page.getByRole('button',{name:'取消导入',exact:true}).click();assert.deepEqual(await outcome(),{cancelled:true,disposed:true});assert.equal(requests,0);
 await start();await page.getByRole('dialog').waitFor();await page.keyboard.press('Escape');assert.equal((await outcome()).cancelled,true);assert.equal(requests,0);
 await start();await page.getByRole('dialog').waitFor();await page.evaluate(()=>fixture.current=false);assert.equal((await outcome()).cancelled,true);assert.equal(requests,0);
 await start();await page.getByRole('button',{name:'同意修改 UV 并导入'}).click();let out=await outcome();assert.equal(requests,1);assert.equal(out.sameFile,false);assert.equal(out.disposed,true);assert.equal(out.report.degenerate,0);assert.deepEqual(out.report,out.reopened);assert.match(out.name,/_uv-repaired.glb$/);
 responseMode='failure';await start();await page.getByRole('button',{name:'同意修改 UV 并导入'}).click();out=await outcome();assert.match(out.error,/fixture repair failed/);assert.equal(out.disposed,true);
 responseMode='degenerate';await start();await page.getByRole('button',{name:'同意修改 UV 并导入'}).click();out=await outcome();assert.match(out.error,/修复后 UV 仍不满足/);assert.equal(out.disposed,true);
 const large=async(count=1500001)=>page.evaluate(n=>{void fixture.start('valid',n);},count);
 responseMode='valid';const uvRequests=requests;
 await large(1500000);out=await outcome();assert.equal(out.sameFile,true);assert.equal(decimateRequests,0);
 await large();await page.getByRole('dialog',{name:'模型面数较高，需要减面'}).waitFor();assert.equal(decimateRequests,0);
 const decimateText=await page.getByRole('dialog').innerText();
 assert.ok(decimateText.includes('减面可能导致模型细节丢失、轮廓变化，以及已有贴图拉伸或错位。'));
 assert.ok(decimateText.includes('如果不希望出现这些影响，请取消导入，自行手动减面至 150 万个三角面以内，确认模型和贴图效果后重新上传。'));
 assert.ok(decimateText.includes('原文件不会被覆盖。取消或处理失败，本次模型不会导入。'));
 assert.doesNotMatch(decimateText,/按距离合并|重新展开|UV 布局/);
 await page.getByRole('button',{name:'取消导入',exact:true}).click();assert.equal((await outcome()).cancelled,true);assert.equal(decimateRequests,0);
 await large();await page.getByRole('dialog').waitFor();await page.keyboard.press('Escape');assert.equal((await outcome()).cancelled,true);assert.equal(decimateRequests,0);
 await large();await page.getByRole('dialog').waitFor();await page.evaluate(()=>fixture.current=false);assert.equal((await outcome()).cancelled,true);assert.equal(decimateRequests,0);
 await large(2000001);await page.getByRole('button',{name:'同意减面并继续'}).click();out=await outcome();assert.equal(out.disposed,true);assert.match(out.name,/_200k.glb$/);assert.equal(requests,uvRequests);assert.equal(decimateRequests,1);
 decimateMode='failure';await large();await page.getByRole('button',{name:'同意减面并继续'}).click();out=await outcome();assert.match(out.error,/fixture decimate failed/);assert.equal(out.disposed,true);
 decimateMode='degenerate';await large();await page.getByRole('button',{name:'同意减面并继续'}).click();await page.getByRole('dialog',{name:'模型 UV 需要修复'}).waitFor();assert.equal(requests,uvRequests);
 await page.getByRole('button',{name:'取消导入',exact:true}).click();assert.equal((await outcome()).cancelled,true);assert.equal(requests,uvRequests);
 await large();await page.getByRole('button',{name:'同意减面并继续'}).click();await page.getByRole('button',{name:'同意修改 UV 并导入'}).click();out=await outcome();assert.match(out.name,/_200k_uv-repaired.glb$/);assert.equal(out.report.degenerate,0);assert.equal(requests,uvRequests+1);assert.deepEqual(out.report,out.reopened);
 console.log('Decimation: strict 1.5M threshold, >2M eligible, cancel/Escape/stale/failure, preserved UV bypass, separate UV consent, cancel UV blocks import, two-stage reload passed.');
 if(process.env.DECIMATE_INPUT&&process.env.DECIMATE_OUTPUT){
  // This 190MiB binary upload exceeds CDP's escaped-JSON string limit. The real HTTP
  // handler/Blender output is tested separately; inject that output at fetch here.
  await page.unrouteAll();page.setDefaultTimeout(120000);
  await page.evaluate(async()=>{
   fixture.bytes.real=await(await window.fetch('/real-car.glb')).arrayBuffer();
   const fetchOriginal=window.fetch.bind(window);fixture.processingRequests=[];
   window.fetch=(url,options)=>{
    if(String(url).includes('/api/asset-processing/')){
     fixture.processingRequests.push({url:String(url),bytes:options.body.byteLength});
     return fetchOriginal('/real-output.glb');
    }
    return fetchOriginal(url,options);
   };
  });
  await start('real');await page.getByRole('dialog',{name:'模型面数较高，需要减面'}).waitFor();
  if(process.env.DECIMATE_SCREENSHOT)await page.screenshot({path:process.env.DECIMATE_SCREENSHOT});
  const previous=requests;await page.getByRole('button',{name:'同意减面并继续'}).click();out=await outcome();
  assert.ok(!out.error,JSON.stringify(out));assert.ok(out.report.triangles>198000&&out.report.triangles<=202000);assert.equal(requests,previous);
  assert.equal(out.report.degenerate,0);assert.equal(out.report.outside,0);assert.deepEqual(out.report,out.reopened);
  const realRequests=await page.evaluate(()=>fixture.processingRequests);assert.equal(realRequests.length,1);assert.match(realRequests[0].url,/import-decimate\?consent=change-topology-v1/);assert.ok(realRequests[0].bytes>100000000);
  console.log('Real car: '+JSON.stringify(out.report)+'; saved GLB reload matches, no UV repair needed.');
 }
 if(process.env.UV_REPAIR_INPUT&&process.env.UV_REPAIR_OUTPUT){
  const input=await readFile(process.env.UV_REPAIR_INPUT);actualResult=await readFile(process.env.UV_REPAIR_OUTPUT);
  await page.evaluate(bytes=>{fixture.bytes.real=new Uint8Array(bytes).buffer;},[...input]);
  await start('real');await page.getByRole('button',{name:'同意修改 UV 并导入'}).click();out=await outcome();
  assert.ok(!out.error,JSON.stringify(out));assert.equal(out.report.triangles,1742);assert.equal(out.report.degenerate,0);assert.equal(out.report.outside,0);assert.deepEqual(out.report,out.reopened);
  const close=(a,b)=>{if(typeof a==='number'){assert.ok(Math.abs(a-b)<1e-5);return;}for(const k of Object.keys(a))close(a[k],b[k]);};close(out.bounds,out.originalBounds);
  console.log('Real train: consent → repaired GLB → reload valid; 1742 triangles and normalized bounds preserved.');
 }
 assert.deepEqual(errors,[]);
 console.log('Import UV: Float32 detection, indexed/tiny cases, no-op, consent/cancel/Escape/stale, server failure, failed QA, repaired file reload and disposal passed.');
} finally {await browser.close();await server.close();}
