import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const server = await createServer({
  root,
  appType: 'custom',
  logLevel: 'silent',
  server: { middlewareMode: true },
});

function createClosedBoxFixture() {
  const faces = [
    { normal: [1, 0, 0], vertices: [[1, -1, -1], [1, 1, -1], [1, 1, 1], [1, -1, 1]] },
    { normal: [-1, 0, 0], vertices: [[-1, -1, 1], [-1, 1, 1], [-1, 1, -1], [-1, -1, -1]] },
    { normal: [0, 1, 0], vertices: [[-1, 1, -1], [-1, 1, 1], [1, 1, 1], [1, 1, -1]] },
    { normal: [0, -1, 0], vertices: [[-1, -1, 1], [-1, -1, -1], [1, -1, -1], [1, -1, 1]] },
    { normal: [0, 0, 1], vertices: [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]] },
    { normal: [0, 0, -1], vertices: [[1, -1, -1], [-1, -1, -1], [-1, 1, -1], [1, 1, -1]] },
  ];
  const positions = [];
  const lowNormals = [];
  const highNormals = [];
  const indices = [];
  const uvs = [];
  faces.forEach((face, faceIndex) => {
    const vertexOffset = positions.length / 3;
    const column = faceIndex % 3;
    const row = Math.floor(faceIndex / 3);
    const u0 = column / 3 + 0.025;
    const u1 = (column + 1) / 3 - 0.025;
    const v0 = row / 2 + 0.025;
    const v1 = (row + 1) / 2 - 0.025;
    const faceUvs = [[u0, v0], [u1, v0], [u1, v1], [u0, v1]];
    face.vertices.forEach((vertex, vertexIndex) => {
      positions.push(...vertex);
      lowNormals.push(...face.normal);
      const length = Math.hypot(...vertex);
      highNormals.push(vertex[0] / length, vertex[1] / length, vertex[2] / length);
      uvs.push(...faceUvs[vertexIndex]);
    });
    indices.push(
      vertexOffset, vertexOffset + 1, vertexOffset + 2,
      vertexOffset, vertexOffset + 2, vertexOffset + 3,
    );
  });
  return {
    high: {
      positions: new Float32Array(positions),
      normals: new Float32Array(highNormals),
      indices: new Uint32Array(indices),
    },
    low: [{
      positions: new Float32Array(positions),
      normals: new Float32Array(lowNormals),
      indices: new Uint32Array(indices),
      uvs: new Float32Array(uvs),
    }],
  };
}

function opaquePixelCount(output) {
  let count = 0;
  for (let index = 3; index < output.length; index += 4) {
    if (output[index] > 0) count += 1;
  }
  return count;
}

function channelRange(output, component) {
  let min = 255;
  let max = 0;
  for (let offset = 0; offset < output.length; offset += 4) {
    if (!output[offset + 3]) continue;
    min = Math.min(min, output[offset + component]);
    max = Math.max(max, output[offset + component]);
  }
  return max - min;
}

