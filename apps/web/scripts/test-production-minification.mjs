import assert from 'node:assert/strict';
import path from 'node:path';
import { stdout } from 'node:process';
import { build, loadConfigFromFile } from 'vite';

const root = path.resolve(import.meta.dirname, '..');
const loaded = await loadConfigFromFile(
  { command: 'build', mode: 'production' },
  path.join(root, 'vite.config.ts'),
);
assert.ok(loaded);
const config = loaded.config;
assert.equal(config.build.minify, 'terser');
assert.equal(config.build.terserOptions.compress.drop_console, false);
assert.equal(config.build.terserOptions.compress.unsafe, false);
assert.equal(config.build.terserOptions.mangle.properties, false);
assert.equal(config.build.terserOptions.ecma, 2020);
assert.equal(config.build.target, 'es2022');

// Exercise the real production minifier through Vite, without writing dist.
const source = [
  'export function inspect(value) {',
  '  let reads = 0;',
  '  const source = { get imageUrl() { reads++; return value?.imageUrl; } };',
  '  const metadata = { maskUrl: "mask.png", authoredMaskUrl: "author.png",',
  '    contentRevision: value?.revision ?? 0, label: "局部重绘\\n\\n保留原文" };',
  '  console.warn("diagnostic retained", metadata.contentRevision);',
  '  const image = source.imageUrl;',
  '  const bytes = new Uint8Array([0, 127, 255]);',
  '  return { image, reads, metadata, keys: Object.keys(metadata),',
  '    serialized: JSON.stringify(metadata), bytes: Array.from(bytes),',
  '    negativeZero: Object.is(-0, -0), finite: Number.isFinite(value?.revision),',
  '    empty: value?.text ?? "fallback", match: /蒙版\\s+区域/u.test("蒙版 区域") };',
  '}',
  'export async function roundTrip(value) { return await Promise.resolve(inspect(value)); }',
].join('\n');
const fixtureId = '\0production-minifier-contract';
const result = await build({
  root,
  configFile: false,
  publicDir: false,
  logLevel: 'silent',
  esbuild: config.esbuild,
  plugins: [
    {
      name: 'production-minifier-contract',
      resolveId(id) {
        return id === fixtureId ? id : null;
      },
      load(id) {
        return id === fixtureId ? source : null;
      },
    },
  ],
  build: {
    ...config.build,
    write: false,
    rollupOptions: { input: fixtureId, preserveEntrySignatures: 'strict' },
  },
});
assert.ok(!Array.isArray(result) && 'output' in result);
const entry = result.output.find((item) => item.type === 'chunk' && item.isEntry);
assert.ok(entry && entry.type === 'chunk');
assert.ok(Buffer.byteLength(entry.code) < Buffer.byteLength(source));
const loadSource = (code) =>
  import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));
const original = await loadSource(source);
const compressed = await loadSource(entry.code);
assert.deepEqual(Object.keys(compressed), Object.keys(original));
const originalWarn = console.warn;
const warnings = [];
console.warn = (...args) => warnings.push(args);
try {
  for (const input of [
    undefined,
    {},
    { imageUrl: 'image.png', revision: 0, text: '' },
    { imageUrl: '纹理.png', revision: 7, text: '修复接缝' },
    { revision: NaN },
  ]) {
    assert.deepEqual(await compressed.roundTrip(input), await original.roundTrip(input));
    assert.deepEqual(warnings.at(-2), warnings.at(-1));
  }
  assert.equal(warnings.length, 10, 'Compression must not remove diagnostic calls.');
} finally {
  console.warn = originalWarn;
}
stdout.write(
  'Production minification preserves exports, diagnostics, getters, Unicode and data contracts.\n',
);
