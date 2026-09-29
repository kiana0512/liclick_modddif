import assert from 'node:assert/strict';
import { projectionGapMaskFromAlpha } from '../src/engine/projection/projectionCoverageContract.mjs';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { inflateSync } from 'node:zlib';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const workerPath = path.resolve(
  scriptDirectory,
  '../src/workers/localRepaintGenerationInput.worker.ts',
);
const generationInputWorkerPath = path.resolve(
  scriptDirectory,
  '../src/engine/localRepaint/generationInputWorker.ts',
);
const panelPath = path.resolve(scriptDirectory, '../src/components/panels/GeneratePanel.tsx');
const editorPagePath = path.resolve(scriptDirectory, '../src/routes/EditorPage.tsx');
const pngCorePath = path.resolve(scriptDirectory, '../src/utils/encodeRgbaPngCore.ts');
const workerSource = fs.readFileSync(workerPath, 'utf8');
const generationInputWorkerSource = fs.readFileSync(generationInputWorkerPath, 'utf8');
const panelSource = fs.readFileSync(panelPath, 'utf8');
const editorPageSource = fs.readFileSync(editorPagePath, 'utf8');
const pngCoreSource = fs.readFileSync(pngCorePath, 'utf8');
const privateCoreSource = `${workerSource
  .slice(0, workerSource.indexOf('self.onmessage'))
  .replace(/^import[^\n]+\n/gm, '')}
export { dilateMask, erodeMask, boxBlur, buildCompositeCoreMask, fillSmallMaskHoles, getMaskBounds };`;
const compiled = ts.transpileModule(privateCoreSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  fileName: workerPath,
}).outputText;
const module = { exports: {} };
new Function('exports', 'module', compiled)(module.exports, module);
const {
  dilateMask,
  erodeMask,
  boxBlur,
  buildCompositeCoreMask,
  fillSmallMaskHoles,
  getMaskBounds,
} = module.exports;
const errorMessageSource = fs.readFileSync(path.resolve(scriptDirectory, '../src/services/generationErrorMessage.ts'), 'utf8');
const errorModule = {exports: {}};
new Function('exports', ts.transpileModule(errorMessageSource, {
  compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022},
}).outputText)(errorModule.exports);
assert.throws(() => buildCompositeCoreMask(new Uint8Array(16), 4, 4), error => {
  assert.equal(errorModule.exports.getUserFacingGenerationError(error, '局部重绘生成失败，请稍后重试。'), '蒙版为空，请先涂抹重绘区域。');
  assert.equal(errorModule.exports.isRetryableGenerationPollError(error), false);
  return true;
});
const pngCoreCompiled = ts.transpileModule(pngCoreSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  fileName: pngCorePath,
}).outputText;
const pngCoreModule = { exports: {} };
new Function('require', 'exports', 'module', pngCoreCompiled)(
  createRequire(import.meta.url),
  pngCoreModule.exports,
  pngCoreModule,
);
const { encodeGrayscalePngBytes, encodeRgbaPngBytes } = pngCoreModule.exports;

// [shaoyangZhou]: verify encoder-owned buffers can transfer without a second copy.
for (const png of [encodeRgbaPngBytes(7,13,new Uint8Array(7*13*4)), encodeGrayscalePngBytes(7,13,new Uint8Array(7*13))]) {
  assert.equal(png.byteOffset, 0);
  assert.equal(png.byteLength, png.buffer.byteLength);
}

function assertPixelsEqual(actual, expected, message) {
  assert.equal(actual.length, expected.length, `${message}: pixel count`);
  for (let index = 0; index < actual.length; index += 1) {
    assert.equal(actual[index], expected[index], `${message}: byte ${index}`);
  }
}

