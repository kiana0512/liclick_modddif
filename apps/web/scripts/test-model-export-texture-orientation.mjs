import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { stdout } from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = await readFile(path.join(root, 'src/engine/export/exportGltf.ts'), 'utf8');
const textureBinding = source.indexOf('const { root, texture } = await prepareTexturedModelExport(input);');
const orientationFix = source.indexOf('texture.flipY = true;');
const gltfExport = source.indexOf('exporter.parseAsync(root');

assert(textureBinding >= 0, 'GLB export must retain the prepared Li3D texture handle.');
assert(
  orientationFix > textureBinding && orientationFix < gltfExport,
  'Li3D canvas-space BaseColor must be vertically converted before GLTFExporter serializes it.',
);

stdout.write('Model export texture-orientation regression checks passed.\n');
