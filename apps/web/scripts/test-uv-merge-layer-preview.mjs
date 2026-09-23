import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sceneRootSource = readFileSync(
  path.join(root, 'src/engine/viewport/SceneRoot.tsx'),
  'utf8',
);
const layersPanelSource = readFileSync(
  path.join(root, 'src/components/panels/LayersPanel.tsx'),
  'utf8',
);

assert.match(
  sceneRootSource,
  /const visibleUvContentChanged = objectUvLayers\.some[\s\S]*?previousLayer\.imageUrl !== layer\.imageUrl[\s\S]*?if \([\s\S]*?visibleUvContentChanged \|\|\s*visibleProjectedContentChanged\s*\)[\s\S]*?setUvVisibilityRenderRevision/,
  'Publishing a merged UV must force one material reconciliation without a page refresh.',
);
assert.doesNotMatch(
  sceneRootSource,
  /reopenedUvLayer|reopenedProjectedLayer/,
  'A resident eye reopen must not be confused with first publication of new UV/projected content.',
);
assert.match(
  sceneRootSource,
  /objectUvLayers\.some\(\(layer\) =>\s*previousLayerVisibilityById\.get\(layer\.id\) !== layer\.visible/,
  'Mixed UV composites and repaint sampler reassignment must reconcile on both eye directions.',
);
assert.match(
  sceneRootSource,
  /function residentUvVisibilityKey\(layers: Layer\[\]\) \{[\s\S]*?return uvLayerStackPreviewSignature\(layers\)/,
  'UV visibility cache identity must include pixel-affecting content rather than layer ids alone.',
);
assert.match(
  sceneRootSource,
  /cachedExactUvTexture \?\?[\s\S]*?compositedUvTextureState\.ready/,
  'An exact completed eye-state cache entry must win without waiting for recomposition.',
);
assert.match(
  sceneRootSource,
  /previousUvPresentation\.key === visibleResidentUvKey/,
  'A pending visibility state must never present a texture from a different authored state.',
);
assert.match(
  sceneRootSource,
  /if \(!exactUvTexture \|\| !visibleResidentUvKey\) return;[\s\S]*?cache\.set\(visibleResidentUvKey, exactUvTexture\)/,
  'Only an exact completed UV composition may be admitted to the visibility cache.',
);

assert.match(
  layersPanelSource,
  /const layers = useLayerStore\(\(state\) => state\.layers\);[\s\S]*?const authoritativeLayers = layers;[\s\S]*?return authoritativeLayers\.find\(\(layer\) => layer\.id === previewLayerId && layer\.imageUrl\)/,
  'Layer image preview must resolve from the authoritative store during the UV-merge handoff.',
);

process.stdout.write('UV-merge layer preview regression test passed.\n');
