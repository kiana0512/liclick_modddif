import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('../src/engine/projection/maskedProjectedImage.worker.ts', import.meta.url), 'utf8');
let receive;
const messages = [], canvases = [], waits = [];
class TestImageData {
  constructor(data, width, height) { Object.assign(this, { data, width, height }); }
}
class TestCanvas {
  constructor(width, height) { Object.assign(this, { width, height }); canvases.push(this); }
  getContext() { return { putImageData: image => { this.image = image; } }; }
  convertToBlob(options) {
    assert.equal(options.type, 'image/png');
    return new Promise((resolve, reject) => waits.push({ resolve: () => resolve(new Blob([this.image.data])), reject }));
  }
}
const scope = {
  addEventListener: (_name, callback) => { receive = callback; },
  postMessage: (payload, options) => messages.push(globalThis.structuredClone(payload, { transfer: options?.transfer ?? [] })),
};
new Function('exports', 'require', 'self', 'ImageData', 'OffscreenCanvas',
  ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText,
)({}, () => ({ applyProjectedAlphaMask: image => image }), scope, TestImageData, TestCanvas);
const event = id => ({ data: { id, pngOnly: true, source: { width: 1, height: 1, data: new Uint8Array([13, 45, 91, 127]).buffer } } });
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const first = receive(event(1)), second = receive(event(2));
await tick();
assert.equal(canvases.length, 1, 'only one full PNG canvas is allocated during concurrent results');
waits[0].resolve(); await first; await tick();
assert.equal(canvases.length, 2);
assert.deepEqual([canvases[0].width, canvases[0].height], [0, 0], 'successful encode releases canvas');
waits[1].resolve(); await second;
assert.deepEqual(messages.map(v => v.id), [1, 2]);
assert.deepEqual([...new Uint8Array(messages[0].png)], [13, 45, 91, 127], 'encoder receives unchanged RGBA');
assert.equal(messages[0].data, undefined, 'PNG replies do not transfer a second full RGBA buffer');
const failed = receive(event(3)), recovery = receive(event(4)); await tick();
waits[2].reject(Error('PNG encode failed')); await failed; await tick();
assert.equal(messages.at(-1).error, 'PNG encode failed');
assert.deepEqual([canvases[2].width, canvases[2].height], [0, 0], 'failed encode releases canvas');
waits[3].resolve(); await recovery;
assert.equal(messages.at(-1).id, 4, 'failed PNG does not poison the serial encoder');
const pixelEvent = event(5); delete pixelEvent.data.pngOnly;
await receive(pixelEvent);
assert.deepEqual([...new Uint8Array(messages.at(-1).data)], [13, 45, 91, 127], 'original pixel protocol still works');
console.log('Masked projection PNG Worker: serial canvas ownership, exact RGBA input, release, failure recovery and original pixel protocol passed.');
