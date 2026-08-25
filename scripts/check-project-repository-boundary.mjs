/* global console */

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const sourceRoot = path.resolve('apps/server/src');
const allowedImporters = new Set([
  path.normalize('repositories/projectRepository.ts'),
  path.normalize('repositories/postgresProjectRepository.ts'),
  path.normalize('services/projectFileService.ts'),
]);

async function listTypeScriptFiles(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const absolute = path.join(directory, entry.name);
      return entry.isDirectory()
        ? listTypeScriptFiles(absolute)
        : Promise.resolve(entry.name.endsWith('.ts') ? [absolute] : []);
    }),
  );
  return nested.flat();
}

const violations = [];
for (const file of await listTypeScriptFiles(sourceRoot)) {
  const relative = path.normalize(path.relative(sourceRoot, file));
  if (allowedImporters.has(relative)) continue;
  const source = await fs.readFile(file, 'utf8');
  if (/from\s+['"][^'"]*projectFileService\.js['"]/.test(source)) {
    violations.push(relative.replaceAll('\\', '/'));
  }
}

if (violations.length > 0) {
  console.error('Project repository boundary violation:');
  for (const file of violations) console.error(`- ${file}`);
  console.error('Import projectRepository instead of projectFileService.');
  process.exitCode = 1;
} else {
  console.log('Project repository boundary passed: persistence is isolated behind repository adapters.');
}
