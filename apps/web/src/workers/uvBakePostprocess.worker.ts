import {
  dilateImageData,
  fillEnclosedUvCoverageGaps,
  padUvIslandGuttersWithTopology,
} from '@/engine/bake/dilation';

type PostprocessRequest = {
  id: number;
  width: number;
  height: number;
  image: ArrayBuffer;
  coverage: ArrayBuffer;
  seamPairs?: Float32Array;
  repairMissingSeamCoverage: boolean;
  seamBandPixels?: number;
  coverageGapIterations: number;
  interiorHolePixels: number;
  dilationIterations: number;
  gutterPixels: number;
  transparentOutput: boolean;
  conservativeTopology?: Uint8Array;
  coreTopology?: Uint8Array;
  regionIds?: Uint32Array;
  gutterTopology?: Uint8Array;
};

type PostprocessResponse =
  | {
      type: 'result';
      id: number;
      image: ArrayBuffer;
      coverage: ArrayBuffer;
      coverageFilledPixels: number;
      seamPairCount: number;
      seamAdjustedPixels: number;
      interiorFilledPixels: number;
      gutterPaddedPixels: number;
      coverageMs: number;
      seamMs: number;
      interiorMs: number;
      dilationMs: number;
      gutterMs: number;
      totalMs: number;
    }
  | { type: 'error'; id: number; message: string };

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<PostprocessRequest>) => void) | null;
  postMessage(message: PostprocessResponse, transfer?: Transferable[]): void;
};

let workQueue = Promise.resolve();

function inwardPixelNormal(
  startX: number,
  startY: number,
  endX: number,
  endY: number,
  insideX: number,
  insideY: number,
) {
  const edgeX = endX - startX;
  const edgeY = endY - startY;
  const length = Math.hypot(edgeX, edgeY);
  if (length <= 0.0001) return { x: 0, y: 0 };
  let x = -edgeY / length;
  let y = edgeX / length;
  if ((insideX - startX) * x + (insideY - startY) * y < 0) {
    x = -x;
    y = -y;
  }
  return { x, y };
}

function reconcileUvSeams(
  image: ImageData,
  coverage: Uint8Array,
  serializedPairs: Float32Array | undefined,
  repairMissingCoverage: boolean,
  requestedBandPixels?: number,
) {
  if (!serializedPairs?.length) return { pairCount: 0, adjustedPixels: 0 };
  const { width, height, data } = image;
  const source = new Uint8ClampedArray(data);
  const bandPixels = Math.max(
    2,
    Math.min(32, requestedBandPixels ?? Math.round(Math.max(width, height) / 1024)),
  );
  const pairCount = Math.floor(serializedPairs.length / 12);
  let adjustedPixels = 0;
  const pixelIndex = (x: number, y: number) =>
    Math.max(0, Math.min(height - 1, Math.round(y))) * width +
    Math.max(0, Math.min(width - 1, Math.round(x)));
  for (let pairIndex = 0; pairIndex < pairCount; pairIndex += 1) {
    const pairOffset = pairIndex * 12;
    const firstStartX = serializedPairs[pairOffset] * (width - 1);
    const firstStartY = (1 - serializedPairs[pairOffset + 1]) * (height - 1);
    const firstEndX = serializedPairs[pairOffset + 2] * (width - 1);
    const firstEndY = (1 - serializedPairs[pairOffset + 3]) * (height - 1);
    const firstInsideX = serializedPairs[pairOffset + 4] * (width - 1);
    const firstInsideY = (1 - serializedPairs[pairOffset + 5]) * (height - 1);
    const secondStartX = serializedPairs[pairOffset + 6] * (width - 1);
    const secondStartY = (1 - serializedPairs[pairOffset + 7]) * (height - 1);
    const secondEndX = serializedPairs[pairOffset + 8] * (width - 1);
    const secondEndY = (1 - serializedPairs[pairOffset + 9]) * (height - 1);
    const secondInsideX = serializedPairs[pairOffset + 10] * (width - 1);
    const secondInsideY = (1 - serializedPairs[pairOffset + 11]) * (height - 1);
    const firstInward = inwardPixelNormal(
      firstStartX,
      firstStartY,
      firstEndX,
      firstEndY,
      firstInsideX,
      firstInsideY,
    );
    const secondInward = inwardPixelNormal(
      secondStartX,
      secondStartY,
      secondEndX,
      secondEndY,
      secondInsideX,
      secondInsideY,
    );
    const samples = Math.max(
      1,
      Math.ceil(
        Math.max(
          Math.hypot(firstEndX - firstStartX, firstEndY - firstStartY),
          Math.hypot(secondEndX - secondStartX, secondEndY - secondStartY),
        ),
      ),
    );
    for (let sampleIndex = 0; sampleIndex < samples; sampleIndex += 1) {
      const t = (sampleIndex + 0.5) / samples;
      const firstEdgeX = firstStartX + (firstEndX - firstStartX) * t;
      const firstEdgeY = firstStartY + (firstEndY - firstStartY) * t;
      const secondEdgeX = secondStartX + (secondEndX - secondStartX) * t;
      const secondEdgeY = secondStartY + (secondEndY - secondStartY) * t;
      for (let depth = 0; depth < bandPixels; depth += 1) {
        const inwardOffset = depth + 0.35;
        const firstIndex = pixelIndex(
          firstEdgeX + firstInward.x * inwardOffset,
          firstEdgeY + firstInward.y * inwardOffset,
        );
        const secondIndex = pixelIndex(
          secondEdgeX + secondInward.x * inwardOffset,
          secondEdgeY + secondInward.y * inwardOffset,
        );
        const firstOffset = firstIndex * 4;
        const secondOffset = secondIndex * 4;
        const firstCovered = Boolean(coverage[firstIndex] && source[firstOffset + 3]);
        const secondCovered = Boolean(coverage[secondIndex] && source[secondOffset + 3]);
        if (repairMissingCoverage && firstCovered !== secondCovered) {
          const sourceOffset = firstCovered ? firstOffset : secondOffset;
          const targetOffset = firstCovered ? secondOffset : firstOffset;
          const targetIndex = firstCovered ? secondIndex : firstIndex;
          for (let channel = 0; channel < 4; channel += 1) {
            data[targetOffset + channel] = source[sourceOffset + channel];
            source[targetOffset + channel] = source[sourceOffset + channel];
          }
          coverage[targetIndex] = 1;
          adjustedPixels += 1;
          continue;
        }
        if (repairMissingCoverage || !firstCovered || !secondCovered) continue;
        const strength = 0.9 * (1 - depth / bandPixels);
        for (let channel = 0; channel < 3; channel += 1) {
          const average = (source[firstOffset + channel] + source[secondOffset + channel]) * 0.5;
          data[firstOffset + channel] = Math.round(
            source[firstOffset + channel] * (1 - strength) + average * strength,
          );
          data[secondOffset + channel] = Math.round(
            source[secondOffset + channel] * (1 - strength) + average * strength,
          );
        }
        adjustedPixels += firstIndex === secondIndex ? 1 : 2;
      }
    }
  }
  return { pairCount, adjustedPixels };
}

