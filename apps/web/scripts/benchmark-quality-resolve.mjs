import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import ts from 'typescript';

// Fixed pre-change resolver: same scratch reuse and LUT as production, so the
// comparison isolates strong-weight reuse rather than older allocation costs.
const baselineRevision = '42c3304965ce089d9805707f36f9c831bf4d8bd3';
const root = new URL('../', import.meta.url);
const baseline = execFileSync('git', ['show', `${baselineRevision}:apps/web/src/engine/bake/qualityBlendCpuPixel.ts`], { cwd: root, encoding: 'utf8' });
const current = fs.readFileSync(new URL('src/engine/bake/qualityBlendCpuPixel.ts', root), 'utf8');
const compile = source => ts.transpileModule(source.replace('export function', 'function'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

async function compare(resolvers, pause, report) {
  const results = [];
  let seed = 715;
  const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
  const count = 262144;
  for (const scenario of ['three-candidates', 'single-candidate', 'mixed-boundaries']) {
    const top = { coverage: new Uint8Array(count).fill(1), writtenTexels: count,
      colors: Array.from({ length: 3 }, () => new Uint32Array(count)),
      coverages: Array.from({ length: 3 }, () => new Float32Array(count)),
      qualities: Array.from({ length: 3 }, () => new Float32Array(count)) };
    for (let i = 0; i < count; i++) for (let slot = 0; slot < 3; slot++) {
      top.colors[slot][i] = random() & 0xffffff;
      top.coverages[slot][i] = scenario === 'three-candidates' ? .1 + random() / 0xffffffff * .9
        : scenario === 'single-candidate' ? Number(slot === 0)
          : [0, .000001, .02, .020001, .5, 1][random() % 6];
      top.qualities[slot][i] = random() / 0xffffffff;
      if (scenario === 'mixed-boundaries' && i % 7 === 0) top.coverage[i] = 0;
    }
    const times = [[], []];
    for (let trial = 0; trial < 6; trial++) {
      const outputs = [new Uint8ClampedArray(count * 4).fill(93), new Uint8ClampedArray(count * 4).fill(93)];
      const flags = [new Uint8Array(count), new Uint8Array(count)];
      for (const index of trial % 2 ? [1, 0] : [0, 1]) {
        let duration = 0;
        for (let start = 0; start < count; start += 8192) {
          const end = Math.min(count, start + 8192), begin = performance.now();
          for (let i = start; i < end; i++) flags[index][i] = Number(resolvers[index](top, i, trial % 2 === 0, outputs[index]));
          duration += performance.now() - begin;
          await pause();
        }
        if (trial) times[index].push(Number(duration.toFixed(2)));
      }
      for (let i = 0; i < count * 4; i++) if (outputs[0][i] !== outputs[1][i]) throw Error(`${scenario}: RGBA mismatch ${i}`);
      for (let i = 0; i < count; i++) if (flags[0][i] !== flags[1][i]) throw Error(`${scenario}: coverage mismatch ${i}`);
      report(`${scenario}: ${trial + 1}/6 passed`);
    }
    results.push({ scenario, pixels: count, oldMs: times[0], newMs: times[1], byteMismatches: 0 });
  }
  return results;
}

const codes = [baseline, current].map(compile);
if (process.argv.includes('--node')) {
  console.log(JSON.stringify(await compare(codes.map(code => new Function(`${code};return resolvePixelCpu`)()), () => Promise.resolve(), () => {}), null, 2));
} else {
  const script = `const resolvers=[${codes.map(code => `(()=>{${code};return resolvePixelCpu})()`).join(',')}];
    const compare=${compare.toString()};
    document.querySelector('button').onclick=async()=>{
      const output=document.querySelector('pre');document.querySelector('button').disabled=true;
      try{output.textContent=JSON.stringify(await compare(resolvers,()=>new Promise(r=>setTimeout(r,0)),text=>output.textContent=text),null,2)}
      catch(e){output.textContent=e.stack}finally{document.querySelector('button').disabled=false}
    };`;
  fs.mkdirSync(new URL('dist/', root), { recursive: true });
  fs.writeFileSync(new URL('dist/quality-resolve-benchmark.html', root), `<!doctype html><meta charset="utf-8"><title>UV quality resolver comparison</title><h1>逐层 UV 权重解析对照</h1><p>冻结 ${baselineRevision.slice(0, 8)} 对照当前内核；只运行合成数据，不修改工程。每批完整 RGBA 和返回状态校验。</p><button>运行解析对照</button><pre>Ready</pre><script>${script}</script>`);
  console.log('Generated dist/quality-resolve-benchmark.html');
}
