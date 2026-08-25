import fs from 'node:fs';
import path from 'node:path';

const [sourceRootArgument, destinationRootArgument] = process.argv.slice(2);
if (!sourceRootArgument || !destinationRootArgument) {
  throw new Error('Usage: node copy-local-component-runtime.mjs <source-dist> <destination-dist>');
}

const sourceRoot = path.resolve(sourceRootArgument);
const destinationRoot = path.resolve(destinationRootArgument);
const pending = [path.join(sourceRoot, 'localComponent.js')];
const copied = new Set();
const importPattern = /(?:from\s*|import\s*)['"](\.[^'"]+)['"]/g;

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

while (pending.length > 0) {
  const sourceFile = path.resolve(pending.pop());
  if (copied.has(sourceFile)) continue;
  if (!isWithin(sourceRoot, sourceFile) || !fs.existsSync(sourceFile)) {
    throw new Error(`Local runtime import is missing or outside server dist: ${sourceFile}`);
  }

  copied.add(sourceFile);
  const relative = path.relative(sourceRoot, sourceFile);
  const destination = path.join(destinationRoot, relative);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(sourceFile, destination);

  const source = fs.readFileSync(sourceFile, 'utf8');
  for (const match of source.matchAll(importPattern)) {
    const imported = match[1];
    if (!imported.endsWith('.js')) continue;
    pending.push(path.resolve(path.dirname(sourceFile), imported));
  }
}

process.stdout.write(`Copied ${copied.size} local runtime modules.\n`);
