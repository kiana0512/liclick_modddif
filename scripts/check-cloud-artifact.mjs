/* global console, process */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifactRoot = path.resolve(repoRoot, process.argv[2] ?? 'apps/web/dist');
const forbiddenExtensions = new Set(['.bat', '.bin', '.cmd', '.dll', '.exe', '.msi', '.ps1']);
const allowedToolboxAssets = new Map([
  ['toolbox/manual_max.html', 1_000],
  ['toolbox/modeling-toolbox-icon.png', 1_000],
  ['toolbox/modeling-toolbox-v2.0.1.exe', 1_000_000],
]);
const textExtensions = new Set(['.css', '.html', '.js', '.json', '.map', '.mjs', '.txt']);
const forbiddenText = [
  '127.0.0.1:4618',
  'localhost:4618',
  '__li3d-local-component',
  'LIclick-3D-Texture-Local-Component-Setup.exe',
  '/api/local-liclick-account',
  '/api/auth/local-proof',
  'x-li3d-identity-proof',
];

if (!fs.existsSync(path.join(artifactRoot, 'index.html'))) {
  throw new Error(`Cloud Web artifact is missing: ${artifactRoot}`);
}

function listFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const candidate = path.join(directory, entry.name);
    return entry.isDirectory() ? listFiles(candidate) : [candidate];
  });
}

const violations = [];
const files = listFiles(artifactRoot);
let totalBytes = 0;
for (const file of files) {
  const relative = path.relative(artifactRoot, file).replaceAll('\\', '/');
  const lowerRelative = relative.toLowerCase();
  const stat = fs.statSync(file);
  totalBytes += stat.size;
  const isAllowedToolboxAsset = allowedToolboxAssets.has(lowerRelative);
  if (
    lowerRelative.includes('local-component') ||
    (lowerRelative.startsWith('toolbox/') && !isAllowedToolboxAsset) ||
    (forbiddenExtensions.has(path.extname(lowerRelative)) && !isAllowedToolboxAsset)
  ) {
    violations.push(`${relative}: forbidden host-extension artifact`);
  }
  if (!textExtensions.has(path.extname(lowerRelative))) continue;
  const source = fs.readFileSync(file, 'utf8');
  for (const reference of forbiddenText) {
    if (source.includes(reference)) violations.push(`${relative}: contains ${reference}`);
  }
}

for (const [relative, minimumBytes] of allowedToolboxAssets) {
  const file = path.join(artifactRoot, ...relative.split('/'));
  if (!fs.existsSync(file)) {
    violations.push(`${relative}: missing optional toolbox asset`);
    continue;
  }
  if (fs.statSync(file).size < minimumBytes) {
    violations.push(`${relative}: optional toolbox asset is unexpectedly small`);
  }
}

if (violations.length > 0) {
  console.error('Cloud artifact verification failed:');
  for (const violation of violations) console.error(`- ${violation}`);
  process.exitCode = 1;
} else {
  console.log(
    `Cloud artifact verified: ${files.length} files, ${(totalBytes / 1024 / 1024).toFixed(2)} MiB, no Li3D host component or loopback bridge; optional toolbox assets are present.`,
  );
}
