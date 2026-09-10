import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
const read=file=>fs.readFileSync(new URL('../src/engine/'+file,import.meta.url),'utf8');
const compile=(source,scope)=>{
  const exports={};
  const code=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
  new Function('exports',...Object.keys(scope),code)(exports,...Object.values(scope));return exports;
};
const pins=new Map(),resources=new Set(),revoked=new Set();let serial=0,pause,fail=false,adoptions=0;
const dependency={
  retainPreviewTexture(url){pins.set(url,(pins.get(url)??0)+1);let released=false;return()=>{
    assert(!released);released=true;const n=pins.get(url)-1;if(n) pins.set(url,n);else pins.delete(url);
  };},
  async prewarmPreviewTextures([url],options){resources.add(url);if(pause) await pause;
    if(options.shouldCancel()) throw new Error('cancelled');if(fail) throw new Error('failed');
    return [{status:'fulfilled'}];},
  promotePreparedPreviewTexture(url,assetUrl){assert(resources.delete(url));resources.add(assetUrl);adoptions++;return true;},
  releasePreviewTexture(url){resources.delete(url);},
};
const urlApi={createObjectURL:()=>`blob:${++serial}`,revokeObjectURL:url=>{assert(!revoked.has(url));revoked.add(url);}};
const api=compile(read('bake/preparedMergePreview.ts'),{require:()=>dependency,URL:urlApi,document:{body:{dataset:{}}}});
const a=new Blob(['exact']),b=new Blob(['other']);
await api.prepareMergePreview(a);await api.prepareMergePreview(a);assert.equal(serial,1);
assert.equal(api.adoptPreparedMergePreview(b,'asset:wrong'),false);
assert.equal(api.adoptPreparedMergePreview(a,'asset:verified'),true);
api.clearPreparedMergePreview();assert(resources.has('asset:verified'));assert.equal(pins.size,0);
await api.prepareMergePreview(a);api.clearPreparedMergePreview();assert.equal(pins.size,0);
let resume;pause=new Promise(resolve=>{resume=resolve;});
const pending=api.prepareMergePreview(b);api.clearPreparedMergePreview();resume();
await assert.rejects(pending,/cancelled/);assert.equal(pins.size,0);assert.equal(resources.size,1);pause=undefined;
fail=true;await assert.rejects(api.prepareMergePreview(b),/failed/);assert.equal(pins.size,0);fail=false;
assert.equal(adoptions,1);assert.equal(revoked.size,serial);

// Exercise the real map move with a renderer-ready source and exclusive owner.
const cacheSource=read('viewport/previewTextureCache.ts');
const ast=ts.createSourceFile('cache.ts',cacheSource,ts.ScriptTarget.Latest,true);
const node=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='promotePreparedPreviewTexture');
const texture={userData:{}},promise=Promise.resolve(texture),renderer={getContext:()=>({isContextLost:()=>false}),properties:{get:()=>({__webglTexture:{}})}};
const cache=new Map([['blob:source',promise]]),resident=new Map([['blob:source',texture]]),owners=new Map([['blob:source',1]]);
const readiness=new WeakMap([[texture,new WeakSet([renderer])]]);
const promote=compile(node.getText(ast),{registeredPreviewRenderer:renderer,residentPreviewTextureCache:resident,
  bakedTextureCache:cache,pinnedPreviewTextureCacheKeys:owners,previewTextureReadyRenderers:readiness}).promotePreparedPreviewTexture;
owners.set('blob:source',2);assert.equal(promote('blob:source','asset:new'),false);owners.set('blob:source',1);
resident.set('asset:new',{});assert.equal(promote('blob:source','asset:new'),false);resident.delete('asset:new');
renderer.getContext=()=>({isContextLost:()=>true});assert.equal(promote('blob:source','asset:new'),false);
renderer.getContext=()=>({isContextLost:()=>false});
assert.equal(promote('blob:source','asset:new'),true);
assert.equal(cache.get('asset:new'),promise);assert.equal(resident.get('asset:new'),texture);
assert(!cache.has('blob:source'));assert(!resident.has('blob:source'));
assert.equal(texture.userData.liclickPreviewCacheKey,'asset:new');assert(readiness.get(texture).has(renderer));
console.log('Prepared GPU preview: exact Blob identity, one owner, cancellation/failure cleanup, no alias/disposal, occupied target and context loss guards passed.');
