import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createServer } from 'vite';
import ts from 'typescript';
const require=createRequire(import.meta.url);
const root=path.resolve(import.meta.dirname,'..');
const frozen=fs.readFileSync(path.join(root,'scripts/fixtures/quality-blend-0ee7b0b.ts'),'utf8');
const oracle=ts.transpileModule(frozen.slice(frozen.indexOf('const TOP_K'),frozen.indexOf('scope.onmessage =')),{
  compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext},
}).outputText+'\nexport {createTopK,accumulate,resolveCpu};';
const server=await createServer({root,logLevel:'error',plugins:[{
  name:'resident-cpu-oracle',
  configureServer(server) {
    server.middlewares.use('/__quality_test', (_req, res) => {
      res.setHeader('Content-Type', 'text/html');
      res.end(`<!doctype html><meta charset="utf-8"><title>UV quality parity</title>
        <button>验证 UV 质量解析</button><pre>Ready</pre><script type="module">
        import {run} from '/scripts/resident-quality-browser-fixture.mjs';
        document.querySelector('button').onclick=async()=>{
          const result=document.querySelector('pre');result.textContent='Running';
          document.querySelector('button').disabled=true;
          try{result.textContent=JSON.stringify([await run(128,23),await run(128,1)],null,2)}
          catch(e){result.textContent=e.stack;console.error(e)}
          finally{document.querySelector('button').disabled=false}
        };</script>`);
    });
    server.middlewares.use('/__resident_test',(_req,res)=>{res.setHeader('Content-Type','text/html');res.end('<!doctype html><html><head><title>UV contribution regression</title><link rel="icon" href="data:,"></head><body><button id="run">Test UV contributions</button><pre id="result">Ready</pre><script type="module">import {run} from "/scripts/uv-contribution-browser-fixture.mjs";document.querySelector("#run").onclick=async()=>{document.querySelector("#result").textContent="Running";try{document.querySelector("#result").textContent=JSON.stringify(await run(),null,2)}catch(e){document.querySelector("#result").textContent=e.stack;console.error(e)}};</script></body></html>');});
  },
  resolveId(id){if(id==='virtual:resident-cpu-oracle')return '\0resident-cpu-oracle';},
  load(id){if(id==='\0resident-cpu-oracle')return oracle;},
}],server:{host:'127.0.0.1',port:0,watch:process.argv.includes('--serve')?undefined:{ignored:()=>true}}});
let browser;
try {
  await server.listen();
  if(process.argv.includes('--serve')) {
    console.log(`http://127.0.0.1:${server.httpServer.address().port}/__resident_test`);
    await new Promise(()=>{});
  }
  const { chromium }=require(process.env.LICLICK_TEST_PLAYWRIGHT_MODULE || 'playwright');
  browser=await chromium.launch({headless:true,channel:'msedge',args:['--enable-webgl','--ignore-gpu-blocklist']});
  const page=await browser.newPage();
  page.on('console',m=>{if(m.type()==='error')console.error(m.text());});
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__resident_test`);
  console.log(JSON.stringify(await page.evaluate(async()=> (await import('/scripts/resident-quality-browser-fixture.mjs')).run()),null,2));
  console.log(JSON.stringify(await page.evaluate(async()=> (await import('/scripts/resident-quality-browser-fixture.mjs')).run(128,1)),null,2));
  console.log(JSON.stringify(await page.evaluate(async()=> (await import('/scripts/resident-quality-browser-fixture.mjs')).benchmark()),null,2));
  console.log(JSON.stringify(await page.evaluate(async()=> (await import('/scripts/resident-quality-browser-fixture.mjs')).benchmarkUpload()),null,2));
  console.log(JSON.stringify(await page.evaluate(async()=> (await import('/scripts/resident-quality-browser-fixture.mjs')).verifyPreparedHandoff()),null,2));
} finally {await browser?.close();await server.close();}
