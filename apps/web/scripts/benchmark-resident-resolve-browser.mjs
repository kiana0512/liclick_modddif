import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createServer } from 'vite';
import ts from 'typescript';

assert(process.argv[2] && process.argv[3], 'Pass saved pre-change composite and bake source paths.');
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href);
const sources = {};
sources['/__quality_before.js'] = (await readFile(process.argv[2], 'utf8')).replaceAll("from './", "from '/src/engine/bake/");
for (const [name, path] of [['before', process.argv[3]], ['after', new URL('../src/engine/bake/gpuUvBakeRenderer.ts', import.meta.url)]]) {
  const source = await readFile(path, 'utf8');
  const start = source.indexOf('      const started = performance.now();', source.indexOf('    let residentQuality: QualityBlendWorkerResult'));
  const end = source.indexOf('      const resolveMs=', start);
  sources[`/__resolve_${name}.js`] = `import {convertLayerGpuReadbackInWorker} from '/src/engine/bake/gpuReadbackConversionWorker.ts';
    export async function run(resident,resolution) { const input={residentQuality:{preserveAlpha:false}},retainRasters=false;
    let coveredPixels=0; ${source.slice(start,end)} return {imageData,coverage,coveredPixels}; }`;
}
const server = await createServer({ root: new URL('..', import.meta.url).pathname.replace(/^\/(\w:)/, '$1'), logLevel: 'error',
  plugins: [{ name: 'resolve-comparison', resolveId(id) { if (id in sources) return id; }, load(id) {
    if (id in sources) return ts.transpileModule(sources[id], { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  } }], server: { host: '127.0.0.1', port: 0, watch: { ignored: () => true } } });
server.middlewares.use('/__compare', (_, response) => response.end('<!doctype html><title>Resolve comparison</title>'));
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ headless: true, channel: 'msedge', args: ['--enable-webgl', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__compare`);
  console.log(JSON.stringify(await page.evaluate(async () => {
    const THREE = await import('/node_modules/three/build/three.module.js');
    const Before = (await import('/__quality_before.js')).ResidentQualityComposite;
    const After = (await import('/src/engine/bake/residentQualityComposite.ts')).ResidentQualityComposite;
    const flows = [await import('/__resolve_before.js'), await import('/__resolve_after.js')];
    const renderer = new THREE.WebGLRenderer(), resolution = 2048;
    const composites = [new Before(renderer, resolution), new After(renderer, resolution)];
    const pixels = new Uint8Array(resolution * resolution * 4);
    for (let i = 0; i < pixels.length; i += 4) pixels.set([127, 89, 55, 255], i);
    const texture = new THREE.DataTexture(pixels, resolution, resolution); texture.needsUpdate = true;
    const rows = [];
    try {
      for (let round = 0; round < 5; round++) {
        const results = [], times = [];
        for (const index of round % 2 ? [1, 0] : [0, 1]) {
          composites[index].reset();
          for (let layer = 0; layer < 7; layer++) composites[index].push(texture, texture);
          const start = performance.now();
          results[index] = await flows[index].run(composites[index], resolution);
          times[index] = performance.now() - start;
        }
        for (let i = 0; i < pixels.length; i++) if (results[0].imageData.data[i] !== results[1].imageData.data[i]) throw Error('RGBA mismatch');
        for (let i = 0; i < results[0].coverage.length; i++) if (results[0].coverage[i] !== results[1].coverage[i]) throw Error('Coverage mismatch');
        if (results[0].coveredPixels !== results[1].coveredPixels) throw Error('Count mismatch');
        rows.push({ round, beforeMs: times[0], afterMs: times[1], byteDifferences: 0 });
      }
      return { resolution, rows };
    } finally { texture.dispose(); composites.forEach(composite => composite.dispose()); renderer.dispose(); }
  })));
} finally { await browser?.close(); await server.close(); }
