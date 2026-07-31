import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const [installerArgument, outputArgument] = process.argv.slice(2);
if (!installerArgument || !outputArgument) {
  throw new Error('Usage: node split-runtime-installer.mjs <installer.exe> <output-directory>');
}

const installerPath = path.resolve(installerArgument);
const outputDirectory = path.resolve(outputArgument);
const chunkSize = 4 * 1024 * 1024;
const installer = fs.readFileSync(installerPath);

fs.rmSync(outputDirectory, { recursive: true, force: true });
fs.mkdirSync(outputDirectory, { recursive: true });

const parts = [];
for (let offset = 0, index = 1; offset < installer.length; offset += chunkSize, index += 1) {
  const chunk = installer.subarray(offset, Math.min(offset + chunkSize, installer.length));
  const file = `part-${String(index).padStart(3, '0')}.bin`;
  fs.writeFileSync(path.join(outputDirectory, file), chunk);
  parts.push({
    file,
    bytes: chunk.length,
    sha256: crypto.createHash('sha256').update(chunk).digest('hex'),
  });
}

const manifest = {
  version: 1,
  filename: 'LIclick 3D Texture Local Component Setup.exe',
  contentType: 'application/vnd.microsoft.portable-executable',
  bytes: installer.length,
  sha256: crypto.createHash('sha256').update(installer).digest('hex'),
  parts,
};
fs.writeFileSync(path.join(outputDirectory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
process.stdout.write(`Split installer into ${parts.length} parts (${installer.length} bytes).\n`);