function fillSmallMaskHolesFullFrame(source, width, height, maximumHoleArea) {
  const output = new Uint8Array(source);
  const visited = new Uint8Array(source.length);
  const queue = new Int32Array(source.length);
  for (let origin = 0; origin < source.length; origin += 1) {
    if (source[origin] !== 0 || visited[origin] !== 0) continue;
    let head = 0;
    let tail = 0;
    let touchesBoundary = false;
    queue[tail++] = origin;
    visited[origin] = 1;
    while (head < tail) {
      const index = queue[head++];
      const x = index % width;
      const y = Math.floor(index / width);
      if (x === 0 || x === width - 1 || y === 0 || y === height - 1) touchesBoundary = true;
      const neighbors = [
        [x - 1, y],
        [x + 1, y],
        [x, y - 1],
        [x, y + 1],
      ];
      for (const [neighborX, neighborY] of neighbors) {
        if (
          neighborX < 0 ||
          neighborX >= width ||
          neighborY < 0 ||
          neighborY >= height
        ) {
          continue;
        }
        const neighbor = neighborY * width + neighborX;
        if (source[neighbor] !== 0 || visited[neighbor] !== 0) continue;
        visited[neighbor] = 1;
        queue[tail++] = neighbor;
      }
    }
    if (!touchesBoundary && tail <= maximumHoleArea) {
      for (let queueIndex = 0; queueIndex < tail; queueIndex += 1) {
        output[queue[queueIndex]] = 255;
      }
    }
  }
  return output;
}

function erodeMaskFullFrame(source, width, height, radius) {
  const inverted = Uint8Array.from(source, (value) => 255 - value);
  const expandedBackground = dilateMask(inverted, width, height, radius);
  return Uint8Array.from(expandedBackground, (value) => 255 - value);
}

const width = 11;
const height = 11;
const authored = new Uint8Array(width * height);
authored[5 * width + 5] = 255;
const dilated = dilateMask(authored, width, height, 2);
assert.equal(dilated[5 * width + 5], 255);
assert.equal(dilated[3 * width + 3], 255);
assert.equal(dilated[2 * width + 2], 0);
const feathered = boxBlur(dilated, width, height, 1);
assert.ok(feathered[2 * width + 3] > 0 && feathered[2 * width + 3] < 255);

const fragmentedWidth = 31;
const fragmentedHeight = 21;
const fragmented = new Uint8Array(fragmentedWidth * fragmentedHeight);
for (let y = 7; y <= 13; y += 1) {
  for (let x = 8; x <= 20; x += 1) fragmented[y * fragmentedWidth + x] = 255;
}
fragmented[10 * fragmentedWidth + 14] = 0;
fragmented[10 * fragmentedWidth + 21] = 40;
fragmented[2 * fragmentedWidth + 2] = 40;
fragmented[18 * fragmentedWidth + 28] = 255;
const { core: compositeCore } = buildCompositeCoreMask(
  fragmented,
  fragmentedWidth,
  fragmentedHeight,
  1,
);
assert.equal(compositeCore[10 * fragmentedWidth + 14], 255, 'A small internal hole should be filled.');
assert.equal(compositeCore[10 * fragmentedWidth + 21], 255, 'A weak pixel connected to the core should remain.');
assert.equal(compositeCore[2 * fragmentedWidth + 2], 0, 'Weak isolated antialias noise should be removed.');
assert.equal(compositeCore[18 * fragmentedWidth + 28], 0, 'A microscopic detached island should be removed.');

