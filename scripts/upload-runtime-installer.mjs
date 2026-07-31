import { createReadStream, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const installerPath =
  process.argv[2] ??
  path.join(root, 'dist-installer', 'Liclick 3D Texture Setup 2026.07.22.1130.exe');
const siteUrl = (process.env.LI3D_INSTALLER_SITE_URL ?? '').replace(/\/$/, '');
const token = process.env.LI3D_INSTALLER_UPLOAD_TOKEN;
const chunkSize = 32 * 1024 * 1024;

if (!siteUrl) throw new Error('LI3D_INSTALLER_SITE_URL is required.');
if (!token) throw new Error('LI3D_INSTALLER_UPLOAD_TOKEN is required.');
if (!existsSync(installerPath)) throw new Error(`Installer not found: ${installerPath}`);

const uploadRoute = `${siteUrl}/api/internal/installers/windows-x64/multipart`;
const headers = { authorization: `Bearer ${token}` };

async function expectJson(response) {
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${body}`);
  }
  return body ? JSON.parse(body) : {};
}

const start = await expectJson(
  await fetch(`${uploadRoute}/start`, { method: 'POST', headers }),
);
const parts = [];

try {
  const size = statSync(installerPath).size;
  const partCount = Math.ceil(size / chunkSize);
  for (let index = 0; index < partCount; index += 1) {
    const partNumber = index + 1;
    const startByte = index * chunkSize;
    const endByte = Math.min(size - 1, startByte + chunkSize - 1);
    const response = await fetch(
      `${uploadRoute}/part/${encodeURIComponent(start.uploadId)}/${partNumber}`,
      {
        method: 'PUT',
        headers,
        body: createReadStream(installerPath, { start: startByte, end: endByte }),
        duplex: 'half',
      },
    );
    parts.push(await expectJson(response));
    process.stdout.write(`Uploaded ${partNumber}/${partCount}\n`);
  }

  const completed = await expectJson(
    await fetch(`${uploadRoute}/complete`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ uploadId: start.uploadId, parts }),
    }),
  );
  process.stdout.write(`Published ${completed.key} (${completed.size} bytes)\n`);
} catch (error) {
  await fetch(`${uploadRoute}/abort`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ uploadId: start.uploadId }),
  }).catch(() => {});
  throw error;
}
