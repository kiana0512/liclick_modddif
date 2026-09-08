type ZipFile = {
  path: string;
  data: BlobPart | Blob;
};

const textEncoder = new TextEncoder();

const crcTable = new Uint32Array(256);
for (let index = 0; index < crcTable.length; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  crcTable[index] = value >>> 0;
}

function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function writeUint16(output: number[], value: number) {
  output.push(value & 0xff, (value >>> 8) & 0xff);
}

function writeUint32(output: number[], value: number) {
  output.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
}

function getDosTimestamp(date: Date) {
  const year = Math.max(1980, date.getFullYear());
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

async function bytesFromData(data: BlobPart | Blob) {
  if (data instanceof Blob) return new Uint8Array(await data.arrayBuffer());
  if (typeof data === 'string') return textEncoder.encode(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

export async function createZipBlob(files: ZipFile[]) {
  const now = getDosTimestamp(new Date());
  const chunks: Uint8Array[] = [];
  const centralDirectory: number[] = [];
  let offset = 0;

  for (const file of files) {
    const nameBytes = textEncoder.encode(file.path.replaceAll('\\', '/'));
    const dataBytes = await bytesFromData(file.data);
    const checksum = crc32(dataBytes);
    const localHeader: number[] = [];

    writeUint32(localHeader, 0x04034b50);
    writeUint16(localHeader, 20);
    writeUint16(localHeader, 0x0800);
    writeUint16(localHeader, 0);
    writeUint16(localHeader, now.time);
    writeUint16(localHeader, now.day);
    writeUint32(localHeader, checksum);
    writeUint32(localHeader, dataBytes.byteLength);
    writeUint32(localHeader, dataBytes.byteLength);
    writeUint16(localHeader, nameBytes.byteLength);
    writeUint16(localHeader, 0);
    chunks.push(new Uint8Array([...localHeader, ...nameBytes]), dataBytes);

    writeUint32(centralDirectory, 0x02014b50);
    writeUint16(centralDirectory, 20);
    writeUint16(centralDirectory, 20);
    writeUint16(centralDirectory, 0x0800);
    writeUint16(centralDirectory, 0);
    writeUint16(centralDirectory, now.time);
    writeUint16(centralDirectory, now.day);
    writeUint32(centralDirectory, checksum);
    writeUint32(centralDirectory, dataBytes.byteLength);
    writeUint32(centralDirectory, dataBytes.byteLength);
    writeUint16(centralDirectory, nameBytes.byteLength);
    writeUint16(centralDirectory, 0);
    writeUint16(centralDirectory, 0);
    writeUint16(centralDirectory, 0);
    writeUint16(centralDirectory, 0);
    writeUint32(centralDirectory, 0);
    writeUint32(centralDirectory, offset);
    centralDirectory.push(...nameBytes);

    offset += localHeader.length + nameBytes.byteLength + dataBytes.byteLength;
  }

  const centralOffset = offset;
  const centralBytes = new Uint8Array(centralDirectory);
  chunks.push(centralBytes);
  offset += centralBytes.byteLength;

  const endHeader: number[] = [];
  writeUint32(endHeader, 0x06054b50);
  writeUint16(endHeader, 0);
  writeUint16(endHeader, 0);
  writeUint16(endHeader, files.length);
  writeUint16(endHeader, files.length);
  writeUint32(endHeader, centralBytes.byteLength);
  writeUint32(endHeader, centralOffset);
  writeUint16(endHeader, 0);
  chunks.push(new Uint8Array(endHeader));

  const blobParts = chunks.map((chunk) => {
    const copy = new ArrayBuffer(chunk.byteLength);
    new Uint8Array(copy).set(chunk);
    return copy;
  });
  return new Blob(blobParts, { type: 'application/zip' });
}
