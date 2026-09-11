import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { readFile, writeFile } from 'node:fs/promises';
const require = createRequire(import.meta.url);
const { createServer } = require('vite');
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright'
);
const root = fileURLToPath(new URL('..', import.meta.url))
  .replaceAll('\\', '/')
  .replace(/\/$/, '');
let fixture = await readFile(root + '/scripts/uv-repaint-viewport-fixture.mjs', 'utf8');
const testResolution = process.env.LICLICK_UV_TEST_RESOLUTION ?? '1K';
assert(['1K', '2K', '4K'].includes(testResolution));
fixture = fixture.replace("resolution: '1K'", `resolution: '${testResolution}'`);
fixture = fixture
  .slice(0, fixture.indexOf("  const source = document.createElement('canvas');"))
  .replaceAll("'../src/", "'/src/");
fixture += String.raw`
  await new Promise(resolve=>setTimeout(resolve,1500));
  const center = new THREE.Box3().setFromObject(group).getCenter(new THREE.Vector3());
  runtime.controls.target.copy(center); runtime.camera.position.copy(center).add(new THREE.Vector3(0,0,5)); runtime.camera.lookAt(center); runtime.controls.update(); runtime.camera.updateMatrixWorld();
  const mesh=group.children.find(child=>child.isMesh); const original=[];
  for(let i=0;i<5;i++){
    const c=document.createElement('canvas');c.width=c.height=128;
    const ctx=c.getContext('2d');ctx.fillStyle=['#ce753b','#b9a829','#306e9a','#aa3939','#659354'][i];
    ctx.fillRect(0,0,128,128);
    original.push({id:(i>=3?'local-repaint-toggle-':'toggle-')+i,objectId:object.id,name:'Layer '+i,type:'projected',
      role:i>=3?'local-repaint-overlay':undefined,imageUrl:c.toDataURL(),
      camera:serializeCamera(runtime.camera,1,new THREE.Vector3()),order:i,
      visible:true,opacity:i>=3?.65:1,strength:1,blendMode:'normal'});
  }
  useLayerStore.setState({layers:original});
  const state=()=>({uuid:mesh.material.uuid,name:mesh.material.name,
    bindings:mesh.material.userData.liclickResidentUvProjectionLayers,
    uvPixel:document.body.dataset.residentUvPixel, baseEnabled:mesh.material.uniforms?.useBaseMap?.value, rasterHits:document.body.dataset.residentUvRasterHits, stages:document.body.dataset.residentUvProjectionStages, opacity:Object.fromEntries(Object.entries(mesh.material.uniforms??{}).filter(([k])=>/layerOpacity/.test(k)).map(([k,v])=>[k,v.value])),
    builds:Number(document.body.dataset.projectedMaterialBuildRevision??0)});
  const pixels=()=>{
    runtime.gl.setRenderTarget(null);runtime.gl.render(runtime.scene,runtime.camera);
    const g=runtime.gl.getContext(), p=new Uint8Array(64*64*4);
    g.readPixels(Math.floor(g.drawingBufferWidth/2)-32,Math.floor(g.drawingBufferHeight/2)-32,64,64,g.RGBA,g.UNSIGNED_BYTE,p);
    return Array.from(p);
  };
  const set=(count)=>useLayerStore.setState({layers:original.map((l,i)=>({...l,visible:i<count}))});
  const settled=async(count)=>{
    for(let j=0;j<2400;j++){
      await tick();const s=state();
      if(count===0?s.name==='LiclickWhiteMembranePreview':
        s.name==='LiclickUvOverlayPreview' && s.bindings?.length===count &&
        original.slice(0,count).every(l=>s.bindings.includes(l.id))){
        await tick();await tick();return;
      }
    }throw Error('Not settled '+count+' '+JSON.stringify(state()));
  };
  await settled(5);
  window.toggleFixture={state,pixels,set,settled,close:()=>root.unmount(), async mergedBoundary() {
    const before=pixels();
    const canvas=document.createElement('canvas');canvas.width=canvas.height=16;
    const context=canvas.getContext('2d');context.fillStyle='#00ffdd';context.fillRect(0,0,16,16);
    const merged={id:'fixture-merged',objectId:object.id,name:'Merged UV',type:'uv',role:'merged-uv',
      imageUrl:canvas.toDataURL(),order:-1,visible:true,opacity:1,blendMode:'normal'};
    useLayerStore.setState({layers:[merged,...original]});
    await until(()=>mesh.material.name==='LiclickUvOverlayPreview' && !state().bindings,'merged UV presentation');
    useLayerStore.setState({layers:[{...merged,visible:false},...original]});
    await settled(5);
    const after=pixels();if(before.some((value,index)=>value!==after[index]))throw Error('Hiding merged UV failed to restore the projection buffer');
  }, async geometryModes() {
    const sampler=mesh.material.uniforms.uvOverlayOpacity.value>0?'uvOverlayMap':'baseMap';
    const before=pixels(), texture=mesh.material.uniforms[sampler].value;
    for(const mode of ['normal','wire','flat']) {
      useSceneStore.setState({displayMode:mode});
      await until(()=>mesh.material.name==='LiclickUvOverlayPreview' &&
        mesh.material.uniforms.normalPreviewEnabled?.value===(mode==='normal'?1:0) &&
        mesh.material.uniforms.wirePreviewEnabled?.value===(mode==='wire'?1:0),'geometry mode '+mode);
      if(mesh.material.uniforms[sampler].value!==texture)throw Error('Geometry mode lost the UV capture buffer');
    }
    const after=pixels();
    if(before.some((value,index)=>value!==after[index]))throw Error('Geometry mode round trip changed UV pixels');
  }, async islandEdge() {
    const {rasterizeUvTopologyMask}=await import('/src/engine/bake/dilation.ts');
    const {rasterizeUvTopologyMaskWithWebGpu}=await import('/src/engine/bake/webGpuUvTopologyRaster.ts');
    const fullUv=new THREE.Group();fullUv.add(new THREE.Mesh(new THREE.PlaneGeometry()));
    const topology=rasterizeUvTopologyMask(fullUv,8,8),workerTopology=await rasterizeUvTopologyMaskWithWebGpu(fullUv,8,8);
    if(topology.some(value=>value!==1)||workerTopology.mask.some(value=>value!==1))throw Error('UV=1 must reach the atlas boundary; last row/column cannot be lost');
    fullUv.children[0].geometry.dispose();fullUv.children[0].material.dispose();
    const {createUvOverlayPreviewMaterial,markSparseAlphaBaseTexture}=await import('/src/engine/projection/ProjectedLayerMaterial.ts');
    const {createWorkerBackedPreviewTexture,uploadPreviewTextureInStripes,releaseTransientPreviewUploadSource}=await import('/src/engine/viewport/previewTextureCache.ts');
    const rgba=new Uint8ClampedArray([32,50,70,255,32,50,70,0]);
    const texture=new THREE.DataTexture(new Uint8Array(rgba),2,1);
    markSparseAlphaBaseTexture(texture);
    const bitmap=await createImageBitmap(new ImageData(rgba,2,1),{imageOrientation:'flipY',premultiplyAlpha:'none'});
    const uploaded=await createWorkerBackedPreviewTexture(bitmap);markSparseAlphaBaseTexture(uploaded);
    await uploadPreviewTextureInStripes(runtime.gl,uploaded);releaseTransientPreviewUploadSource(runtime.gl,uploaded);
    const geometry=new THREE.PlaneGeometry(1,1), scene=new THREE.Scene();
    const camera=new THREE.OrthographicCamera(-.5,.5,.5,-.5,.1,10);camera.position.z=1;
    const target=new THREE.WebGLRenderTarget(64,64), previous=runtime.gl.getRenderTarget();
    const sample=resident=>{
      const material=createUvOverlayPreviewMaterial({displayMode:'flat',selected:false,
        uvOverlayTexture:resident?uploaded:texture});
      const plane=new THREE.Mesh(geometry,material);scene.add(plane);
      runtime.gl.setRenderTarget(target);runtime.gl.render(scene,camera);
      const pixel=new Uint8Array(64*64*4);runtime.gl.readRenderTargetPixels(target,0,0,64,64,pixel);
      scene.remove(plane);material.dispose();return [...pixel];
    };
    const manual=sample(false), resident=sample(true);
    runtime.gl.setRenderTarget(previous);target.dispose();geometry.dispose();texture.dispose();uploaded.dispose();
    const maximumDifference=Math.max(...manual.map((value,index)=>Math.abs(value-resident[index])));
    if(maximumDifference>1)throw Error('Resident island edge differs from merged UV: '+maximumDifference);
    return {maximumDifference};
  }, async compressedRoundTrip() {
    const before = pixels();
    const update = async layers => {
      const previous = document.body.dataset.residentUvProjectionRevision;
      useLayerStore.setState({layers});
      await until(()=>document.body.dataset.residentUvProjectionRevision!==previous && document.body.dataset.residentUvProjectionStatus==='ready','new UV state');
      await tick(); await tick();
    };
    for(let index=0;index<10;index++) await update(original.map((layer,i)=>i===0?{...layer,opacity:.4+index*.04}:layer));
    const started=performance.now(); await update(original);
    const elapsed=performance.now()-started;
    const stages=JSON.parse(document.body.dataset.residentUvProjectionStages??'{}');
    if(!('compressedUvRestoreMs' in stages))throw Error('Evicted UV was recalculated instead of losslessly restored');
    const after=pixels();
    if(before.some((value,index)=>value!==after[index]))throw Error('Compressed UV restore changed pixels');
    return {elapsed,stages};
  }, async interact() {
    const revision=document.body.dataset.residentUvProjectionRevision;
    const uuid=mesh.material.uniforms.baseMap.value.uuid;
    const frames=[]; let previous=performance.now();
    for(let i=0;i<90;i++) {
      const angle=i*.01, radius=5+Math.sin(i*.1)*.2;
      runtime.controls.target.copy(center).add(new THREE.Vector3(Math.sin(i*.05)*.1,0,0));
      runtime.camera.position.copy(runtime.controls.target).add(new THREE.Vector3(Math.sin(angle)*radius,0,Math.cos(angle)*radius));
      runtime.controls.update(); await tick();
      const now=performance.now();frames.push(now-previous);previous=now;
      if(mesh.material.name!=='LiclickUvOverlayPreview' || mesh.material.uniforms.baseMap.value.uuid!==uuid) throw Error('Interaction replaced the resident UV buffer');
    }
    if(revision!==document.body.dataset.residentUvProjectionRevision) throw Error('Camera motion recomputed UV');
    return {revision,frames};
  }};
}
`;
const server = await createServer({
  root,
  configFile: false,
  plugins: [
    {
      name: 'toggle-fixture',
      configureServer(s) {
        s.middlewares.use('/__fixture', (_, res) => {
          res.setHeader('Content-Type', 'text/html');
          res.end(
            '<!doctype html><title>LI3D layer visibility QA</title><div>Layer visibility QA</div>',
          );
        });
      },
      resolveId(id) {
        if (id === '/__toggle.mjs') return root + '/__toggle.mjs';
      },
      load(id) {
        if (id === root + '/__toggle.mjs') return fixture;
      },
    },
  ],
  resolve: { alias: { '@': root + '/src' } },
  server: { host: '127.0.0.1', port: 0, hmr: false, watch: { ignored: ['**/*'] } },
  cacheDir: 'node_modules/.vite-toggle-qa',
  optimizeDeps: { entries: ['scripts/uv-repaint-viewport-fixture.mjs'] },
});
server.middlewares.use('/__toggle.mjs', (_, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.end(fixture);
});
server.middlewares.use('/__fixture', (_, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.end('<!doctype html><title>LI3D layer visibility QA</title><div>Layer visibility QA</div>');
});
await server.listen();
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1000, height: 720 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
  if (/^(RETAIN|TAKE|HIT|MISS)/.test(m.text())) console.log(m.text());
});
await page.route('**/api/**', (r) => r.fulfill({ json: {} }));
await page.route('**/__li3d_eraser_perf', (r) => r.fulfill({ json: {} }));
try {
  await page.goto(server.resolvedUrls.local[0] + '__fixture');
  await page
    .evaluate(async () => {
      await (await import('/__toggle.mjs')).setup();
    })
    .catch(async (e) => {
      console.log(errors);
      throw e;
    });
  const rows = [];
  const refs = {};
  for (const count of [5, 4, 3, 2, 1, 0, 1, 2, 3, 4, 5, 0, 1, 2, 3, 4, 5]) {
    const row = await page.evaluate(async (count) => {
      const f = window.toggleFixture,
        start = performance.now();
      f.set(count);
      await new Promise(window.requestAnimationFrame);
      await new Promise(window.requestAnimationFrame);
      const early = f.pixels(),
        earlyState = f.state(),
        earlyMs = performance.now() - start;
      await f.settled(count);
      return {
        count,
        earlyMs,
        ms: performance.now() - start,
        earlyState,
        final: f.state(),
        early,
        pixels: f.pixels(),
      };
    }, count);
    if (refs[count])
      row.finalDiff = row.pixels.reduce((n, v, i) => n + Number(v !== refs[count][i]), 0);
    else refs[count] = row.pixels;
    row.earlyDiff = row.early.reduce((n, v, i) => n + Number(v !== row.pixels[i]), 0);
    row.center = row.pixels.slice(8192, 8196);
    delete row.early;
    delete row.pixels;
    rows.push(row);
  }
  assert.deepEqual(errors, []);
  assert(
    rows
      .filter((row) => row.count > 0)
      .every((row) => row.final.name === 'LiclickUvOverlayPreview' && row.final.builds === 0),
  );
  assert(
    rows.filter((row) => row.finalDiff !== undefined).every((row) => row.finalDiff === 0),
    'Repeated states must have identical pixels',
  );
  assert(
    new Set(rows.slice(0, 6).map((row) => row.center.join(','))).size === 6,
    'Every visible stack must produce its own nonempty pixels',
  );
  const label = process.argv[2] ?? 'resident-uv';
  await page.screenshot({ path: tmpdir() + '/li3d-toggle-' + label + '.png' });
  await page.evaluate(() => window.toggleFixture.mergedBoundary());
  await page.evaluate(() => window.toggleFixture.geometryModes());
  const compressed = testResolution === '4K' ? await page.evaluate(() => window.toggleFixture.compressedRoundTrip()) : undefined;
  const interaction = await page.evaluate(() => window.toggleFixture.interact());
  const islandEdge = await page.evaluate(() => window.toggleFixture.islandEdge());
  const result = {
    url: page.url(),
    title: await page.title(),
    resolution: testResolution,
    errors,
    rows,
    interaction,
    compressed,
    islandEdge,
  };
  await writeFile(tmpdir() + '/li3d-toggle-' + label + '.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  await browser.close();
  await server.close();
}
