import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import type { ServerResponse } from 'node:http';
import {
  getNormalBakeJob,
  getNormalBakeOutputPath,
  type BakeChannelId,
} from './substanceBakeService.js';

const archiveSuffix: Record<BakeChannelId, string> = {
  baseColor: 'BaseColor',
  normal: 'Normal',
  roughness: 'Roughness',
  metallic: 'Metallic',
  ambientOcclusion: 'AO',
  curvature: 'Curvature',
  worldNormal: 'WorldNormal',
  thickness: 'Thickness',
  position: 'Position',
};

const crcTable = new Uint32Array(256);
for (let index = 0; index < crcTable.length; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  crcTable[index] = value >>> 0;
}

function updateCrc32(crc: number, chunk: Buffer) {
  let value = crc;
  for (const byte of chunk) value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
  return value >>> 0;
}

function safeArchiveBase(value: string) {
  const normalized = path
    .basename(value || 'bake')
    .replace(/\.[^.]+$/, '')
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || 'bake';
}

export function getBakeArchive(id: string, userId: string, requestedBase: string) {
  const job = getNormalBakeJob(id, userId);
  if (!job || job.status !== 'succeeded') return undefined;
  const base = safeArchiveBase(requestedBase || job.input.high);
  const entries = job.settings.channels.flatMap((channel) => {
    const filePath = getNormalBakeOutputPath(id, userId, channel);
    if (!filePath || !fs.existsSync(filePath)) return [];
    return [
      {
        path: filePath,
        name: `${base}_${archiveSuffix[channel]}.png`,
        size: fs.statSync(filePath).size,
      },
    ];
  });
  if (entries.length === 0) return undefined;
  return { fileName: `${base}_BakedMaps.zip`, entries };
}

type ZipEntry = { path: string; name: string; size: number };
type CompletedEntry = ZipEntry & { crc: number; localOffset: number };

function localHeader(name: Buffer) {
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0x0808, 6);
  header.writeUInt16LE(0, 8);
  header.writeUInt16LE(0, 10);
  header.writeUInt16LE(0, 12);
  header.writeUInt32LE(0, 14);
  header.writeUInt32LE(0, 18);
  header.writeUInt32LE(0, 22);
  header.writeUInt16LE(name.length, 26);
  header.writeUInt16LE(0, 28);
  return header;
}

function dataDescriptor(crc: number, size: number) {
  const descriptor = Buffer.alloc(16);
  descriptor.writeUInt32LE(0x08074b50, 0);
  descriptor.writeUInt32LE(crc, 4);
  descriptor.writeUInt32LE(size, 8);
  descriptor.writeUInt32LE(size, 12);
  return descriptor;
}

function centralHeader(entry: CompletedEntry, name: Buffer) {
  const header = Buffer.alloc(46);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(20, 6);
  header.writeUInt16LE(0x0808, 8);
  header.writeUInt16LE(0, 10);
  header.writeUInt16LE(0, 12);
  header.writeUInt16LE(0, 14);
  header.writeUInt32LE(entry.crc, 16);
  header.writeUInt32LE(entry.size, 20);
  header.writeUInt32LE(entry.size, 24);
  header.writeUInt16LE(name.length, 28);
  header.writeUInt16LE(0, 30);
  header.writeUInt16LE(0, 32);
  header.writeUInt16LE(0, 34);
  header.writeUInt16LE(0, 36);
  header.writeUInt32LE(0, 38);
  header.writeUInt32LE(entry.localOffset, 42);
  return header;
}

function endOfCentralDirectory(entryCount: number, centralSize: number, centralOffset: number) {
  const footer = Buffer.alloc(22);
  footer.writeUInt32LE(0x06054b50, 0);
  footer.writeUInt16LE(0, 4);
  footer.writeUInt16LE(0, 6);
  footer.writeUInt16LE(entryCount, 8);
  footer.writeUInt16LE(entryCount, 10);
  footer.writeUInt32LE(centralSize, 12);
  footer.writeUInt32LE(centralOffset, 16);
  footer.writeUInt16LE(0, 20);
  return footer;
}

async function write(response: ServerResponse, chunk: Buffer) {
  if (!response.write(chunk)) await once(response, 'drain');
}

export async function streamBakeArchive(response: ServerResponse, entries: ZipEntry[]) {
  let offset = 0;
  const completed: CompletedEntry[] = [];
  for (const entry of entries) {
    if (entry.size > 0xffffffff || offset > 0xffffffff) {
      throw new Error('Bake archive exceeds the ZIP32 size limit.');
    }
    const name = Buffer.from(entry.name, 'utf8');
    const header = localHeader(name);
    const localOffset = offset;
    await write(response, header);
    await write(response, name);
    offset += header.length + name.length;

    let crc = 0xffffffff;
    let bytesRead = 0;
    for await (const chunk of fs.createReadStream(entry.path)) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      crc = updateCrc32(crc, buffer);
      bytesRead += buffer.length;
      await write(response, buffer);
      offset += buffer.length;
    }
    if (bytesRead !== entry.size) throw new Error(`${entry.name} changed while exporting.`);
    crc = (crc ^ 0xffffffff) >>> 0;
    const descriptor = dataDescriptor(crc, entry.size);
    await write(response, descriptor);
    offset += descriptor.length;
    completed.push({ ...entry, crc, localOffset });
  }

  const centralOffset = offset;
  for (const entry of completed) {
    const name = Buffer.from(entry.name, 'utf8');
    const header = centralHeader(entry, name);
    await write(response, header);
    await write(response, name);
    offset += header.length + name.length;
  }
  const centralSize = offset - centralOffset;
  await write(response, endOfCentralDirectory(completed.length, centralSize, centralOffset));
  response.end();
}
