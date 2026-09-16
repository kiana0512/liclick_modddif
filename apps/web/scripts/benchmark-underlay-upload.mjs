import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
const dist=path.resolve(import.meta.dirname,'../dist');
const baseline=process.argv[2];
if(!baseline)throw Error('Pass the previous built, standalone RGBA worker path.');
const baselineBytes=fs.readFileSync(baseline);
const baselineName=`underlay-baseline-${createHash('sha256').update(baselineBytes).digest('hex').slice(0,16)}.js`;
fs.writeFileSync(path.join(dist,baselineName),baselineBytes);
const current=fs.readdirSync(path.join(dist,'assets')).find(file=>file.startsWith('webGpuRgbaComposite.worker-'));
fs.writeFileSync(path.join(dist,'underlay-upload-benchmark.html'),`<!doctype html><html><meta charset="utf-8"><title>UV underlay transport A/B</title><button>Test 4K UV underlay</button><pre>Ready</pre><script>
document.querySelector('button').onclick=async()=>{
 const out=document.querySelector('pre');out.textContent='Running';const rows=[];
 const canvas=document.createElement('canvas');canvas.width=canvas.height=4096;
 const ctx=canvas.getContext('2d');ctx.fillStyle='#638fa7';ctx.fillRect(0,0,4096,4096);
 const blob=await new Promise(r=>canvas.toBlob(r,'image/png'));const url=URL.createObjectURL(blob);
 try {for(const [label,src] of [['old','/${baselineName}'],['new','/assets/${current}']]){
  const worker=new Worker(src,{type:'module'});
  try {for(let run=0;run<3;run++){
   const front=new Uint8Array(4096*4096*4);
   for(let i=0;i<front.length;i+=4){front[i]=(i>>>2)&255;front[i+1]=(i>>>10)&255;front[i+2]=137;front[i+3]=(i>>>2)%3===0?0:255;}
   const response=await new Promise((resolve,reject)=>{worker.onmessage=e=>e.data.type==='error'?reject(Error(e.data.message)):resolve(e.data);worker.onerror=reject;
    worker.postMessage({type:'composite',id:run+1,front:front.buffer,underlayUrl:url,width:4096,height:4096,opacity:1,
     interactive:false,interactiveChunkBytes:1048576,idleChunkBytes:8388608,verify:true},[front.buffer]);});
   rows.push({label,run,...response.metrics,verification:response.verification});out.textContent=JSON.stringify(rows,null,2);
   if(response.verification?.byteMismatches)throw Error('GPU/CPU mismatch');
  }}finally{worker.terminate();}
 }}catch(error){out.textContent+='\\nERROR '+error;}finally{URL.revokeObjectURL(url);canvas.width=canvas.height=1;out.dataset.complete='true';}
};</script></html>`);