try {
  const { bakePbrMapsLocally } = await server.ssrLoadModule(
    '/src/engine/bake/localPbrBakeCore.ts',
  );
  const positions = new Float32Array([
    -1, -1, 0,
    1, -1, 0,
    1, 1, 0,
    -1, 1, 0,
  ]);
  const normals = new Float32Array([
    0, 0, 1,
    0, 0, 1,
    0, 0, 1,
    0, 0, 1,
  ]);
  const indices = new Uint32Array([0, 1, 2, 0, 2, 3]);
  const uvs = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]);
  const result = bakePbrMapsLocally({
    high: { positions, normals, indices, uvs: uvs.slice() },
    low: [{ positions: positions.slice(), normals: normals.slice(), indices: indices.slice(), uvs }],
    baseColor: {
      width: 2,
      height: 2,
      data: new Uint8ClampedArray([
        17, 31, 47, 255, 17, 31, 47, 255,
        17, 31, 47, 255, 17, 31, 47, 255,
      ]),
    },
    resolution: 32,
    padding: 2,
    frontalDistance: 0.1,
    rearDistance: 0.1,
    normalOrientation: 'directx',
    aoSamples: 4,
    channels: ['baseColor', 'normal', 'ambientOcclusion', 'worldNormal', 'position'],
  });
  assert.equal(result.triangleCount, 2);
  assert.ok(result.coveredPixels > 800);
  assert.equal(result.missedPixels, 0);
  const center = (16 * 32 + 16) * 4;
  const normal = result.outputs.normal;
  const ao = result.outputs.ambientOcclusion;
  const baseColor = result.outputs.baseColor;
  assert.ok(normal);
  assert.ok(ao);
  assert.ok(baseColor);
  assert.deepEqual(Array.from(baseColor.slice(center, center + 4)), [17, 31, 47, 255]);
  assert.ok(Math.abs(normal[center] - 128) <= 1);
  assert.ok(Math.abs(normal[center + 1] - 128) <= 1);
  assert.equal(normal[center + 2], 255);
  assert.equal(normal[center + 3], 255);
  assert.equal(ao[center], 255);
  assert.equal(ao[center + 3], 255);

  const closedBox = createClosedBoxFixture();
  const channels = ['normal', 'ambientOcclusion', 'curvature', 'worldNormal', 'position', 'thickness'];
  const matrix = bakePbrMapsLocally({
    ...closedBox,
    resolution: 96,
    padding: 3,
    frontalDistance: 0.2,
    rearDistance: 0.2,
    normalOrientation: 'directx',
    aoSamples: 8,
    channels,
  });
  assert.equal(matrix.triangleCount, 12);
  assert.ok(matrix.coveredPixels > 5_000);
  assert.equal(matrix.missedPixels, 0);
  assert.equal(matrix.overlapPixels, 0);
  for (const channel of channels) {
    const output = matrix.outputs[channel];
    assert.ok(output, `${channel} output is missing`);
    assert.equal(output.length, 96 * 96 * 4);
    assert.ok(opaquePixelCount(output) > matrix.coveredPixels);
  }
  assert.ok(channelRange(matrix.outputs.worldNormal, 0) > 200);
  assert.ok(channelRange(matrix.outputs.worldNormal, 1) > 200);
  assert.ok(channelRange(matrix.outputs.worldNormal, 2) > 200);
  assert.ok(channelRange(matrix.outputs.position, 0) > 200);
  assert.ok(channelRange(matrix.outputs.position, 1) > 200);
  assert.ok(channelRange(matrix.outputs.position, 2) > 200);
  assert.ok(channelRange(matrix.outputs.thickness, 0) > 10);
  assert.ok(opaquePixelCount(matrix.outputs.curvature) > matrix.coveredPixels);
  assert.ok(
    matrix.outputs.curvature.some((value, offset) => offset % 4 !== 3 && value > 128),
    'closed convex geometry should produce a positive curvature signal',
  );
  for (let offset = 0; offset < matrix.outputs.thickness.length; offset += 4) {
    if (!matrix.outputs.thickness[offset + 3]) continue;
    assert.equal(matrix.outputs.thickness[offset], matrix.outputs.thickness[offset + 1]);
    assert.equal(matrix.outputs.thickness[offset], matrix.outputs.thickness[offset + 2]);
  }

  const openGl = bakePbrMapsLocally({
    ...closedBox,
    resolution: 96,
    padding: 0,
    frontalDistance: 0.2,
    rearDistance: 0.2,
    normalOrientation: 'opengl',
    aoSamples: 0,
    channels: ['normal'],
  });
  let orientationSample = -1;
  for (let offset = 0; offset < matrix.outputs.normal.length; offset += 4) {
    if (
      matrix.outputs.normal[offset + 3]
      && openGl.outputs.normal[offset + 3]
      && Math.abs(matrix.outputs.normal[offset + 1] - 128) > 12
    ) {
      orientationSample = offset;
      break;
    }
  }
  assert.ok(orientationSample >= 0, 'fixture did not produce an orientation-sensitive normal');
  assert.ok(
    Math.abs(
      matrix.outputs.normal[orientationSample + 1]
      + openGl.outputs.normal[orientationSample + 1]
      - 255,
    ) <= 2,
    `DirectX/OpenGL green channels are ${matrix.outputs.normal[orientationSample + 1]} and ${openGl.outputs.normal[orientationSample + 1]}`,
  );

  const tinyUvScale = 1 / 4095;
  const fourK = bakePbrMapsLocally({
    high: { positions, normals, indices, uvs: uvs.slice() },
    low: [{
      positions: new Float32Array([-1, -1, 0, 1, -1, 0, -1, 1, 0]),
      normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
      indices: new Uint32Array([0, 1, 2]),
      uvs: new Float32Array([0, 0, tinyUvScale, 0, 0, tinyUvScale]),
    }],
    resolution: 4096,
    padding: 0,
    frontalDistance: 0.1,
    rearDistance: 0.1,
    normalOrientation: 'directx',
    aoSamples: 0,
    channels: ['curvature'],
  });
  assert.equal(fourK.width, 4096);
  assert.equal(fourK.height, 4096);
  assert.equal(fourK.outputs.curvature.length, 4096 * 4096 * 4);
  assert.ok(fourK.coveredPixels >= 1);
  assert.ok(
    fourK.outputs.curvature.some((value, offset) => offset % 4 !== 3 && value === 128),
    'flat 4K fixture should encode neutral curvature',
  );

  console.log('Local BVH PBR bake Base Color, curvature, six-channel closed-box and 4K matrix passed.');
} finally {
  await server.close();
}
