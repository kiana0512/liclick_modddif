import assert from 'node:assert/strict';
import {createServer,request} from 'node:http';
import {readFile, writeFile} from 'node:fs/promises';
import {handleImportUvRepair, validateRepairGlb} from '../dist/routes/importUvRepair.js';
import {importDecimateScript} from '../dist/services/importDecimateScript.js';

assert.match(importDecimateScript, /if total <= 1500000:/);
assert.match(importDecimateScript, /merge_distance = 0\.0001/);
const mergeIndex=importDecimateScript.indexOf('bpy.ops.mesh.remove_doubles(');
assert.ok(mergeIndex>importDecimateScript.indexOf('if total <= 1500000:'));
assert.ok(mergeIndex<importDecimateScript.indexOf('modifier = obj.modifiers.new('));
assert.match(importDecimateScript.slice(mergeIndex), /counts = \[count\(obj\) for obj in meshes\]/);
assert.match(importDecimateScript, /0\.99 <= area\/original_area <= 1\.01/);
assert.match(importDecimateScript, /'version': '1\.1\.0'/);

// Count-only QA misses the non-indexed FBX → GLB regression: scattered triangles
// can hit 200k while removing most of the visible surface. Compare real geometry.
function surfaceArea(bytes){
 const jsonSize=bytes.readUInt32LE(12),model=JSON.parse(bytes.toString('utf8',20,20+jsonSize));
 const bin=28+jsonSize;
 const accessor=id=>{
  const a=model.accessors[id],view=model.bufferViews[a.bufferView],start=bin+(view.byteOffset??0)+(a.byteOffset??0);
  const size=a.componentType===5126||a.componentType===5125?4:a.componentType===5123?2:1;
  const width=a.type==='VEC3'?3:1,stride=view.byteStride??width*size;
  return {count:a.count,get:(i,c=0)=>{const p=start+i*stride+c*size;return a.componentType===5126?bytes.readFloatLE(p):size===4?bytes.readUInt32LE(p):size===2?bytes.readUInt16LE(p):bytes.readUInt8(p);}};
 };
 let area=0,triangles=0;
 for(const mesh of model.meshes)for(const p of mesh.primitives){
  const pos=accessor(p.attributes.POSITION),index=p.indices===undefined?undefined:accessor(p.indices);
  for(let i=0;i<(index?.count??pos.count);i+=3){
   const ids=[0,1,2].map(j=>index?index.get(i+j):i+j);
   const ab=[0,1,2].map(c=>pos.get(ids[1],c)-pos.get(ids[0],c)),ac=[0,1,2].map(c=>pos.get(ids[2],c)-pos.get(ids[0],c));
   area+=Math.hypot(ab[1]*ac[2]-ab[2]*ac[1],ab[2]*ac[0]-ab[0]*ac[2],ab[0]*ac[1]-ab[1]*ac[0])/2;triangles++;
  }
 }
 return {area,triangles};
}

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
 const decimate=base.replace('/repair','/api/asset-processing/import-decimate');
 assert.equal((await fetch(decimate,{method:'POST',body:'not consented'})).status,400);
 assert.equal((await fetch(decimate+'?consent=change-uv-v1',{method:'POST',body:'UV consent is not topology consent'})).status,400);
 assert.equal((await fetch(base+'?consent=change-topology-v1',{method:'POST',body:'topology consent is not UV consent'})).status,400);
 if(process.env.DECIMATE_INPUT){
  const source=await readFile(process.env.DECIMATE_INPUT);
  const response=await fetch(decimate+'?consent=change-topology-v1',{method:'POST',body:source});
  if(!response.ok)throw Error(await response.text());
  const bytes=Buffer.from(await response.arrayBuffer());validateRepairGlb(bytes);
  const before=surfaceArea(source),after=surfaceArea(bytes),ratio=after.area/before.area;
  assert.ok(after.triangles>=198000&&after.triangles<=202000,'target triangle count');
  assert.ok(ratio>=0.95&&ratio<=1.05,'surface retained; disconnected triangles must not disappear: '+ratio);
  if(process.env.DECIMATE_BROKEN_OUTPUT){
   const broken=surfaceArea(await readFile(process.env.DECIMATE_BROKEN_OUTPUT));
   assert.ok(broken.area/before.area<0.95,'regression fixture must expose the old holes');
   console.log('Old output surface ratio: '+broken.area/before.area);
  }
  console.log('Decimation surface regression: '+JSON.stringify({input:before,output:after,retainedAreaRatio:ratio}));
  if(process.env.DECIMATE_OUTPUT)await writeFile(process.env.DECIMATE_OUTPUT,bytes);
  console.log('Real Blender HTTP decimation returned verified embedded GLB ('+bytes.length+' bytes).');
 }
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
