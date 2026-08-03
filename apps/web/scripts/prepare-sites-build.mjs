/* global URL */
import { copyFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const projectDir = fileURLToPath(new URL('..', import.meta.url));
const serverDir = path.join(projectDir, 'dist', 'server');

await mkdir(serverDir, { recursive: true });
await copyFile(
  path.join(projectDir, 'worker', 'sites-worker.js'),
  path.join(serverDir, 'index.js'),
);
