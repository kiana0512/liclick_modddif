import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import * as THREE from 'three';
import ts from 'typescript';

const source = await fs.readFile(new URL('../src/engine/projection/ProjectedLayerMaterial.ts', import.meta.url), 'utf8');
const declarations = ['PREPARED_TEXTURE_PROFILE_KEY', 'UV_OVERLAY_TEXTURE_PROFILE'].map(name => source.match(new RegExp(`const ${name} = [^;]+;`))[0]).join('\n');
const helpers = source.slice(source.indexOf('function prepareUvTexture('), source.indexOf('function prepareLiveEraserMaskTexture('));
const code = ts.transpileModule(declarations + helpers, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const { prepareUvTexture, prepareRenderedColorMaskTexture } = new Function('THREE', code + ';return { prepareUvTexture, prepareRenderedColorMaskTexture };')(THREE);
for (const flipY of [false, true]) {
  const bytes = new Uint8Array([12, 37, 199, 127]);
  const texture = new THREE.DataTexture(bytes, 1, 1);
  texture.flipY = flipY;
  prepareRenderedColorMaskTexture(texture);
  const initialVersion = texture.version;
  for (let index = 0; index < 1000; index++) prepareRenderedColorMaskTexture(texture);
  assert.equal(texture.version, initialVersion, 'an unchanged rendered-color mask must not be re-uploaded on each material update');
  assert.equal(texture.colorSpace, THREE.NoColorSpace);
  assert.equal(texture.flipY, flipY);
  assert.equal(texture.minFilter, THREE.LinearFilter);
  assert.equal(texture.generateMipmaps, false);
  assert.deepEqual([...texture.image.data], [12, 37, 199, 127]);
  // Content owners still request uploads; preparation must not consume that revision.
  bytes[0] = 81;
  texture.needsUpdate = true;
  const changedVersion = texture.version;
  prepareRenderedColorMaskTexture(texture);
  assert.equal(texture.version, changedVersion);
  assert.equal(texture.image.data[0], 81);
  for (let cycle = 0; cycle < 20; cycle++) {
    prepareUvTexture(texture);
    assert.equal(texture.colorSpace, THREE.SRGBColorSpace);
    const uvVersion = texture.version;
    prepareUvTexture(texture);
    assert.equal(texture.version, uvVersion);
    prepareRenderedColorMaskTexture(texture);
    assert.equal(texture.colorSpace, THREE.NoColorSpace);
    assert.ok(texture.version > uvVersion, 'changing sampling color space must schedule the required upload');
  }
  texture.dispose();
}
console.log('Projected texture preparation passed: 2,000 repeated mask preparations, content revisions, UV/mask color-space transitions, orientation and bytes.');
