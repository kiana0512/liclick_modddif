import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const source = await fs.readFile(new URL('../src/services/assetFileService.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const exports = {};
new Function('exports', 'require', compiled)(exports, id => {
  if (id === '../config.js') return { serverConfig: { allowedRemoteAssetHosts: [] } };
  return id.startsWith('.') ? {} : require(id);
});
const { fetchAllowedRemoteImage } = exports;
const originalFetch = globalThis.fetch;
const allowedUrl = 'https://ai-assets.lilithgames.com/result.png';
let calls = 0;

try {
  globalThis.fetch = async () => { calls++; throw new Error('Unexpected network request'); };
  await assert.rejects(fetchAllowedRemoteImage('http://127.0.0.1/private'), /Only HTTPS/);
  await assert.rejects(fetchAllowedRemoteImage('https://localhost/private.png'), /host is not allowed/);
  await assert.rejects(fetchAllowedRemoteImage('https://ai-assets.lilithgames.com:8443/result.png'), /standard HTTPS/);
  assert.equal(calls, 0, 'Disallowed hosts must be rejected before fetch');

  globalThis.fetch = async (_url, options) => {
    calls++;
    assert.equal(options.redirect, 'manual', 'Every redirect must be validated before following it');
    return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private' } });
  };
  await assert.rejects(fetchAllowedRemoteImage(allowedUrl), /Only HTTPS/);
  assert.equal(calls, 1);

  globalThis.fetch = async (url, options) => {
    assert.equal(options.redirect, 'manual');
    if (url === allowedUrl) return new Response(null, { status: 302, headers: { location: '/redirected.png' } });
    assert.equal(url, 'https://ai-assets.lilithgames.com/redirected.png');
    return new Response(Uint8Array.from([1, 2, 3]), { headers: { 'content-type': 'image/png' } });
  };
  assert.deepEqual([...(await fetchAllowedRemoteImage(allowedUrl, 3)).buffer], [1, 2, 3]);

  globalThis.fetch = async () => new Response('not-image', { headers: { 'content-type': 'text/plain' } });
  await assert.rejects(fetchAllowedRemoteImage(allowedUrl), /not an image/);

  globalThis.fetch = async () => new Response(null, {
    headers: { 'content-type': 'image/png', 'content-length': '11' },
  });
  await assert.rejects(fetchAllowedRemoteImage(allowedUrl, 10), /too large/);

  globalThis.fetch = async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(Uint8Array.from([1, 2, 3, 4, 5, 6]));
      controller.enqueue(Uint8Array.from([7, 8, 9, 10, 11]));
      controller.close();
    },
  }), { headers: { 'content-type': 'image/png' } });
  await assert.rejects(fetchAllowedRemoteImage(allowedUrl, 10), /too large/,
    'Missing Content-Length must still be bounded during streaming');

  globalThis.fetch = async () => new Response(Uint8Array.from([1, 2, 3]), {
    headers: { 'content-type': 'image/png', 'content-length': '3' },
  });
  const image = await fetchAllowedRemoteImage(allowedUrl, 3);
  assert.equal(image.mime, 'image/png');
  assert.deepEqual([...image.buffer], [1, 2, 3]);

  globalThis.fetch = originalFetch;
  const inline = await fetchAllowedRemoteImage('data:image/png;base64,AQID', 3);
  assert.deepEqual([...inline.buffer], [1, 2, 3]);
  await assert.rejects(fetchAllowedRemoteImage('data:image/png;base64,AQIDBA==', 3), /not an allowed image|too large/);
  console.log('Remote image boundary passed: host, redirect, MIME, declared/streamed size and inline image.');
} finally {
  globalThis.fetch = originalFetch;
}