// Bounded execution may skip only pixels that are mathematically guaranteed to stay zero.
// Exercise sparse, edge-touching, holed and noisy masks and require byte-for-byte equality
// with the original full-frame morphology path.
let randomState = 0x391f8fb8;
const nextRandom = () => {
  randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
  return randomState / 0x100000000;
};
for (let caseIndex = 0; caseIndex < 240; caseIndex += 1) {
  const stressWidth = 9 + (caseIndex % 31);
  const stressHeight = 7 + ((caseIndex * 7) % 29);
  const stressMask = new Uint8Array(stressWidth * stressHeight);
  const centerX = caseIndex % 4 === 0 ? 0 : Math.floor(nextRandom() * stressWidth);
  const centerY = caseIndex % 5 === 0 ? stressHeight - 1 : Math.floor(nextRandom() * stressHeight);
  const halfWidth = Math.floor(nextRandom() * Math.max(1, stressWidth / 4));
  const halfHeight = Math.floor(nextRandom() * Math.max(1, stressHeight / 4));
  for (let y = Math.max(0, centerY - halfHeight); y <= Math.min(stressHeight - 1, centerY + halfHeight); y += 1) {
    for (let x = Math.max(0, centerX - halfWidth); x <= Math.min(stressWidth - 1, centerX + halfWidth); x += 1) {
      if (nextRandom() < 0.16) continue;
      stressMask[y * stressWidth + x] = 24 + Math.floor(nextRandom() * 232);
    }
  }
  if (!stressMask.some((value) => value > 0)) stressMask[centerY * stressWidth + centerX] = 255;
  const stressBounds = getMaskBounds(stressMask, stressWidth, stressHeight);
  for (const radius of [1, 2, 3, 5]) {
    assertPixelsEqual(
      dilateMask(stressMask, stressWidth, stressHeight, radius, stressBounds),
      dilateMask(stressMask, stressWidth, stressHeight, radius),
      `bounded dilation case ${caseIndex}, radius ${radius}`,
    );
    assertPixelsEqual(
      boxBlur(stressMask, stressWidth, stressHeight, radius, stressBounds),
      boxBlur(stressMask, stressWidth, stressHeight, radius),
      `bounded blur case ${caseIndex}, radius ${radius}`,
    );
    assertPixelsEqual(
      erodeMask(stressMask, stressWidth, stressHeight, radius, stressBounds),
      erodeMaskFullFrame(stressMask, stressWidth, stressHeight, radius),
      `bounded erosion case ${caseIndex}, radius ${radius}`,
    );
  }

  const binaryMask = Uint8Array.from(stressMask, (value) => (value > 0 ? 255 : 0));
  const binaryBounds = getMaskBounds(binaryMask, stressWidth, stressHeight);
  const maximumHoleArea = 1 + (caseIndex % 19);
  assertPixelsEqual(
    fillSmallMaskHoles(binaryMask, stressWidth, stressHeight, maximumHoleArea, binaryBounds),
    fillSmallMaskHolesFullFrame(binaryMask, stressWidth, stressHeight, maximumHoleArea),
    `bounded hole fill case ${caseIndex}`,
  );
}

const grayscaleWidth = 47;
const grayscaleHeight = 29;
const expectedGrayscale = new Uint8Array(grayscaleWidth * grayscaleHeight);
for (let y = 0; y < grayscaleHeight; y += 1) {
  for (let x = 0; x < grayscaleWidth; x += 1) {
    expectedGrayscale[y * grayscaleWidth + x] =
      x < 3 || y < 2 ? 0 : x > 38 && y > 19 ? 255 : (x * 17 + y * 29) & 0xff;
  }
}
const grayscalePng = encodeGrayscalePngBytes(
  grayscaleWidth,
  grayscaleHeight,
  expectedGrayscale,
);
const pngView = new DataView(
  grayscalePng.buffer,
  grayscalePng.byteOffset,
  grayscalePng.byteLength,
);
const idatParts = [];
let pngOffset = 8;
let grayscaleColorType;
while (pngOffset < grayscalePng.byteLength) {
  const chunkLength = pngView.getUint32(pngOffset);
  const chunkType = String.fromCharCode(...grayscalePng.subarray(pngOffset + 4, pngOffset + 8));
  const chunkData = grayscalePng.subarray(pngOffset + 8, pngOffset + 8 + chunkLength);
  if (chunkType === 'IHDR') grayscaleColorType = chunkData[9];
  if (chunkType === 'IDAT') idatParts.push(chunkData);
  pngOffset += 12 + chunkLength;
}
assert.equal(grayscaleColorType, 0, 'Mask transport must use lossless 8-bit grayscale PNG.');
const compressedIdat = Buffer.concat(idatParts.map((part) => Buffer.from(part)));
const decodedRows = inflateSync(compressedIdat);
const decodedRgba = new Uint8Array(grayscaleWidth * grayscaleHeight * 4);
for (let y = 0; y < grayscaleHeight; y += 1) {
  const rowOffset = y * (grayscaleWidth + 1);
  assert.equal(decodedRows[rowOffset], 0, `grayscale PNG row ${y} must use filter 0`);
  for (let x = 0; x < grayscaleWidth; x += 1) {
    const value = decodedRows[rowOffset + 1 + x];
    const outputOffset = (y * grayscaleWidth + x) * 4;
    decodedRgba.set([value, value, value, 255], outputOffset);
  }
}
const expectedRgba = new Uint8Array(grayscaleWidth * grayscaleHeight * 4);
expectedGrayscale.forEach((value, index) => {
  expectedRgba.set([value, value, value, 255], index * 4);
});
assertPixelsEqual(
  decodedRgba,
  expectedRgba,
  'grayscale PNG must decode to the exact RGBA mask consumed by generation',
);

