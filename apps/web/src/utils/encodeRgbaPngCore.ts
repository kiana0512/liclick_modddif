import { Zlib, zlibSync } from 'fflate';

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

/** Same lossless RGBA PNG format as encodeRgbaPngBytes, but feeds zlib in
 * bounded row groups. Worker callers can yield between groups so 4K encoding
 * does not monopolize the browser process or create a 60MB temporary raw scan
 * buffer in one allocation. */
export async function encodeRgbaPngBytesChunked(
  width: number,
  height: number,
  rgba: Uint8Array | Uint8ClampedArray,
  yieldControl: () => Promise<void>,
) {
  const rowStride = width * 4;
  if (rgba.byteLength !== rowStride * height) {
    throw new Error('RGBA data size does not match PNG dimensions.');
  }
  const compressedChunks: Uint8Array[] = [];
  let compressedLength = 0;
  const zlib = new Zlib({ level: 6 }, (chunk) => {
    compressedChunks.push(chunk);
    compressedLength += chunk.byteLength;
  });
  const rowsPerChunk = 16;
  for (let firstRow = 0; firstRow < height; firstRow += rowsPerChunk) {
    const rowCount = Math.min(rowsPerChunk, height - firstRow);
    const raw = new Uint8Array((rowStride + 1) * rowCount);
    for (let localRow = 0; localRow < rowCount; localRow += 1) {
      const sourceOffset = (firstRow + localRow) * rowStride;
      const rawOffset = localRow * (rowStride + 1);
      raw[rawOffset] = 0;
      raw.set(rgba.subarray(sourceOffset, sourceOffset + rowStride), rawOffset + 1);
    }
    const final = firstRow + rowCount >= height;
    zlib.push(raw, final);
    if (!final) await yieldControl();
  }
  const compressed = new Uint8Array(compressedLength);
  let compressedOffset = 0;
  compressedChunks.forEach((chunk) => {
    compressed.set(chunk, compressedOffset);
    compressedOffset += chunk.byteLength;
  });
  const ihdr = new Uint8Array(13);
  const ihdrView = new DataView(ihdr.buffer);
  ihdrView.setUint32(0, width);
  ihdrView.setUint32(4, height);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const chunks = [
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', compressed),
    pngChunk('IEND', new Uint8Array()),
  ];
  const byteLength =
    pngSignature.byteLength + chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const png = new Uint8Array(byteLength);
  let offset = 0;
  png.set(pngSignature, offset);
  offset += pngSignature.byteLength;
  chunks.forEach((chunk) => {
    png.set(chunk, offset);
    offset += chunk.byteLength;
  });
  return png;
}
