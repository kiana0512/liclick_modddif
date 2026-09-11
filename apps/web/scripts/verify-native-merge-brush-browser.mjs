import {createServer} from 'vite';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'..');
const ref=execFileSync('git',['show','994df29:apps/web/src/engine/localRepaint/uvRepaint.ts'],{cwd:root,encoding:'utf8'});
const id=path.join(root,'src/engine/localRepaint/__brush-reference.ts').replaceAll('\\','/');
let reload=false;
const server=await createServer({root,cacheDir:'node_modules/.vite-native-merge-brush-v2',logLevel:'error',server:{host:'127.0.0.1',port:0},plugins:[{
  name:'native-merge-brush-qa',resolveId(value){if(value==='virtual:uv-brush-reference')return id;},load(value){if(value===id)return ref;},
  configureServer(server){
    server.middlewares.use('/__native_control',(req,res)=>{if(req.method==='POST'){server.moduleGraph.invalidateAll();reload=true;res.end('queued');}else{res.end(reload?'reload':'');reload=false;}});
    server.middlewares.use('/__native_report',async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;console.log(body);res.end('ok');});
    server.middlewares.use('/__native_test',(_req,res)=>{res.setHeader('Content-Type','text/html; charset=utf-8');res.end(`<!doctype html><title>UV 合并与画笔验证</title><pre>验证中</pre><script type="module">
const panel=document.querySelector('pre');const report=async result=>{panel.textContent+='\\n'+JSON.stringify(result);await fetch('/__native_report',{method:'POST',body:JSON.stringify(result)});};
try {const test=await import('/scripts/uv-native-merge-brush-fixture.mjs');await report(await test.merge());
for(const dpr of [1,1.25,1.5,2])await report(await test.brush(1024,2,dpr));
await report(await test.brush(4096,400,1));
await report(await (await import('/scripts/uv-repaint-hidpi-fixture.mjs')).run());
await report(await (await import('/scripts/uv-repaint-browser-fixture.mjs')).run());
await report({complete:true});}catch(error){await report({error:String(error),stack:error.stack});}
setInterval(async()=>{if(await (await fetch('/__native_control')).text()==='reload')location.reload();},1000);
</script>`);});
  }
}]});
await server.listen();console.log(`http://127.0.0.1:${server.httpServer.address().port}/__native_test?perfWebGpuAb=1`);
