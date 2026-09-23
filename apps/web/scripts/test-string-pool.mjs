import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { minify } from 'terser';
import { poolStrings } from './string-pool.mjs';

const text = '测试文本 "quotes" \\ slash\nline '.repeat(8);
const literal = JSON.stringify(text);
const source = `const original = ${literal};
const obj = { ${literal}: ${literal}, value: ${literal} };
const call = x => x;
export function run() { return [original, obj.value, obj[${literal}], call(${literal}), ${literal}]; }
export function returned() { return ${literal}; }`;
const load = code => import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));
const baseline = await load(source);
const packed = poolStrings(source);
assert.ok(packed.length < source.length);
assert.ok(packed.includes(`${literal}:`), 'Property names are never rewritten');
for (const code of [packed, (await minify(packed, { module: true, ecma: 2020,
  compress: { passes: 4, unsafe: false, drop_console: false }, mangle: { properties: false } })).code]) {
  const actual = await load(code);
  assert.deepEqual(actual.run(), baseline.run());
  assert.equal(actual.returned(), baseline.returned());
}
const untouched = `import x from ${literal}; export { x } from ${literal}; "use strict";`;
assert.equal(poolStrings(untouched).trim(), untouched);
assert.throws(() => poolStrings('const __li3d_string_pool_0 = 1;'), /collision/);
console.log('String pooling: exact Unicode/escape values, property/import/directive protection and production minification passed.');
