import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {createServer} from 'vite';
const require=createRequire(import.meta.url);
const chromium=process.env.LICLICK_SOURCE_IAB ? undefined
  : require(process.env.LICLICK_TEST_PLAYWRIGHT_MODULE||'playwright').chromium;
const root=path.resolve(import.meta.dirname,'..');
const original=execFileSync('git',['show',`${process.env.LICLICK_SOURCE_REFERENCE||'d3800a9'}:apps/web/src/engine/bake/gpuUvBakeRenderer.ts`],{cwd:root,encoding:'utf8'});
const referenceId=path.join(root,'src/engine/bake/__uv-source-reference.ts').replaceAll('\\','/');
const cases=process.env.LICLICK_SOURCE_FULL_ALPHA ? [[512,13,true,true],[4096,6,false,true],[512,2,true,true,'image/jpeg'],[512,2,true,true,'image/png',true]] : [[512,13,false],[4096,6,false],[512,13,true]];
if(process.env.LICLICK_SOURCE_CACHE)cases.push([512,6,true,true,'image/png',false,true],[257,3,true,true,'image/png',false,true]);
const server=await createServer({root,cacheDir:`node_modules/.vite-source-qa-${process.pid}`,logLevel:'error',plugins:[{
  name:'uv-source-reference',resolveId(id){if(id==='virtual:uv-source-reference')return referenceId;},
  load(id){if(id===referenceId)return original;},
  configureServer:installRoutes,
}],server:{host:'127.0.0.1',port:0,watch:{ignored:()=>true}}});
function installRoutes(server) {
server.middlewares.use('/__source_report',async(req,res)=>{
  let body='';for await(const chunk of req)body+=chunk;
  console.log(body);res.end('ok');
});
server.middlewares.use('/__source_test',(_req,res)=>{res.setHeader('Content-Type','text/html');res.end('<html><head><link rel="icon" href="data:,"></head><body><pre>UV source comparison</pre>'+ (process.env.LICLICK_SOURCE_IAB ? `<script type="module">
const panel=document.querySelector('pre');
try { const {run}=await import('/scripts/uv-source-lookahead-browser-fixture.mjs');
for(const args of ${JSON.stringify(cases)}) {panel.textContent+='\\n计算 '+JSON.stringify(args);const result=await run(...args);await fetch('/__source_report',{method:'POST',body:JSON.stringify(result)});panel.textContent+='\\n'+JSON.stringify(result);}
${process.env.LICLICK_SOURCE_CACHE ? "const result=await (await import('/scripts/uv-source-lookahead-browser-fixture.mjs')).runCached();await fetch('/__source_report',{method:'POST',body:JSON.stringify(result)});panel.textContent+='\\n'+JSON.stringify(result);" : ''}
panel.textContent+='\\n全部像素对照通过';
}catch(error){panel.textContent+='\\n失败：'+error;await fetch('/__source_report',{method:'POST',body:JSON.stringify({error:String(error)})});}
</script>` : '')+'</body></html>');});
}
let browser;
try {
  await server.listen();
  if(process.env.LICLICK_SOURCE_IAB){console.log(`In-app test: http://127.0.0.1:${server.httpServer.address().port}/__source_test`);await new Promise(()=>{});}
  browser=await chromium.launch({headless:true,channel:'msedge',args:['--enable-webgl','--ignore-gpu-blocklist']});
  const page=await browser.newPage();page.on('pageerror',error=>console.error(error));
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__source_test`);
  for(const [resolution,count,retainRasters,fullAlpha,mime,aspect] of cases) console.log(JSON.stringify(await page.evaluate(async({resolution,count,retainRasters,fullAlpha,mime,aspect})=>
    (await import('/scripts/uv-source-lookahead-browser-fixture.mjs')).run(resolution,count,retainRasters,fullAlpha,mime,aspect),{resolution,count,retainRasters,fullAlpha,mime,aspect}),null,2));
} finally {await browser?.close();await server.close();}
