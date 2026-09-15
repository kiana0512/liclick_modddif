import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
import ts from 'typescript';
const root=new URL('../../../',import.meta.url);
const file='apps/web/src/engine/bake/persistentMergePreparation.ts';
const compile=source=>ts.transpileModule(source.replace(/^import[^\n]+\n/gm,''),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
const before=compile(execFileSync('git',['show',`4c6da2f7:${file}`],{cwd:root,encoding:'utf8'}));
const after=compile(fs.readFileSync(new URL(file,root),'utf8'));
const scheduling=compile(fs.readFileSync(new URL('apps/web/src/utils/browserScheduling.ts',root),'utf8'));
const script=`const schedule=(()=>{const exports={};${scheduling};return exports;})();
const make=code=>new Function('exports','yieldToBrowserTask',code+';return exports;')({},schedule.yieldToBrowserTask);
const old=make(${JSON.stringify(before.replaceAll('li3d-verified-merge-preparation-v1','li3d-cache-write-benchmark'))});
const current=make(${JSON.stringify(after.replaceAll('li3d-verified-merge-preparation-v1','li3d-cache-write-benchmark'))});
document.querySelector('button').onclick=async()=>{
 const out=document.querySelector('pre');out.textContent='Running';
 try {
 const imageData=new ImageData(4096,4096);
 for(let i=0;i<imageData.data.length;i++)imageData.data[i]=(i*37+(i>>>16))&255;
 const result={report:{width:4096,height:4096},bakedTexture:{id:'benchmark'},imageData};
 const results=[];
 for(const [name,api] of [['old',old],['new',current],['new',current],['old',old]]){
  await new Promise(r=>setTimeout(r,250));
  let running=true,previous=performance.now(),maximum=0;const tick=t=>{maximum=Math.max(maximum,t-previous);previous=t;if(running)requestAnimationFrame(tick);};
  requestAnimationFrame(tick);const started=performance.now();await api.writePersistentMerge(name,result);const duration=performance.now()-started;
  await new Promise(requestAnimationFrame);running=false;
  const restored=await api.readPersistentMerge(name,4096);let differences=0;
  if(!restored)throw Error('Cache write/read failed');
  for(let i=0;i<imageData.data.length;i++)if(imageData.data[i]!==restored.imageData.data[i])differences++;
  results.push({name,durationMs:duration,maxFrameMs:maximum,differences});out.textContent=JSON.stringify(results,null,2);
 }
 await caches.delete('li3d-cache-write-benchmark');out.dataset.complete='true';
 }catch(error){out.textContent=String(error);}
};`;
fs.writeFileSync(new URL('apps/web/dist/cache-write-benchmark.html',root),`<!doctype html><html><meta charset="utf-8"><title>4K Cache Write A/B</title><button>Run 4K cache A/B</button><pre>Ready</pre><script>${script.replaceAll('</script','<\\/script')}</script></html>`);
