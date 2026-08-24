import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('../', import.meta.url));
const server = await createServer({ root, logLevel: 'silent', server: { middlewareMode: true } });

try {
  const { harmonizeLocalRepaintPixels } = await server.ssrLoadModule(
    '/src/engine/localRepaint/seamHarmonizationCore.ts',
  );
  const { getLocalRepaintSeamMode } = await server.ssrLoadModule(
    '/src/engine/localRepaint/seamHarmonizationMode.ts',
  );
  const previousWindow = globalThis.window;
  globalThis.window = {
    location: { search: '?localRepaintSeamMode=legacy' },
    localStorage: { getItem: () => 'enhanced' },
  };
  assert.equal(getLocalRepaintSeamMode(), 'legacy', 'query switch must bypass enhancements');
  globalThis.window = {
    location: { search: '' },
    localStorage: { getItem: () => 'legacy' },
  };
  assert.equal(getLocalRepaintSeamMode(), 'legacy', 'stored switch must bypass enhancements');
  globalThis.window = {
    location: { search: '' },
    localStorage: { getItem: () => null },
  };
  assert.equal(getLocalRepaintSeamMode(), 'enhanced', 'the calibrated seam mode must be the default');
  globalThis.window = previousWindow;
  const width = 64;
  const height = 64;
  const generated = new Uint8ClampedArray(width * height * 4);
  const reference = new Uint8ClampedArray(width * height * 4);
  const mask = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      generated.set([220, 80, 35, 173], offset);
      reference.set([35, 90, 210, 255], offset);
      const inside = x >= 12 && x < 52 && y >= 12 && y < 52;
      mask.set(inside ? [255, 255, 255, 255] : [0, 0, 0, 255], offset);
    }
  }

  const result = harmonizeLocalRepaintPixels({
    generated,
    reference,
    mask,
    width,
    height,
    options: {
      minBlendWidth: 4,
      maxBlendWidth: 8,
      edgeOpacity: 1,
      enableColorMatch: false,
    },
  });
  assert.equal(result.report.applied, true);
  assert.ok(result.report.blendWidth >= 4 && result.report.blendWidth <= 8);
  const centerOffset = (32 * width + 32) * 4;
  assert.deepEqual(
    Array.from(result.pixels.slice(centerOffset, centerOffset + 4)),
    Array.from(generated.slice(centerOffset, centerOffset + 4)),
    'pixels outside the boundary band must remain byte-identical',
  );
  const boundaryOffset = (12 * width + 24) * 4;
  assert.deepEqual(
    Array.from(result.pixels.slice(boundaryOffset, boundaryOffset + 3)),
    Array.from(generated.slice(boundaryOffset, boundaryOffset + 3)),
    'pixels inside the authored mask must remain the exact generated result',
  );
  assert.equal(
    result.pixels[boundaryOffset + 3],
    generated[boundaryOffset + 3],
    'pixels inside the authored mask must retain generated alpha',
  );
  const falloffOffset = (11 * width + 24) * 4;
  const generatedAlpha = (generated[falloffOffset + 3] ?? 255) / 255;
  const expectedFullSourceOver = [0, 1, 2].map((channel) =>
    Math.round(
      (reference[falloffOffset + channel] ?? 0) * (1 - generatedAlpha) +
        (generated[falloffOffset + channel] ?? 0) * generatedAlpha,
    ),
  );
  assert.deepEqual(
    Array.from(result.pixels.slice(falloffOffset, falloffOffset + 3)),
    expectedFullSourceOver,
    'the first pixel outside the mask must apply no opacity loss beyond the generated alpha itself',
  );
  const decliningFalloffOffset = (10 * width + 24) * 4;
  assert.ok(
    result.pixels[decliningFalloffOffset] > reference[decliningFalloffOffset] &&
      result.pixels[decliningFalloffOffset] < generated[decliningFalloffOffset],
    'opacity must decline only after crossing the authored boundary',
  );
  const outsideOffset = (4 * width + 4) * 4;
  assert.deepEqual(
    Array.from(result.pixels.slice(outsideOffset, outsideOffset + 4)),
    Array.from(reference.slice(outsideOffset, outsideOffset + 4)),
    'pixels outside the authored mask must exactly restore the submitted reference',
  );

  const thinMask = new Uint8ClampedArray(mask.length);
  for (let y = 20; y < 26; y += 1) {
    for (let x = 8; x < 56; x += 1) {
      thinMask.set([255, 255, 255, 255], (y * width + x) * 4);
    }
  }
  const thinResult = harmonizeLocalRepaintPixels({
    generated,
    reference,
    mask: thinMask,
    width,
    height,
    options: {
      minBlendWidth: 4,
      maxBlendWidth: 8,
      edgeOpacity: 1,
      enableColorMatch: false,
    },
  });
  assert.equal(thinResult.report.blendWidth, 4, 'thin masks still keep a narrow outer ring');
  const thinCoreOffset = (22 * width + 24) * 4;
  assert.deepEqual(
    Array.from(thinResult.pixels.slice(thinCoreOffset, thinCoreOffset + 4)),
    Array.from(generated.slice(thinCoreOffset, thinCoreOffset + 4)),
    'the core of a thin mask must remain the exact generated result',
  );

  const fullMask = new Uint8ClampedArray(mask.length).fill(255);
  const fullFrameResult = harmonizeLocalRepaintPixels({
    generated,
    reference,
    mask: fullMask,
    width,
    height,
  });
  assert.equal(fullFrameResult.report.reason, 'full-frame-mask');
  assert.deepEqual(Array.from(fullFrameResult.pixels), Array.from(generated));

  const enhancedWidth = 96;
  const enhancedHeight = 96;
  const enhancedGenerated = new Uint8ClampedArray(enhancedWidth * enhancedHeight * 4);
  const enhancedReference = new Uint8ClampedArray(enhancedGenerated.length);
  const enhancedMask = new Uint8ClampedArray(enhancedGenerated.length);
  for (let y = 0; y < enhancedHeight; y += 1) {
    for (let x = 0; x < enhancedWidth; x += 1) {
      const offset = (y * enhancedWidth + x) * 4;
      const detail = x % 2 === 0 ? 18 : -18;
      enhancedGenerated.set([210 + detail, 65 + detail, 35 + detail, 255], offset);
      const inside = x >= 16 && x < 80 && y >= 16 && y < 80;
      const onObject = x >= 8 && x < 88 && y >= 8 && y < 88;
      enhancedReference.set(
        inside ? [55, 35, 25, 255] : onObject ? [125, 105, 85, 255] : [5, 5, 10, 255],
        offset,
      );
      enhancedMask.set(inside ? [255, 255, 255, 255] : [0, 0, 0, 255], offset);
    }
  }
  const enhanced = harmonizeLocalRepaintPixels({
    generated: enhancedGenerated,
    reference: enhancedReference,
    mask: enhancedMask,
    width: enhancedWidth,
    height: enhancedHeight,
    options: {
      minBlendWidth: 12,
      maxBlendWidth: 40,
      minSampleWidth: 8,
      maxSampleWidth: 32,
      edgeOpacity: 1,
      localSampleCellSize: 64,
      correctionDepth: 48,
      coreColorMatchStrength: 0.35,
      enableColorMatch: true,
    },
  });
  assert.equal(enhanced.report.colorMatchApplied, true, 'the boundary rings must drive Lab matching');
  assert.equal(enhanced.report.blendWidth, 12);
  assert.equal(enhanced.report.sampleWidth, 8);
  assert.ok(enhanced.report.outerSampledPixels > 0, 'the target colour must come from the outer model ring');
  assert.ok(enhanced.report.localColorRegions > 0, 'boundary segments must receive local colour transfers');
  const enhancedCenterA = (48 * enhancedWidth + 48) * 4;
  const enhancedCenterB = enhancedCenterA + 4;
  assert.notDeepEqual(
    Array.from(enhanced.pixels.slice(enhancedCenterA, enhancedCenterA + 3)),
    Array.from(enhancedGenerated.slice(enhancedCenterA, enhancedCenterA + 3)),
    'low-frequency colour must move toward the submission-time preview',
  );
  assert.ok(
    enhanced.pixels[enhancedCenterA] > 100,
    'a dark colour underneath the mask must not drag the whole generated patch toward that hidden colour',
  );
  const weakCore = harmonizeLocalRepaintPixels({
    generated: enhancedGenerated,
    reference: enhancedReference,
    mask: enhancedMask,
    width: enhancedWidth,
    height: enhancedHeight,
    options: {
      minBlendWidth: 12,
      maxBlendWidth: 40,
      minSampleWidth: 8,
      maxSampleWidth: 32,
      edgeOpacity: 1,
      localSampleCellSize: 64,
      correctionDepth: 48,
      coreColorMatchStrength: 0.25,
      enableColorMatch: true,
    },
  });
  const outerTargetRed = 125;
  assert.ok(
    Math.abs((enhanced.pixels[enhancedCenterA] ?? 0) - outerTargetRed) <
      Math.abs((weakCore.pixels[enhancedCenterA] ?? 0) - outerTargetRed),
    'the v10 core must retain a stronger whole-region low-frequency match to the surrounding colour',
  );
  const sourceContrast = enhancedGenerated[enhancedCenterA] - enhancedGenerated[enhancedCenterB];
  const correctedContrast = enhanced.pixels[enhancedCenterA] - enhanced.pixels[enhancedCenterB];
  assert.ok(
    Math.abs(sourceContrast - correctedContrast) <= 2,
    'high-frequency detail contrast must survive the low-frequency correction',
  );
  const enhancedOutside = (2 * enhancedWidth + 2) * 4;
  assert.deepEqual(
    Array.from(enhanced.pixels.slice(enhancedOutside, enhancedOutside + 4)),
    Array.from(enhancedReference.slice(enhancedOutside, enhancedOutside + 4)),
    'pixels outside the outward seam ring must remain byte-identical to the preview',
  );

  const opacityOnly = harmonizeLocalRepaintPixels({
    generated: enhancedGenerated,
    reference: enhancedReference,
    mask: enhancedMask,
    width: enhancedWidth,
    height: enhancedHeight,
    options: {
      minBlendWidth: 12,
      maxBlendWidth: 40,
      edgeOpacity: 1,
      enableColorMatch: false,
    },
  });
  const firstOutside = (48 * enhancedWidth + 15) * 4;
  assert.deepEqual(
    Array.from(opacityOnly.pixels.slice(firstOutside, firstOutside + 4)),
    Array.from(enhancedGenerated.slice(firstOutside, firstOutside + 4)),
    'the outer opacity ramp must begin at 100% generated content',
  );
  assert.equal(opacityOnly.report.innerBlendWidth, 0);
  const firstInside = (48 * enhancedWidth + 16) * 4;
  assert.deepEqual(
    Array.from(opacityOnly.pixels.slice(firstInside, firstInside + 4)),
    Array.from(enhancedGenerated.slice(firstInside, firstInside + 4)),
    'even the first pixel inside the authored mask must be 100% new content',
  );
  const outwardTransition = (48 * enhancedWidth + 10) * 4;
  assert.ok(
    opacityOnly.pixels[outwardTransition] > enhancedReference[outwardTransition] &&
      opacityOnly.pixels[outwardTransition] < enhancedGenerated[outwardTransition],
    'the sole opacity transition must live outside the authored mask',
  );
  assert.deepEqual(
    Array.from(opacityOnly.pixels.slice(enhancedCenterA, enhancedCenterA + 4)),
    Array.from(enhancedGenerated.slice(enhancedCenterA, enhancedCenterA + 4)),
    'the generated core must remain byte-identical when colour matching is disabled',
  );
  console.log('Local repaint seam harmonization invariants passed.');
} finally {
  await server.close();
}
