import assert from 'node:assert/strict';
import {createServer,request} from 'node:http';
import {readFile, writeFile} from 'node:fs/promises';
import {handleImportUvRepair, validateRepairGlb} from '../dist/routes/importUvRepair.js';

function glb(json){
 const text=Buffer.from(JSON.stringify(json)), padded=Buffer.alloc(Math.ceil(text.length/4)*4,32);text.copy(padded);
 const header=Buffer.alloc(20);header.write('glTF');header.writeUInt32LE(2,4);header.writeUInt32LE(20+padded.length,8);header.writeUInt32LE(padded.length,12);header.writeUInt32LE(0x4e4f534a,16);
 return Buffer.concat([header,padded]);
}
assert.throws(()=>validateRepairGlb(Buffer.from('not a GLB')),/完整 GLB/);
assert.throws(()=>validateRepairGlb(glb({buffers:[{uri:'../../private.bin'}]})),/内嵌/);
assert.throws(()=>validateRepairGlb(glb({images:[{uri:'https://example.com/image.png'}]})),/内嵌/);
assert.throws(()=>validateRepairGlb(glb({skins:[{}]})),/骨骼/);
assert.throws(()=>validateRepairGlb(glb({meshes:[{primitives:[{targets:[{}]}]}]})),/形态键/);
validateRepairGlb(glb({asset:{version:'2.0'},buffers:[{byteLength:0}],images:[{uri:'data:image/png;base64,AA=='}]}));
const server=createServer((req,res)=>{void handleImportUvRepair(req,res,new URL(req.url,'http://127.0.0.1'));});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${server.address().port}/repair`;
try{
 assert.equal((await fetch(base)).status,405);
 assert.equal((await fetch(base,{method:'POST',body:'not consented'})).status,400);
 assert.equal((await fetch(base+'?consent=false',{method:'POST',body:'not consented'})).status,400);
 if(process.env.UV_REPAIR_INPUT){
  const response=await fetch(base+'?consent=change-uv-v1',{method:'POST',body:await readFile(process.env.UV_REPAIR_INPUT)});
  if(!response.ok)throw Error(await response.text());
  assert.equal(response.headers.get('content-type'),'model/gltf-binary');
  const bytes=Buffer.from(await response.arrayBuffer());validateRepairGlb(bytes);
  if(process.env.UV_REPAIR_OUTPUT)await writeFile(process.env.UV_REPAIR_OUTPUT,bytes);
  console.log('Real Blender HTTP repair returned verified embedded GLB ('+bytes.length+' bytes).');
  // An unfinished upload owns the bounded slot; client cancellation must release it.
  const held=request(base+'?consent=change-uv-v1',{method:'POST',headers:{'content-length':'1024'}});
  held.on('error',()=>{});held.flushHeaders();
  await new Promise(resolve=>setTimeout(resolve,100));
  assert.equal((await fetch(base+'?consent=change-uv-v1',{method:'POST',body:'bad'})).status,429);
  held.destroy();
  let status=429;
  for(let i=0;i<30&&status===429;i++){
    await new Promise(resolve=>setTimeout(resolve,100));
    status=(await fetch(base+'?consent=change-uv-v1',{method:'POST',body:'bad'})).status;
  }
  assert.equal(status,422,'cancelled upload releases repair capacity');
 }
 console.log('Import UV server: GLB format, external resource rejection, unsupported deformation, method and explicit consent gates passed.');
}finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
