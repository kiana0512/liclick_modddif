// Compare a plain Blender GLB round trip with Smart UV output. Input files are read-only.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
const [before,after,minimumArea='0.1']=process.argv.slice(2);
assert(before && after, 'Usage: node check-import-uv-smart-result.mjs baseline.glb smart.glb [minimumUvArea]');
function inspect(file){
 const data=fs.readFileSync(file),jsonLength=data.readUInt32LE(12),json=JSON.parse(data.toString('utf8',20,20+jsonLength));
 const bin=data.subarray(28+jsonLength);
 const components={SCALAR:1,VEC2:2,VEC3:3,VEC4:4};
 function get(id){const a=json.accessors[id],v=json.bufferViews[a.bufferView],size={5121:1,5123:2,5125:4,5126:4}[a.componentType],n=components[a.type];return{count:a.count,read(i){const at=(v.byteOffset??0)+(a.byteOffset??0)+i*(v.byteStride??size*n);return Array.from({length:n},(_,j)=>a.componentType===5126?bin.readFloatLE(at+j*size):bin.readUIntLE(at+j*size,size));}};}
 const geometry=[],normals=[];let triangles=0,uvArea=0,outside=0,degenerate=0;
 for(const m of json.meshes)for(const p of m.primitives){
 const pos=get(p.attributes.POSITION),n=get(p.attributes.NORMAL),uv=get(p.attributes.TEXCOORD_0),idx=p.indices==null?null:get(p.indices);
 for(let i=0;i<(idx?.count??pos.count);i+=3){
  const ids=[0,1,2].map(j=>idx?idx.read(i+j)[0]:i+j);triangles++;
  geometry.push(ids.map(k=>pos.read(k).join(',')).join(';'));
  normals.push({key:geometry.at(-1),values:ids.flatMap(k=>n.read(k))});
  const [a,b,c]=ids.map(k=>uv.read(k));
  if([...a,...b,...c].some(x=>!Number.isFinite(x)||x<0||x>1))outside++;
  const d=(b[0]-a[0])*(c[1]-a[1])-(c[0]-a[0])*(b[1]-a[1]);if(d===0)degenerate++;uvArea+=Math.abs(d)/2;
 }
 }
 const hash=items=>createHash('sha256').update(items.sort().join('\n')).digest('hex');
 return{triangles,uvArea,outside,degenerate,geometry:hash(geometry),normals:normals.sort((a,b)=>a.key.localeCompare(b.key)),nodes:json.nodes};
}
const a=inspect(before),b=inspect(after);
assert.equal(a.triangles,b.triangles);assert.equal(a.geometry,b.geometry);let maxNormalError=0;for(let i=0;i<a.normals.length;i++){assert.equal(a.normals[i].key,b.normals[i].key);for(let j=0;j<9;j++)maxNormalError=Math.max(maxNormalError,Math.abs(a.normals[i].values[j]-b.normals[i].values[j]));}assert(maxNormalError<2e-6, String(maxNormalError));assert.equal(b.outside,0);assert.equal(b.degenerate,0);assert(b.uvArea>Number(minimumArea));
console.log(JSON.stringify({before:{triangles:a.triangles,uvArea:a.uvArea},after:{triangles:b.triangles,uvArea:b.uvArea,outside:b.outside,degenerate:b.degenerate},geometryExact:true,maxNormalError}));