if (process.env.LICLICK_BENCHMARK_MASK_PNG === '1') {
  const benchmarkSize = 2048;
  const benchmarkGray = new Uint8Array(benchmarkSize * benchmarkSize);
  const benchmarkRgba = new Uint8Array(benchmarkSize * benchmarkSize * 4);
  for (let y = 0; y < benchmarkSize; y += 1) {
    for (let x = 0; x < benchmarkSize; x += 1) {
      const distance = Math.hypot(x - 1024, y - 1024);
      const value = distance < 430 ? 255 : distance < 470 ? Math.round((470 - distance) * 6.375) : 0;
      const index = y * benchmarkSize + x;
      benchmarkGray[index] = value;
      benchmarkRgba.set([value, value, value, 255], index * 4);
    }
  }
  const measure = (encode) => {
    const samples = [];
    let bytes = 0;
    for (let iteration = 0; iteration < 4; iteration += 1) {
      const startedAt = performance.now();
      const png = encode();
      const elapsed = performance.now() - startedAt;
      bytes = png.byteLength;
      if (iteration > 0) samples.push(elapsed);
    }
    samples.sort((left, right) => left - right);
    return { medianMs: samples[1], minMs: samples[0], maxMs: samples[2], bytes };
  };
  console.log(
    'Local repaint 2K mask PNG benchmark:',
    JSON.stringify({
      rgba: measure(() => encodeRgbaPngBytes(benchmarkSize, benchmarkSize, benchmarkRgba)),
      grayscale: measure(() =>
        encodeGrayscalePngBytes(benchmarkSize, benchmarkSize, benchmarkGray),
      ),
    }),
  );
}

