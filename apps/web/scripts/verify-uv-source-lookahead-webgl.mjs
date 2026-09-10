import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {createServer} from 'vite';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.LICLICK_TEST_PLAYWRIGHT_MODULE||'playwright');
const root=path.resolve(import.meta.dirname,'..');
const original=execFileSync('git',['show','d3800a9:apps/web/src/engine/bake/gpuUvBakeRenderer.ts'],{cwd:root,encoding:'utf8'});
const referenceId=path.join(root,'src/engine/bake/__uv-source-reference.ts').replaceAll('\\','/');
const server=await createServer({root,logLevel:'error',plugins:[{
  name:'uv-source-reference',resolveId(id){if(id==='virtual:uv-source-reference')return referenceId;},
  load(id){if(id===referenceId)return original;},
}],server:{host:'127.0.0.1',port:0,watch:{ignored:()=>true}}});
server.middlewares.use('/__source_test',(_req,res)=>{res.setHeader('Content-Type','text/html');res.end('<html><head><link rel="icon" href="data:,"></head><body>UV source comparison</body></html>');});
let browser;
try {
  await server.listen();browser=await chromium.launch({headless:true,channel:'msedge',args:['--enable-webgl','--ignore-gpu-blocklist']});
  const page=await browser.newPage();page.on('pageerror',error=>console.error(error));
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__source_test`);
  for(const [resolution,count,retainRasters] of [[512,13,false],[4096,6,false],[512,13,true]]) console.log(JSON.stringify(await page.evaluate(async({resolution,count,retainRasters})=>
    (await import('/scripts/uv-source-lookahead-browser-fixture.mjs')).run(resolution,count,retainRasters),{resolution,count,retainRasters}),null,2));
} finally {await browser?.close();await server.close();}
