import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Buffer } from 'node:buffer';
import { performance } from 'node:perf_hooks';
import { stdout } from 'node:process';
import { fileURLToPath } from 'node:url';
import { minify } from 'terser';
import { build } from 'vite';
import { compactThreeShaderChunks } from './shader-template-format.mjs';
import { packThreeShaderChunks, shaderChunkPackPlugin } from './shader-chunk-pack.mjs';

const file = new URL('../node_modules/three/build/three.module.js', import.meta.url);
const original = fs.readFileSync(file, 'utf8');
const coreUrl = new URL('./three.core.js', file).href;
const fflateUrl = import.meta.resolve('fflate');
const load = code => import('data:text/javascript;base64,' + Buffer.from(code
  .replace(/(['"])\.\/three\.core\.js\1/g, JSON.stringify(coreUrl))
  .replace(/(['"])fflate\1/g, JSON.stringify(fflateUrl))).toString('base64'));
const expected = await import(file.href);
assert.equal(Object.keys(expected.ShaderChunk).length, 141, 'Pinned Three registry upgrades require audit');
for (const source of [original, compactThreeShaderChunks(original)]) {
  const before = await load(source);
  const packed = packThreeShaderChunks(source);
  const after = await load(packed);
  assert.deepEqual(after.ShaderChunk, before.ShaderChunk, 'All registered strings are byte-exact, including whitespace');
  assert.deepEqual(after.ShaderLib, before.ShaderLib, 'Actual vertex/fragment assemblies and uniforms retain the contract');
  assert.deepEqual(Object.keys(after), Object.keys(before), 'All vendor exports remain available');
  assert.ok(Buffer.byteLength(source) - Buffer.byteLength(packed) > 30000);
}
// Exercise the actual production Terser settings, including pure annotations.
// Keep the same external modules so the real Three module executes after minify.
const formatted = compactThreeShaderChunks(original);
const packed = packThreeShaderChunks(formatted);
const result = await minify(packed, { module: true, ecma: 2020,
  compress: { passes: 4, drop_console: false, unsafe: false },
  mangle: { properties: false }, format: { comments: false } });
assert.ok(result.code);
const started = performance.now();
const production = await load(result.code);
const baseline = await load(formatted);
assert.deepEqual(production.ShaderChunk, baseline.ShaderChunk);
assert.deepEqual(production.ShaderLib, baseline.ShaderLib);
const elapsed = performance.now() - started;
// Geometry-only users (including Workers) must not acquire shader decoding.
const geometryBuild = await build({ configFile: false, publicDir: false, logLevel: 'silent',
  plugins: [{ name: 'geometry-pack-fixture',
    resolveId(id) { if (id.replaceAll('\\', '/').endsWith('li3d-geometry-pack-fixture')) return '\0li3d-geometry-pack-fixture'; },
    load(id) { if (id === '\0li3d-geometry-pack-fixture') return `import { Vector3 } from ${JSON.stringify(fileURLToPath(file).replaceAll('\\', '/'))}; export const position = new Vector3(1, 2, 3);`; },
  }, shaderChunkPackPlugin()],
  build: { write: false, minify: false, lib: { entry: 'li3d-geometry-pack-fixture', formats: ['es'] } },
});
const geometryOutputs = Array.isArray(geometryBuild) ? geometryBuild : [geometryBuild];
const geometryCode = geometryOutputs.flatMap(output => output.output).filter(output => output.type === 'chunk').map(output => output.code).join('\n');
assert.ok(!geometryCode.includes('__li3d_shader_pack_'), 'Unused renderer pool must tree-shake from geometry-only imports');
assert.ok(!geometryCode.includes('function inflt'), 'Geometry-only imports must not acquire inflate runtime');
const plugin = shaderChunkPackPlugin();
assert.equal(plugin.apply, 'build');
assert.equal(plugin.transform(original, '/src/ui/Panel.tsx'), undefined);
assert.equal(plugin.transform(original, '/node_modules/another/build/three.module.js'), undefined);
assert.equal(plugin.transform(formatted, file.pathname).code, packed);
for (const source of ['const ShaderChunk = { shader: 1 };',
  'const shader = compute(); const ShaderChunk = { shader };',
  'const text = "ordinary";', 'const __li3d_shader_pack_texts = [];']) {
  assert.throws(() => packThreeShaderChunks(source), /audit|not found/);
}
stdout.write(`Three shader packing passed: 141 byte-exact shaders, ShaderLib/exports and production Terser retained; ${Buffer.byteLength(formatted) - Buffer.byteLength(packed)} source bytes saved. Module verification ${elapsed.toFixed(1)}ms includes JS import/parsing.\n`);
