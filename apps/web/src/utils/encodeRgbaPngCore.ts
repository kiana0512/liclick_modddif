import { zlibSync } from 'fflate';

const pngSignature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const textEncoder = new TextEncoder();

function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array) {
  const typeBytes = textEncoder.encode(type);
  const output = new Uint8Array(12 + data.byteLength);
  const view = new DataView(output.buffer);
  view.setUint32(0, data.byteLength);
  output.set(typeBytes, 4);
  output.set(data, 8);
  view.setUint32(8 + data.byteLength, crc32(output.subarray(4, 8 + data.byteLength)));
  return output;
}

export function encodeRgbaPngBytes(
  width: number,
  height: number,
  rgba: Uint8Array | Uint8ClampedArray,
) {
  const rowStride = width * 4;
  if (rgba.byteLength !== rowStride * height) {
    throw new Error('RGBA data size does not match PNG dimensions.');
  }

  const raw = new Uint8Array((rowStride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rawOffset = y * (rowStride + 1);
    const sourceOffset = y * rowStride;
    raw[rawOffset] = 0;
    raw.set(rgba.subarray(sourceOffset, sourceOffset + rowStride), rawOffset + 1);
  }

  const ihdr = new Uint8Array(13);
  const ihdrView = new DataView(ihdr.buffer);
  ihdrView.setUint32(0, width);
  ihdrView.setUint32(4, height);
  ihdr.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA, no interlace.

  const chunks = [
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlibSync(raw, { level: 6 })),
    pngChunk('IEND', new Uint8Array()),
  ];
  const byteLength =
    pngSignature.byteLength + chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const png = new Uint8Array(byteLength);
  let offset = 0;
  png.set(pngSignature, offset);
  offset += pngSignature.byteLength;
  for (const chunk of chunks) {
    png.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return png;
}
