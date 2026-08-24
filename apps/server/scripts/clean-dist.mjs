import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distDir = path.resolve(packageDir, 'dist');

if (path.dirname(distDir) !== packageDir || path.basename(distDir) !== 'dist') {
  throw new Error(`Refusing to clean unexpected output directory: ${distDir}`);
}

// Windows runners and developer machines can briefly retain directory handles
// after the preceding regression process exits. Let Node retry transient
// ENOTEMPTY/EPERM/EBUSY failures instead of turning a successful test run into
// an intermittent pipeline failure.
await fs.rm(distDir, {
  recursive: true,
  force: true,
  maxRetries: 5,
  retryDelay: 100,
});
