import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
const root = new URL('../src/', import.meta.url);
const read = (file) => fs.readFileSync(new URL(file, root), 'utf8');
const source = read('engine/localRepaint/modelSilhouetteClip.ts');
const js = ts.transpileModule(source.replace(/^import .*;$/gm, ''), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
class Pixels { constructor(data, width, height) { this.data=data;this.width=width;this.height=height; } }
const exports = {};
new Function('exports','ImageData',js)(exports,Pixels);
const clip = exports.clipRepaintToModelSilhouette;
const w=2048,h=16;
const color=new Pixels(new Uint8ClampedArray(w*h*4),w,h);
const depth=new Pixels(new Uint8ClampedArray(w*h*4).fill(255),w,h);
for(let y=2;y<14;y++)for(let x=10;x<50;x++){
 const p=(y*w+x)*4;depth.data[p]=100;color.data[p]=77;color.data[p+1]=42;
}
// A fully enclosed hole; RGB color must never determine geometry coverage.
for(let y=6;y<=8;y++)for(let x=27;x<=29;x++)depth.data[(y*w+x)*4]=255;
const original=new Uint8ClampedArray(color.data),originalDepth=new Uint8ClampedArray(depth.data);
const result=clip(color,depth),alpha=(x,y)=>result.data[(y*w+x)*4+3];
assert.equal(alpha(11,5),0);assert.equal(alpha(12,5),255);
assert.equal(alpha(47,5),255);assert.equal(alpha(48,5),0);
assert.equal(alpha(25,7),0);assert.equal(alpha(24,7),255);
assert.equal(alpha(31,7),0);assert.equal(alpha(32,7),255);
assert.equal(alpha(28,4),0);assert.equal(alpha(22,4),255);
assert.equal(result.width,w);assert.equal(result.height,h);
assert.deepEqual(color.data,original);assert.deepEqual(depth.data,originalDepth);
for(let p=0;p<result.data.length;p+=4)assert.deepEqual(result.data.slice(p,p+3),original.slice(p,p+3));
assert.throws(()=>clip(color,new Pixels(new Uint8ClampedArray(4),1,1)),/尺寸/);
assert.throws(()=>clip(color,new Pixels(new Uint8ClampedArray(w*h*4).fill(255),w,h)),/轮廓为空/);
// Border and very thin geometry are eroded, not artificially rescued/expanded.
depth.data.fill(255);for(let y=0;y<h;y++)depth.data[(y*w+100)*4]=0;
assert.equal(clip(color,depth).data.some((v,i)=>i%4===3&&v),false);
const panel=read('components/panels/GeneratePanel.tsx');
assert.match(panel,/prepareModelClippedRepaint\(\s*generation.resultUrl, capture.depthUrl, requestAbortController.signal/);
assert.match(panel,/cameraSnapshot: captureCameraSnapshot,\s*}, 2048\).catch/);
assert.match(panel,/rawResultUrl: generation.resultUrl/);
const editor=read('routes/EditorPage.tsx');
assert.equal((editor.match(/ignoreSourceAlpha: latestLocalRepaintGeneration.metadata.modelSilhouetteClipVersion !== 1/g)||[]).length,2);
const viewport=read('engine/viewport/ViewportCanvas.tsx');
assert.equal((viewport.match(/ignoreSourceAlpha: (?:localRepaintSource|source).ignoreSourceAlpha \?\? true/g)||[]).length,4);
assert.match(viewport,/ignoreSourceAlpha: activePaintLayer.ignoreSourceAlpha/);
assert.match(read('engine/bake/bakeProjectedLayerToTexture.ts'),/ignoreSourceAlpha: layer.ignoreSourceAlpha \?\? localRepaint/);
assert.match(read('engine/bake/uvRasterizer.ts'),/ignoreSourceAlpha \? 1 : color\[3\] \/ 255/);
// Both flattening entry points must retain the viewport's authored alpha rule.
for (const path of ['engine/bake/mergeProjectionPreparation.ts', 'engine/export/texturedExportUtils.ts']) {
  assert.match(read(path), /createProjectionMaskedImage\(layer.imageUrl, layer.maskUrl,\s*\{\s*ignoreSourceAlpha: layer.ignoreSourceAlpha \?\? true/);
}
const maskModule = read('engine/projection/createMaskedProjectedImage.ts');
const maskAst = ts.createSourceFile('mask.ts', maskModule, ts.ScriptTarget.Latest, true);
const wrapperJs = ts.transpileModule(maskAst.statements.find(node => node.name?.text === 'createProjectionMaskedImage').getText(maskAst), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
for (const ignoreSourceAlpha of [false, true, undefined]) {
  const modes = [], scope = {};
  new Function('exports', 'loadImageData', 'imageDataToPngUrl', 'processMaskedProjectedImageInWorker', 'maxCutoutDimension', wrapperJs)(
    scope, async () => color, value => value, async (_source, _mask, mode) => { modes.push(mode); return color; }, 4096,
  );
  await scope.createProjectionMaskedImage('source', 'mask', { ignoreSourceAlpha });
  assert.deepEqual(modes, [ignoreSourceAlpha === false ? 'mask-only' : 'projection-alpha-only']);
}
console.log('Model silhouette clip: 2px outside/hole boundaries, RGB preservation, frame alignment, thin geometry, failure and projection/save/restore contracts passed.');
