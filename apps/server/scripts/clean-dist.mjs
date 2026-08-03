import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distDir = path.resolve(packageDir, 'dist');

if (path.dirname(distDir) !== packageDir || path.basename(distDir) !== 'dist') {
  throw new Error(`Refusing to clean unexpected output directory: ${distDir}`);
}

await fs.rm(distDir, { recursive: true, force: true });
