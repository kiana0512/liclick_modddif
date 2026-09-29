import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import {createServer} from 'vite';
const server=await createServer({root:process.cwd(),appType:'custom',logLevel:'silent',server:{middlewareMode:true,watch:{ignored:()=>true}}});
try {
  const {resolvePixelCpu}=await server.ssrLoadModule('/src/engine/bake/qualityBlendCpuPixel.ts');
  const frozen=fs.readFileSync('scripts/fixtures/merge-diagnostic-before-sharing.ts','utf8');
  const oldExports={};
  new Function('exports',ts.transpileModule(frozen,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(oldExports);
  const baker=fs.readFileSync('src/engine/bake/bakeProjectedLayerToTexture.ts','utf8');
  const adapter=baker.slice(baker.indexOf('async function writeQualityBlendStackComposite'),baker.indexOf('async function applyOverlayRasters'));
  const next=new Function('resolvePixelCpu','yieldToBakeUi',ts.transpileModule(adapter,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText+';return writeQualityBlendStackComposite;')(resolvePixelCpu,async()=>{});
  let seed=75;const rand=()=>((seed=Math.imul(seed,1664525)+1013904223>>>0)/2**32);
  const n=1000, stack={colors:[],coverages:[],qualities:[],coverage:new Uint8Array(n).fill(1)};
  for(let k=0;k<3;k++) {
    stack.colors.push(Uint8ClampedArray.from({length:n*3},()=>rand()*255));
    stack.coverages.push(Float32Array.from({length:n},()=>rand()<.3?0:rand()));
    stack.qualities.push(Float32Array.from({length:n},()=>rand()));
  }
  for(const mode of [false,true,'display']) {
    const a={data:new Uint8ClampedArray(n*4)},b={data:new Uint8ClampedArray(n*4)};
    assert.equal(await next(stack,a,mode),await oldExports.writeQualityBlendStackComposite(stack,b,mode));
    assert.deepEqual(a.data,b.data,'diagnostic raster adapter must retain canonical bytes');
  }
  const {compositeRgbaUnderInPlace,getMergeUvPostprocessOptions}=await server.ssrLoadModule('/src/engine/layers/mergeUvComposition.ts');
  const {compositeLinearChannel}=await server.ssrLoadModule('/src/engine/layers/linearUnderComposite.ts');
  const source=fs.readFileSync('src/workers/webGpuRgbaComposite.worker.ts','utf8');
  const kernel=source.slice(source.indexOf('function compositeOnCpu('),source.indexOf('async function compositeOnCpuBudgeted'));
  assert.ok(kernel.length>0);
  const workerComposite=new Function('compositeLinearChannel',ts.transpileModule(kernel,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText+';return compositeOnCpu;')(compositeLinearChannel);
  assert.equal(getMergeUvPostprocessOptions(2048).preserveCoverageConfidenceAlpha,'display');
  const decode=c=>c<=.04045?c/12.92:((c+.055)/1.055)**2.4;
  const encode=c=>Math.round(255*(c<=.0031308?12.92*c:1.055*c**(1/2.4)-.055));
  for(const confidence of [.021,.03,.06,.09,.12,.5,1]) {
    const top={colors:[new Uint32Array([0x404040]),new Uint32Array(1),new Uint32Array(1)],coverages:[new Float32Array([confidence]),new Float32Array(1),new Float32Array(1)],qualities:[new Float32Array([confidence]),new Float32Array(1),new Float32Array(1)],coverage:new Uint8Array([1]),writtenTexels:1};
    const output=new Uint8ClampedArray(4);
    resolvePixelCpu(top,0,'display',output);
    const t=Math.min(1,top.coverages[0][0]/.12), a=Math.round(t*t*(3-2*t)*255);
    assert.equal(output[3],a);
    const under=new Uint8ClampedArray([192,192,192,255]);
    const worker=output.slice();workerComposite(worker.buffer,under.buffer,1);
    compositeRgbaUnderInPlace(output,under);
    assert.deepEqual(worker,output,'Worker/export CPU parity');
    assert.equal(output[0],encode(decode(64/255)*a/255+decode(192/255)*(1-a/255)));
    resolvePixelCpu(top,0,true,output);assert.equal(output[3],Math.round(top.coverages[0][0]*255),'repair retains raw confidence');
    resolvePixelCpu(top,0,false,output);assert.equal(output[3],255,'legacy opaque mode preserved');
  }
  const padding=new Uint8ClampedArray([10,20,30,0]);
  compositeRgbaUnderInPlace(padding,new Uint8ClampedArray([40,50,60,0]));
  assert.deepEqual([...padding],[10,20,30,0]);
  console.log('Display-edge alpha, linear underlay, raw-confidence separation, CPU/Worker and transparent padding passed.');
} finally {await server.close();}
