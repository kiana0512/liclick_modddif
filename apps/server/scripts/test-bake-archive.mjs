import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { createRequire } from 'node:module';
import ts from 'typescript';

const require = createRequire(import.meta.url);
async function load(url) {
  const source = await fs.readFile(new URL(url, import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const exports = {};
  const crc = new Function('require', 'exports', `${compiled}; return updateCrc32;`)(
    (id) => id === './substanceBakeService.js' ? {} : require(id), exports,
  );
  return { ...exports, crc };
}
const old = await load('./fixtures/bakeArchive.before-indexed-crc.ts');
const current = await load('../src/services/bakeArchiveService.ts');
class SlowResponse extends Writable {
  chunks = [];
  writes = 0;
  constructor() { super({ highWaterMark: 1 }); }
  _write(chunk, encoding, callback) {
    this.chunks.push(Buffer.from(chunk));
    this.writes += 1;
    setImmediate(callback);
  }
}
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'li3d-archive-test-'));
try {
  const bytes = Buffer.alloc(1024 * 1024 + 3);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = (i * 31 + (i >>> 8)) & 255;
  const filePath = path.join(directory, 'pixels.bin');
  await fs.writeFile(filePath, bytes);
  const entries = [{ path: filePath, name: '模型_BaseColor.png', size: bytes.length }];
  const previous = new SlowResponse();
  const next = new SlowResponse();
  await old.streamBakeArchive(previous, entries);
  await current.streamBakeArchive(next, entries);
  assert.deepEqual(Buffer.concat(next.chunks), Buffer.concat(previous.chunks), 'Streamed ZIP bytes, descriptors, CRC and offsets remain identical');
  assert(next.writes > 16, 'Output remains chunked under real Writable backpressure');
  assert(next.writableEnded);
  const invalid = new SlowResponse();
  await assert.rejects(current.streamBakeArchive(invalid, [{ ...entries[0], size: bytes.length + 1 }]), /changed while exporting/);
  assert(!invalid.writableEnded, 'A size mismatch cannot publish a completed ZIP');
  const oversized = new SlowResponse();
  await assert.rejects(current.streamBakeArchive(oversized, [{ ...entries[0], size: 0x100000000 }]), /ZIP32/);
  assert.equal(oversized.writes, 0);
  for (let test = 0; test < 400; test += 1) {
    const input = bytes.subarray(test % 7, test % 7 + test * 13);
    let actual = 0xffffffff;
    let expected = actual;
    const stride = 1 + test % 257;
    for (let offset = 0; offset < input.length; offset += stride) {
      const chunk = input.subarray(offset, offset + stride);
      actual = current.crc(actual, chunk);
      expected = old.crc(expected, chunk);
    }
    assert.equal(actual, expected, 'Arbitrary chunk boundaries preserve incremental CRC state');
    assert.equal(actual, old.crc(0xffffffff, input));
  }
  assert.equal((current.crc(0xffffffff, Buffer.from('123456789')) ^ 0xffffffff) >>> 0, 0xcbf43926);
  if (process.argv.includes('--benchmark')) {
    const large = Buffer.alloc(16 * 1024 * 1024, 123);
    const functions = [old.crc, current.crc];
    const samples = [[], []];
    const run = (fn) => {
      let crc = 0xffffffff;
      for (let offset = 0; offset < large.length; offset += 65536) crc = fn(crc, large.subarray(offset, offset + 65536));
      return crc;
    };
    for (let warmup = 0; warmup < 3; warmup += 1) functions.forEach(run);
    for (let round = 0; round < 7; round += 1) {
      for (const index of round % 2 ? [1, 0] : [0, 1]) {
        const start = performance.now();
        run(functions[index]);
        samples[index].push(performance.now() - start);
      }
    }
    assert.equal(run(functions[0]), run(functions[1]));
    console.log(JSON.stringify({ bytes: large.length, chunkBytes: 65536, mediansMs: samples.map(values => [...values].sort((a,b) => a-b)[3]) }));
  }
} finally {
  // mkdtemp returns an absolute task-owned directory under the OS temp root.
  assert(path.dirname(directory) === path.resolve(os.tmpdir()) && path.basename(directory).startsWith('li3d-archive-test-'));
  await fs.rm(directory, { recursive: true, force: true });
}
console.log('Bake archive passed: binary parity, incremental CRC, backpressure, size changes and ZIP32 guard.');
