import assert from 'node:assert/strict';
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
const panelPath = path.resolve(scriptDirectory, '../src/components/panels/GeneratePanel.tsx');
const editorPagePath = path.resolve(scriptDirectory, '../src/routes/EditorPage.tsx');
const pngCorePath = path.resolve(scriptDirectory, '../src/utils/encodeRgbaPngCore.ts');
const workerSource = fs.readFileSync(workerPath, 'utf8');
const panelSource = fs.readFileSync(panelPath, 'utf8');
const editorPageSource = fs.readFileSync(editorPagePath, 'utf8');
const pngCoreSource = fs.readFileSync(pngCorePath, 'utf8');
const privateCoreSource = `${workerSource.slice(0, workerSource.indexOf('self.onmessage'))}
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
  /prepareLocalRepaintGenerationInput\(\{[\s\S]*?currentEffectUrl: flatCurrentEffectUrl,[\s\S]*?clayPreviewUrl,[\s\S]*?authoredMaskUrl: currentPaintMaskDataUrl/,
  'ModelView input must use the authored-effect/clay composite.',
);
assert.match(
  panelSource,
  /prepareLocalRepaintPromptPolishInputs\(\{[\s\S]*?currentEffectUrl: promptAnalysisCurrentEffectUrl,[\s\S]*?maskUrl: currentPaintMaskDataUrl/,
  'Qwen must use the clean effect and original authored mask.',
);
assert.match(
  panelSource,
  /urlToDataUrl\(preparedGenerationInput\.submittedMaskUrl\)/,
  'Only ModelView should receive the expanded/feathered mask.',
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
  /const \{ core: compositeCore, bounds: coreBounds \} = buildCompositeCoreMask/,
);
assert.match(workerSource, /const dilated = dilateMask\(compositeCore/);
assert.match(workerSource, /if \(compositeCore\[index\] > 0\) submittedMask\[index\] = 255/);

console.log('Local repaint generation input tests passed.');
