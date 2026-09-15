import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';

const runtimeFiles = [
  new URL('../src/engine/viewport/SceneRoot.tsx', import.meta.url),
  new URL('../src/engine/bake/uvBakeDebugCompare.ts', import.meta.url),
  new URL('../src/engine/bake/UvContributionArchive.ts', import.meta.url),
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

// Execute the actual archive constructor and ID helper with HTTP-like globals.
// Its GPU and IndexedDB operations must not be needed during initialization.
const archiveSource = await readFile(new URL('../src/engine/bake/UvContributionArchive.ts', import.meta.url), 'utf8');
const compile = source => ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
for (const globals of [{}, { crypto: {} }, { crypto: { randomUUID: () => 'native-uuid' } }]) {
  const context = vm.createContext(globals);
  const load = (source, dependencies = {}) => {
    const exports = {};
    const factory = vm.runInContext(`(function(exports, require) { ${compile(source)}\n})`, context);
    factory(exports, name => {
      assert.ok(Object.hasOwn(dependencies, name), `Unexpected import: ${name}`);
      return dependencies[name];
    });
    return exports;
  };
  const id = load(idSource);
  const { UvContributionArchive } = load(archiveSource, {
    three: {}, './uvContributionTiles': {}, '@/utils/browserScheduling': {}, '@/utils/id': id,
  });
  const owners = new Set();
  for (let index = 0; index < 1000; index++) {
    const archive = new UvContributionArchive();
    assert.equal(archive.has('unseen'), false);
    assert.equal(typeof archive.owner, 'string');
    assert.ok(archive.owner.length > 0);
    owners.add(archive.owner);
  }
  if (globals.crypto?.randomUUID) assert.deepEqual([...owners], ['native-uuid']);
  else assert.equal(owners.size, 1000, 'HTTP archive owners must remain isolated');
}

console.log('HTTP random UUID compatibility checks passed.');
