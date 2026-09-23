import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'vite';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE
  ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const root = fileURLToPath(new URL('..', import.meta.url));
const server = await createServer({ root, configFile: false,
  plugins: [{ name: 'uv-alpha-test-page', configureServer(server) {
    server.middlewares.use('/__fixture', (_req, res) => {
      res.setHeader('Content-Type', 'text/html');
      res.end('<!doctype html><link rel="icon" href="data:,"><title>UV alpha edge regression</title>');
    });
  } }],
  cacheDir: 'node_modules/.vite-uv-alpha-edge-fixture',
  optimizeDeps: { noDiscovery: true, include: ['three', 'fflate', 'zustand', 'zustand/middleware', 'react', 'react/jsx-runtime', 'react/jsx-dev-runtime'] },
  resolve: { alias: { '@': `${root}/src` } },
  server: { host: '127.0.0.1', port: 0, watch: { ignored: () => true } },
});
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage();
  for (const path of ['**/api/local-settings', '**/api/identity/status', '**/__li3d_eraser_perf'])
    await page.route(path, route => route.fulfill({ json: {} }));
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('response', response => { if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`); });
  await page.goto(server.resolvedUrls.local[0] + '__fixture');
  const result = await page.evaluate(async () => {
    const THREE = await import('/node_modules/three/build/three.module.js');
    const { createUvOverlayPreviewMaterial } = await import('/src/engine/projection/ProjectedLayerMaterial.ts');
    const { createPatches } = await import('/src/engine/paint/uvPatches.ts');
    const renderer = new THREE.WebGLRenderer(); renderer.setSize(256,256);
    const target = new THREE.WebGLRenderTarget(256,256);
    const scene = new THREE.Scene(), camera = new THREE.OrthographicCamera(-1,1,1,-1,.1,10); camera.position.z=2;
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2,2)); scene.add(mesh);
    const read = () => { renderer.setRenderTarget(target);renderer.render(scene,camera);const data=new Uint8Array(4);renderer.readRenderTargetPixels(target,128,128,1,1,data);return [...data]; };
    const texture = new THREE.DataTexture(new Uint8Array([40,40,40,64]),1,1);texture.needsUpdate=true;
    const halos=[];
    for (const slot of ['baseTexture','uvOverlayTexture','liveUvOverlayTexture']) {
      mesh.material=createUvOverlayPreviewMaterial({displayMode:'flat',showEmptyUvChecker:false,[slot]:texture});
      const display=read();
      if (Math.max(...display.slice(0,3))>90) throw Error('White fringe in '+slot+': '+display);
      mesh.material.uniforms.showEmptyProjectionHatch.value=2;
      const capture=read();
      if (capture[0]<=display[0]) throw Error('Capture background unexpectedly changed');
      halos.push({slot,display,capture});mesh.material.dispose();
    }
    const canvas=document.createElement('canvas');canvas.width=canvas.height=4096;
    const ctx=canvas.getContext('2d');ctx.fillStyle='#ff0000';ctx.fillRect(0,0,4096,4096);
    const map=new THREE.CanvasTexture(canvas);map.generateMipmaps=false;map.minFilter=THREE.LinearFilter;
    mesh.material=new THREE.MeshBasicMaterial({map});renderer.initTexture(map);
    const patches=createPatches();const version=map.version;
    ctx.clearRect(2032,2032,32,32);ctx.fillStyle='#0000ff';ctx.fillRect(2032,2032,32,32);
    patches.add(map,{x:2032,y:2032,width:32,height:32});patches.flush(renderer,map);
    const patched=read();if(patched[2]<240 || patched[0]>5 || map.version!==version)throw Error('Dirty upload failed '+patched);
    // Asymmetric upper-left patch catches texture-origin reversal.
    ctx.fillStyle='#00ff00';ctx.fillRect(0,0,128,128);patches.add(map,{x:0,y:0,width:128,height:128});patches.flush(renderer,map);
    renderer.render(scene,camera);const corner=new Uint8Array(4);renderer.readRenderTargetPixels(target,0,255,1,1,corner);
    if(corner[1]<240 || corner[0]>5)throw Error('Patch orientation failed '+corner);
    patches.dispose();map.dispose();texture.dispose();mesh.material.dispose();mesh.geometry.dispose();target.dispose();renderer.dispose();
    return {halos,patched,corner:[...corner],fullTextureRevisionUnchanged:true};
  });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify(result));
} finally { await browser?.close(); await server.close(); }