assert.match(
  panelSource,
  /const preparationInput = \{[\s\S]*?currentEffectUrl: flatCurrentEffectUrl,[\s\S]*?clayPreviewUrl,[\s\S]*?authoredMaskUrl: currentPaintMaskDataUrl/,
  'Repaint input must use the frozen authored effect and original mask; clay is optional for GPT only.',
);
assert.match(
  panelSource,
  /prepareLocalRepaintPromptPolishInputs\(\{[\s\S]*?currentEffectUrl: promptAnalysisCurrentEffectUrl,[\s\S]*?maskUrl: currentPaintMaskDataUrl/,
  'Qwen must use the clean effect and original authored mask.',
);
assert.match(
  panelSource,
  /urlToDataUrl\(preparedGenerationInput\.submittedMaskUrl\)/,
  'ModelView should receive the prepared sampling mask.',
);
assert.match(
  panelSource,
  /capture = \{[\s\S]*?colorUrl: preparedGenerationInput\.compositeUrl,[\s\S]*?maskUrl: currentPaintMaskDataUrl/,
  'Capture paintback must retain the original authored mask.',
);
assert.match(
  panelSource,
  /maskUrl: persistedAuthoredMaskUrl,[\s\S]*?authoredMaskUrl: persistedAuthoredMaskUrl,[\s\S]*?submittedMaskUrl: persistedSubmittedMaskUrl/,
  'Durable generation metadata must separate the authored paintback mask from the remote mask.',
);
assert.match(
  editorPageSource,
  /function getLocalRepaintAuthoringMaskUrl\([\s\S]*?metadata\.authoredMaskUrl[\s\S]*?metadata\.maskUrl/,
  'Brush restore must prefer the authored mask and retain legacy mask fallback.',
);
assert.match(
  generationInputWorkerSource,
  /blobs\.map\(\(blob\) => blob \? createImageBitmap\(blob\) : undefined\)/,
  'Each Blob must be passed to createImageBitmap without Array.map index/array arguments.',
);
assert.doesNotMatch(
  generationInputWorkerSource,
  /blobs\.map\(createImageBitmap\)/,
  'Passing createImageBitmap directly to Array.map breaks its overloaded argument resolution.',
);
assert.match(workerSource, /Math\.round\(24 \* scale\)/);
assert.match(workerSource, /Math\.round\(64 \* scale\)/);
assert.match(workerSource, /Math\.round\(minimumDimension \* 0\.25\)/);
assert.match(workerSource, /Math\.round\(dilationRadius \* 0\.2\)/);
assert.match(
  workerSource,
  /if \(authoredStrength\[index\] >= 24\) \{[\s\S]*?candidate\[index\] = 255/,
);
assert.match(
  workerSource,
  /if \(authoredStrength\[index\] >= 96\) \{[\s\S]*?strong\[index\] = 255/,
);
assert.match(
  workerSource,
  /\(\{ core: compositeCore, bounds: coreBounds \} = buildCompositeCoreMask/,
);
assert.match(workerSource, /const dilated = dilateMask\(compositeCore/);
assert.match(workerSource, /if \(compositeCore\[index\] > 0\) submittedMask\[index\] = 255/);

// Execute the complete production Worker. The canvas shim exposes exact RGBA
// instead of PNG encoding; the separate browser check covers real PNG round trips.
class PixelCanvas {
  constructor(width, height) { this.width = width; this.height = height; }
  getContext() {
    return { clearRect() {}, drawImage: bitmap => { this.pixels = bitmap.data; },
      getImageData: () => ({ data: this.pixels, width: this.width, height: this.height }),
      putImageData: pixels => { this.pixels = pixels.data; } };
  }
  async convertToBlob() { return new Blob([this.pixels], { type: 'image/png' }); }
}
const workerRuntime = { postMessage: value => { workerRuntime.result = value; } };
new Function('self', 'OffscreenCanvas', 'ImageData', 'projectionGapMaskFromAlpha', ts.transpileModule(
  workerSource.replace(/^import[^\n]+\n/gm, '').replace(/export \{\};?/, ''),
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } },
).outputText)(workerRuntime, PixelCanvas, class { constructor(data, width, height) { Object.assign(this, { data, width, height }); } }, projectionGapMaskFromAlpha);
const w = 128, h = 96;
const original = new Uint8ClampedArray(w * h * 4);
const selection = new Uint8ClampedArray(original.length);
const strength = new Uint8Array(w * h);
for (let i = 0; i < w * h; i++) {
  original.set([i % 213, i % 137, i % 89, 255], i * 4);
  const x = i % w, y = Math.floor(i / w);
  const value = x >= 33 && x < 70 && y >= 20 && y < 60 ? 255 : 0;
  strength[i] = value;
  selection.set([value, value, value, 255], i * 4);
}
let closed = 0;
const bitmap = data => ({ width: w, height: h, data, close: () => { closed++; } });
await workerRuntime.onmessage({ data: { id: 1, mode: 'local', currentEffect: bitmap(original), inputMask: bitmap(selection) } });
assert.equal(workerRuntime.result.error, undefined, 'ModelView accepts effect + mask without any clay capture');
const marked = new Uint8Array(await workerRuntime.result.compositeBlob.arrayBuffer());
const submitted = new Uint8Array(await workerRuntime.result.submittedMaskBlob.arrayBuffer());
const { core, bounds } = buildCompositeCoreMask(strength, w, h, Math.max(w, h) / 2048);
for (let i = 0; i < w * h; i++) {
  assert.deepEqual([...marked.subarray(i * 4, i * 4 + 4)], core[i] ? [255,255,255,255] : [...original.subarray(i * 4, i * 4 + 4)],
    'Selected pixels are opaque white; every protected pixel stays byte-identical');
}
const radius = workerRuntime.result.dilationRadius, feather = workerRuntime.result.featherRadius;
assert.ok(radius > 0, 'Local repaint restores the remote sampling margin');
assert.ok(feather > 0, 'Remote sampling margin has a feathered edge');
let expandedPixels = 0, featheredPixels = 0;
const expectedMask = boxBlur(dilateMask(core, w, h, radius, bounds), w, h, feather,
  { minX: Math.max(0,bounds.minX-radius), minY: Math.max(0,bounds.minY-radius), maxX: Math.min(w-1,bounds.maxX+radius), maxY: Math.min(h-1,bounds.maxY+radius) });
for (let i = 0; i < expectedMask.length; i++) {
  const expected = core[i] ? 255 : expectedMask[i];
  if (!core[i] && submitted[i*4] > 0) expandedPixels++;
  if (!core[i] && submitted[i*4] > 0 && submitted[i*4] < 255) featheredPixels++;
  assert.deepEqual([...submitted.subarray(i*4,i*4+4)], [expected,expected,expected,255], 'Local sampling mask restores expansion and feathering');
}
assert.ok(expandedPixels > 0, 'Submitted mask extends beyond the write selection');
assert.ok(featheredPixels > 0, 'Submitted margin contains partial coverage');
assert.equal(closed, 2, 'Both transferred bitmaps are released');
await workerRuntime.onmessage({ data: { id: 2, mode: 'local', currentEffect: bitmap(original), inputMask: bitmap(new Uint8ClampedArray(selection.length)) } });
assert.match(workerRuntime.result.error, /蒙版为空/);
assert.equal(closed, 4);

{
// Full production Worker: union only visible geometry with missing texture.
const coverage = new Uint8ClampedArray(original);
const depth = new Uint8ClampedArray(original.length).fill(255);
const authored = new Uint8ClampedArray(selection);
const expectedUnion = new Uint8Array(w * h);
for (let i = 0; i < w * h; i++) {
  const x = i % w, y = Math.floor(i / w), offset = i * 4;
  const visible = x >= 8 && x < 120 && y >= 8 && y < 88 && !(x >= 95 && y >= 70);
  const missing = x >= 80 && x < 100 || (x === 25 && y === 25);
  if (visible) depth.set([100, 20, 0, 255], offset);
  coverage[offset + 3] = visible ? (missing ? (x === 25 ? 254 : 0) : 255) : 0;
  // Real black/white textures must remain protected; RGB never marks a gap.
  if (x < 30 && y > 40) coverage.set([0, 0, 0, 255], offset);
  if (x < 30 && y > 60) coverage.set([255, 255, 255, 255], offset);
  expectedUnion[i] = visible && (strength[i] || coverage[offset + 3] < 255) ? 255 : 0;
}
// Even an accidentally selected background pixel is excluded by frozen depth.
authored.set([255, 255, 255, 255], 0);
const coverageBefore = new Uint8ClampedArray(coverage);
await workerRuntime.onmessage({data:{id:3,mode:'local',currentEffect:bitmap(coverage),inputMask:bitmap(authored),coverageDepth:bitmap(depth)}});
assert.equal(workerRuntime.result.error, undefined);
const union = new Uint8Array(await workerRuntime.result.selectionMaskBlob.arrayBuffer());
const unionGuide = new Uint8Array(await workerRuntime.result.compositeBlob.arrayBuffer());
const unionSubmitted = new Uint8Array(await workerRuntime.result.submittedMaskBlob.arrayBuffer());
for (let i = 0; i < w * h; i++) {
  const offset = i * 4, value = expectedUnion[i];
  assert.deepEqual([...union.subarray(offset, offset + 4)], [value, value, value, 255], 'Unexpanded union preserves selected and visible uncovered pixels only');
  assert.deepEqual([...unionGuide.subarray(offset, offset + 4)], value ? [255,255,255,255] : [...coverageBefore.subarray(offset, offset + 4)], 'Guide marks union white and protects existing unselected texture');
  if (value) assert.equal(unionSubmitted[offset], 255);
  if (depth[offset] === 255) assert.equal(unionSubmitted[offset], 0, 'Sampling margin must not enter background or holes');
}
assert.deepEqual(coverage, coverageBefore, 'Input coverage is immutable');
assert.equal(closed, 7, 'Coverage depth bitmap released with other inputs');
await workerRuntime.onmessage({data:{id:4,mode:'local',currentEffect:bitmap(coverage),inputMask:bitmap(authored),coverageDepth:{...bitmap(depth),width:w-1}}});
assert.match(workerRuntime.result.error, /dimensions differ/);
assert.equal(closed, 10, 'Dimension failure releases all inputs');
const repaintFlow = panelSource.slice(panelSource.indexOf('let currentPaintMaskDataUrl ='), panelSource.indexOf('const rawUserPrompt = localRepaintPrompt.trim()'));
assert.match(repaintFlow, /colorMode: 'flat-target-coverage'/);
assert.match(repaintFlow, /coverageDepthUrl: isGptLocalRepaint \? undefined : capture.depthUrl/);
assert.match(repaintFlow, /currentPaintMaskDataUrl = preparedGenerationInput.selectionMaskUrl \?\? currentPaintMaskDataUrl/);
assert.ok(repaintFlow.indexOf('setPaintMaskDataUrl(') < repaintFlow.indexOf('preparedGenerationInput.selectionMaskUrl'), 'Derived union must not overwrite the live user selection');
assert.match(panelSource, /paintMaskSource: isGptLocalRepaint \? 'user' : 'user-and-visible-gaps-v1'/);

}
assert.match(panelSource, /localRepaintSmartPolish: false/);
assert.match(panelSource, /aria-label="局部重绘智能润色"[\s\S]*?aria-checked=\{localRepaintSmartPolish\}/);
assert.match(panelSource, /\.\.\.\(localRepaintSmartPolish \? \{ prompt: effectivePrompt \} : \{\}\)/);
assert.match(panelSource, /if \(isGptLocalRepaint\) \{\s*const clayPreview = await captureCurrentColorPreview/);
// Execute prompt resolution from the real component with the switch off, stale
// text and throwing cache/network stubs. No old prompt lookup/polish is allowed.
const resolution = panelSource.slice(panelSource.indexOf('let resolvedPrompt = isGptLocalRepaint'), panelSource.indexOf('const effectivePrompt = resolvedPrompt.prompt;') + 'const effectivePrompt = resolvedPrompt.prompt;'.length);
const resolveJs = ts.transpileModule(resolution, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const mustNotRun = () => assert.fail('Default workflow must bypass prompt cache, preparation and Qwen');
const resolveScope = { isGptLocalRepaint: false, localRepaintSmartPolish: false,
  rawUserPrompt: 'stale previous request', localRepaintResolvedPromptCacheRef: { current: { get: mustNotRun } },
  useGenerationStore: { getState: mustNotRun }, prepareLocalRepaintPromptPolishInputs: mustNotRun,
  createLiclickApiClient: mustNotRun, requestAbortController: { signal: { aborted: false } } };
const resolved = await new Function(...Object.keys(resolveScope), `return (async()=>{${resolveJs}; return {effectivePrompt, source:resolvedPrompt.source};})();`)(...Object.values(resolveScope));
assert.deepEqual(resolved, { effectivePrompt: '', source: 'workflow-default' });
let polishCalls = 0;
const cache = new Map();
const enabledScope = { ...resolveScope, localRepaintSmartPolish: true,
  localRepaintResolvedPromptCacheRef: { current: cache },
  useGenerationStore: { getState: () => ({ generations: [] }) },
  materialReference: { id: 'ref', name: 'reference' }, objectId: 'object', objects: [],
  promptFingerprint: 'new-white-policy', requestPrompt: 'repair this part',
  captureCameraSnapshot: {}, promptAnalysisCurrentEffectUrl: 'clean-effect',
  currentPaintMaskDataUrl: 'original-mask', currentPaintMaskRevision: 8,
  useSceneStore: { getState: () => ({ paintMaskRevision: 8 }) },
  setLocalRepaintPreparation() {}, setGenerateNotice() {},
  requestAbortController: new globalThis.AbortController(),
  prepareLocalRepaintPromptPolishInputs: async input => {
    assert.equal(input.currentEffectUrl, 'clean-effect');
    assert.equal(input.maskUrl, 'original-mask');
    return { referenceImage: { name: 'reference' }, currentEffectImage: {}, maskImage: {} };
  },
  createLiclickApiClient: () => ({ polishPrompt: async () => { polishCalls++; return 'polished repair'; } }),
};
const runEnabled = () => new Function(...Object.keys(enabledScope), `return (async()=>{${resolveJs}; return effectivePrompt;})();`)(...Object.values(enabledScope));
assert.equal(await runEnabled(), 'polished repair');
assert.equal(await runEnabled(), 'polished repair');
assert.equal(polishCalls, 1, 'Explicit enable runs Qwen once; same frozen input reuses the new-policy cache');
console.log('Local repaint: pure white pixels, restored remote mask expansion and feathering, no clay input, default-off prompt/cache/network and existing morphology tests passed.');
