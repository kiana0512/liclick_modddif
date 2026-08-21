/* global console, process */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const policyPath = path.join(repoRoot, 'scripts', 'cloud-boundary-policy.json');
const policy = JSON.parse(fs.readFileSync(policyPath, 'utf8'));

if (policy.schemaVersion !== 1) throw new Error('Unsupported cloud boundary policy schema.');

const normalizedAllowlist = new Set(policy.legacyAllowlist.map((value) => value.replaceAll('\\', '/')));
const sourceExtensions = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.mts']);

function listSourceFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) return listSourceFiles(candidate);
    return sourceExtensions.has(path.extname(entry.name)) ? [candidate] : [];
  });
}

const violations = [];
const observedLegacyFiles = new Set();
for (const root of policy.roots) {
  const absoluteRoot = path.resolve(repoRoot, root);
  for (const file of listSourceFiles(absoluteRoot)) {
    const relative = path.relative(repoRoot, file).replaceAll('\\', '/');
    const source = fs.readFileSync(file, 'utf8');
    const references = policy.forbiddenReferences.filter((reference) => source.includes(reference));
    if (references.length === 0) continue;
    observedLegacyFiles.add(relative);
    if (!normalizedAllowlist.has(relative)) {
      violations.push(`${relative}: ${references.join(', ')}`);
    }
  }
}

for (const allowedFile of normalizedAllowlist) {
  if (!fs.existsSync(path.resolve(repoRoot, allowedFile))) {
    violations.push(`${allowedFile}: allowlisted file does not exist`);
  }
}

if (violations.length > 0) {
  console.error('Cloud boundary check failed. New local-runtime dependencies are forbidden:');
  for (const violation of violations) console.error(`- ${violation}`);
  process.exitCode = 1;
} else {
  console.log(
    `Cloud boundary ratchet passed: ${observedLegacyFiles.size} known legacy files, no dependency expansion.`,
  );
}
