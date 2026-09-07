import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import ts from 'typescript';

const fixedDate = new Date('2026-09-07T12:34:56Z');
async function load(relativePath) {
  const source = await fs.readFile(new URL(relativePath, import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  let copiedBytes = 0;
  const trackedBuffer = new Proxy(ArrayBuffer, {
    construct(target, args) {
      copiedBytes += Number(args[0]);
      return Reflect.construct(target, args);
    },
  });
  const exports = {};
  const crc = new Function('exports', 'ArrayBuffer', 'Date', `${compiled}; return crc32;`)(
    exports, trackedBuffer, class extends Date { constructor() { super(fixedDate); } },
  );
  return { create: exports.createZipBlob, crc, copiedBytes: () => copiedBytes };
}

const old = await load('./fixtures/exportZip.before-copy-removal.ts');
const current = await load('../src/engine/export/exportZip.ts');
const backing = new Uint8Array([99, 1, 2, 3, 4, 88]);
const large = new Uint8Array(16 * 1024 * 1024);
for (let i = 0; i < large.length; i += 1) large[i] = (i * 31 + (i >>> 8)) & 255;
const files = [
  { path: '模型\\贴图.txt', data: '颜色与透明度 🖌️' },
  { path: 'slice.bin', data: backing.subarray(1, 5) },
  { path: 'view.bin', data: new DataView(backing.buffer, 2, 2) },
  { path: 'array.bin', data: new Uint8Array([5, 6, 7]).buffer },
  { path: 'blob.bin', data: new Blob([new Uint8Array([8, 9])]) },
  { path: 'empty', data: new Uint8Array() },
  { path: 'full-resolution.bin', data: large },
];
const expected = await old.create(files);
const actual = await current.create(files);
assert.equal(actual.type, 'application/zip');
assert.deepEqual(Buffer.from(await actual.arrayBuffer()), Buffer.from(await expected.arrayBuffer()));
assert(old.copiedBytes() >= large.length, 'Frozen baseline explicitly duplicates archive buffers');
assert.equal(current.copiedBytes(), 0, 'No redundant JS ArrayBuffer copies remain');
const snapshot = Buffer.from(await actual.arrayBuffer());
backing.fill(0); large.fill(0);
assert.deepEqual(Buffer.from(await actual.arrayBuffer()), snapshot, 'Published Blob owns an immutable snapshot');
assert.deepEqual(
  Buffer.from(await (await current.create([])).arrayBuffer()),
  Buffer.from(await (await old.create([])).arrayBuffer()),
  'Empty archive structure is unchanged',
);
console.log(`ZIP byte parity passed; explicit buffer copies: ${old.copiedBytes()} -> ${current.copiedBytes()} bytes; typed views and Blob snapshot preserved.`);

assert.equal(current.crc(new TextEncoder().encode('123456789')), 0xcbf43926);
assert.equal(current.crc(new Uint8Array()), 0);
function bitwiseCrc(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
let seed = 0x20260907;
for (let test = 0; test < 400; test += 1) {
  const length = test < 20 ? test : (test * 131) % 8193;
  const storage = new Uint8Array(length + 7);
  for (let index = 0; index < storage.length; index += 1) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    storage[index] = test % 5 === 0 ? 0 : test % 5 === 1 ? 255 : seed >>> 24;
  }
  const bytes = storage.subarray(3, 3 + length);
  const before = storage.slice();
  assert.equal(current.crc(bytes), old.crc(bytes));
  assert.equal(current.crc(bytes), bitwiseCrc(bytes), 'Independent CRC oracle');
  assert.deepEqual(storage, before, 'Checksum calculation cannot mutate or extend the view');
}
console.log('CRC exactness passed: standard vectors and 400 offset/length/random/zero/255 fixtures.');
if (process.argv.includes('--benchmark')) {
  for (let i = 0; i < large.length; i += 1) large[i] = (i * 31 + (i >>> 8)) & 255;
  const functions = [old.crc, current.crc];
  for (let i = 0; i < 3; i += 1) for (const fn of functions) fn(large);
  const samples = [[], []];
  for (let round = 0; round < 7; round += 1) {
    for (const index of round % 2 ? [1, 0] : [0, 1]) {
      const start = performance.now();
      functions[index](large);
      samples[index].push(performance.now() - start);
    }
  }
  const median = (values) => [...values].sort((a, b) => a - b)[3];
  console.log(JSON.stringify({ bytes: large.length, baselineMedianMs: median(samples[0]), indexedMedianMs: median(samples[1]), samples }));
}
