import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import { pipelineTraceDisabled } from './pipeline-trace-test-build.mjs';
import { TextDecoder } from 'node:util';

let source = fs.readFileSync(
  new URL('../src/engine/viewport/input.ts', import.meta.url),
  'utf8',
);
source = source
  .replace(/^import[^;]+;\r?\n/gm, '')
  .replace(
    /new URL\('\.\.\/\.\.\/workers\/payload\.worker\.ts', import\.meta\.url\)/g,
    "'payload-worker'",
  );
const code = ts.transpileModule(pipelineTraceDisabled(source), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

const document = { body: { dataset: {} }, visibilityState: 'visible' };
let resumePaint;
let paintWaits = 0;
const waitForBrowserPaint = () => {
  paintWaits += 1;
  return new Promise((resolve) => {
    resumePaint = resolve;
  });
};
const events = [];

class PayloadWorker {
  onmessage;
  onerror;
  onmessageerror;
  results = new Map();
  async postMessage(message) {
    if (!message) {
      events.push('release');
      const result = this.results.get(0);
      this.results.delete(0);
      this.onmessage?.({ data: [result] });
      return;
    }
    events.push(message instanceof ArrayBuffer ? 'parse' : 'data-url');
    try {
      const result =
        message instanceof ArrayBuffer
          ? JSON.parse(new TextDecoder().decode(message))
          : `data:${message.type};base64,${Buffer.from(
              await message.arrayBuffer(),
            ).toString('base64')}`;
      this.results.set(0, result);
      document.body.dataset.perfSimulatedViewportInteraction = '1';
      this.onmessage?.({ data: 0 });
    } catch {
      this.onmessage?.({ data: null });
    }
  }
  terminate() {}
}

const scope = {
  exports: {},
  Worker: PayloadWorker,
  URL,
  Blob,
  FileReader: class {},
  TextDecoder,
  document,
  performance,
  setTimeout,
  clearTimeout,
  waitForBrowserPaint,
};
const api = new Function(...Object.keys(scope), `${code};return exports;`)(
  ...Object.values(scope),
);

let nativeJsonCalls = 0;
const small = new Response('{"ok":true}', { headers: { 'content-length': '11' } });
const nativeJson = small.json.bind(small);
small.json = () => {
  nativeJsonCalls += 1;
  return nativeJson();
};
assert.deepEqual(await api.interactionSafeJsonResponse(small), { ok: true });
assert.equal(nativeJsonCalls, 1, 'small service responses retain the native fast path');

const largeValue = 'x'.repeat(300 * 1024);
let settled = false;
const largePromise = api
  .interactionSafeJsonResponse(new Response(JSON.stringify({ id: 'job', resultUrl: largeValue })))
  .then((value) => {
    settled = true;
    return value;
  });
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(settled, false, 'large JSON result is held while viewport interaction is active');
delete document.body.dataset.perfSimulatedViewportInteraction;
resumePaint();
assert.deepEqual(await largePromise, { id: 'job', resultUrl: largeValue });
assert.deepEqual(events, ['parse', 'release']);

const exactBytes = Buffer.alloc(300 * 1024, 37);
settled = false;
const blobPromise = api
  .interactionSafeBlobDataUrl(new Blob([exactBytes], { type: 'image/png' }))
  .then((value) => {
    settled = true;
    return value;
  });
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(settled, false, 'large Data URL result is held while viewport interaction is active');
delete document.body.dataset.perfSimulatedViewportInteraction;
resumePaint();
assert.equal(
  await blobPromise,
  `data:image/png;base64,${exactBytes.toString('base64')}`,
  'Worker conversion preserves every source byte',
);
assert.deepEqual(events, ['parse', 'release', 'data-url', 'release']);
assert.equal(paintWaits, 2);

const imageUtils = fs.readFileSync(
  new URL('../src/engine/localRepaint/imageUtils.ts', import.meta.url),
  'utf8',
);
const editor = fs.readFileSync(new URL('../src/routes/EditorPage.tsx', import.meta.url), 'utf8');
assert.match(imageUtils, /interactionSafeBlobDataUrl as blobToDataUrl/);
assert.match(editor, /blobToImageData\(outputImage, true\)/);
assert.doesNotMatch(editor, /urlToImageData\(await blobToDataUrl\(outputImage\)\)/);

console.log(
  'Interaction-safe service results: large JSON and Blob publication preserve exact payloads and yield to viewport input.',
);
