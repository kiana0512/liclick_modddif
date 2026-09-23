import assert from 'node:assert/strict';
import fs from 'node:fs';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {createServer} from 'vite';
const root = fileURLToPath(new URL('..', import.meta.url));
const {chromium} = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const source = fs.readFileSync(`${root}/src/engine/viewport/ViewportCanvas.tsx`, 'utf8');
const guard = source.match(/if \(paintTool === 'inpaint-apply' && event.pointerType === 'mouse' && event.button === 2\) \{[\s\S]*?\n {6}\}/)[0];
const pageSource = `<!doctype html><div id="surface" style="height:180px;background:#777">viewport input fixture</div><div id="dock"></div>
<script type="module">
import React from '/node_modules/.vite-brush-menu/deps/react.js';
import ReactDOM from '/node_modules/.vite-brush-menu/deps/react-dom_client.js';
import {BottomToolDock} from '/src/components/editor/BottomToolDock.tsx';
const labels = new Proxy({}, {get:(_o,key)=>key});
window.paintCount=0; window.selectCount=0;
const paintTool='inpaint-apply';
surface.addEventListener('pointerdown',event=>{if(event.altKey||event.button===1)return;${guard}if(event.button===0)window.paintCount++;},true);
surface.addEventListener('click',()=>window.selectCount++);
surface.addEventListener('contextmenu',event=>event.preventDefault());
ReactDOM.createRoot(document.getElementById('dock')).render(React.createElement(BottomToolDock,{
mode:'texture',transformMode:'select',paintTool, labels,canLocalRepaint:true,
localImageGenerationRunning:false,localImageGenerationSuccessKey:0,canUndo:false,canRedo:false,
onTransformModeChange(){},onPaintToolChange(){},onLocalImageGeneration(){},onLocalRepaint(){},onUndo(){},onRedo(){}
}));
</script>`;
const server = await createServer({root,configFile:false,cacheDir:'node_modules/.vite-brush-menu',
  resolve:{alias:{'@':`${root}/src`}}, esbuild:{jsx:'automatic'},
  optimizeDeps:{noDiscovery:true,include:['react','react-dom','react-dom/client','react/jsx-runtime','react/jsx-dev-runtime','lucide-react','zustand','zustand/middleware','three']},
  server:{host:'127.0.0.1',port:0,watch:{ignored:()=>true}},
  plugins:[{name:'brush-menu-fixture',configureServer(s){s.middlewares.use('/__fixture',(_q,r)=>{r.setHeader('Content-Type','text/html');r.end(pageSource);});}}]});
let browser;
try {
  await server.listen(); browser=await chromium.launch({channel:'msedge',headless:true});
  const page=await browser.newPage(); const errors=[];
  page.setDefaultTimeout(15000);
  page.on('pageerror', e=>{errors.push(e.message);console.log(e.message);});
  await page.route('**/api/**',r=>r.fulfill({json:{}}));
  await page.goto(server.resolvedUrls.local[0]+'__fixture');
  await page.getByRole('button').first().waitFor();
  const panel=page.getByText('局部重绘画笔参数 · 左键执行当前画笔或橡皮');
  await page.locator('#surface').click({button:'right'}); await panel.waitFor();
  assert.equal(await page.evaluate(()=>window.paintCount),0);
  const size=page.locator('input[type=number]').first(); await size.fill('42');
  assert(await panel.isVisible());
  await page.locator('#surface').click(); assert.equal(await panel.count(),0);
  assert.deepEqual(await page.evaluate(()=>[window.paintCount,window.selectCount]),[0,0]);
  await page.locator('#surface').click();
  assert.deepEqual(await page.evaluate(()=>[window.paintCount,window.selectCount]),[1,1]);
  await page.locator('#surface').click({button:'right'}); await panel.waitFor();
  await page.keyboard.press('Escape'); assert.equal(await panel.count(),0);
  await page.locator('#surface').click({button:'right',modifiers:['Alt']}); assert.equal(await panel.count(),0);
  assert.deepEqual(errors,[]);
  console.log('Real BottomToolDock + viewport RMB guard: open, edit, dismiss without paint/selection, next stroke, Escape and Alt navigation passed.');
} finally {await browser?.close();await server.close();}
