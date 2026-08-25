import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const runtimeFiles = [
  new URL('../src/engine/viewport/SceneRoot.tsx', import.meta.url),
  new URL('../src/engine/bake/uvBakeDebugCompare.ts', import.meta.url),
];

for (const file of runtimeFiles) {
  const source = await readFile(file, 'utf8');
  assert.equal(
    source.includes('crypto.randomUUID()'),
    false,
    `${file.pathname} must support HTTP origins where crypto.randomUUID is unavailable`,
  );
  assert.match(source, /createId\(/, `${file.pathname} should use the compatible ID helper`);
}

const idSource = await readFile(new URL('../src/utils/id.ts', import.meta.url), 'utf8');
assert.match(idSource, /typeof crypto !== 'undefined'/);
assert.match(idSource, /Math\.random\(\)/);

console.log('HTTP random UUID compatibility checks passed.');