function run(request: PostprocessRequest) {
  const startedAt = performance.now();
  const image = new ImageData(new Uint8ClampedArray(request.image), request.width, request.height);
  const coverage = new Uint8Array(request.coverage);

  const seamStartedAt = performance.now();
  const seam = reconcileUvSeams(
    image,
    coverage,
    request.seamPairs,
    request.repairMissingSeamCoverage,
    request.seamBandPixels,
  );
  const seamMs = performance.now() - seamStartedAt;

  const coverageStartedAt = performance.now();
  const coverageFilledPixels =
    request.coverageGapIterations > 0 && request.conservativeTopology
      ? dilateImageData(
          image,
          coverage,
          request.coverageGapIterations,
          request.conservativeTopology,
          true,
        )
      : 0;
  const coverageMs = performance.now() - coverageStartedAt;

  const interiorStartedAt = performance.now();
  const interiorFilledPixels =
    request.interiorHolePixels > 0 && request.coreTopology
      ? fillEnclosedUvCoverageGaps(
          image,
          coverage,
          request.coreTopology,
          request.interiorHolePixels,
          request.regionIds,
        )
      : 0;
  const interiorMs = performance.now() - interiorStartedAt;

  const dilationStartedAt = performance.now();
  if (request.dilationIterations > 0) {
    dilateImageData(image, coverage, request.dilationIterations);
  }
  const dilationMs = performance.now() - dilationStartedAt;

  const gutterStartedAt = performance.now();
  const gutterPaddedPixels =
    request.gutterPixels > 0 && request.gutterTopology
      ? padUvIslandGuttersWithTopology(
          image,
          coverage,
          request.gutterTopology,
          request.gutterPixels,
          request.transparentOutput,
        )
      : 0;
  const gutterMs = performance.now() - gutterStartedAt;

  return {
    image,
    coverage,
    coverageFilledPixels,
    seamPairCount: seam.pairCount,
    seamAdjustedPixels: seam.adjustedPixels,
    interiorFilledPixels,
    gutterPaddedPixels,
    coverageMs,
    seamMs,
    interiorMs,
    dilationMs,
    gutterMs,
    totalMs: performance.now() - startedAt,
  };
}

scope.onmessage = (event) => {
  const request = event.data;
  workQueue = workQueue
    .then(() => {
      const result = run(request);
      const response: PostprocessResponse = {
        type: 'result',
        id: request.id,
        image: result.image.data.buffer as ArrayBuffer,
        coverage: result.coverage.buffer as ArrayBuffer,
        coverageFilledPixels: result.coverageFilledPixels,
        seamPairCount: result.seamPairCount,
        seamAdjustedPixels: result.seamAdjustedPixels,
        interiorFilledPixels: result.interiorFilledPixels,
        gutterPaddedPixels: result.gutterPaddedPixels,
        coverageMs: result.coverageMs,
        seamMs: result.seamMs,
        interiorMs: result.interiorMs,
        dilationMs: result.dilationMs,
        gutterMs: result.gutterMs,
        totalMs: result.totalMs,
      };
      scope.postMessage(response, [response.image, response.coverage]);
    })
    .catch((error) => {
      scope.postMessage({
        type: 'error',
        id: request.id,
        message: error instanceof Error ? error.message : String(error),
      });
    });
};
