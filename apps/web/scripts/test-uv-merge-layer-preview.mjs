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
  /const visibleUvContentChanged = objectUvLayers\.some[\s\S]*?previousLayer\.imageUrl !== layer\.imageUrl[\s\S]*?if \(\s*reopenedUvLayer \|\|[\s\S]*?reopenedProjectedLayer \|\|\s*visibleUvContentChanged \|\|\s*visibleProjectedContentChanged\s*\)[\s\S]*?setUvVisibilityRenderRevision/,
  'Publishing a merged UV must force one material reconciliation without a page refresh.',
);
assert.match(
  sceneRootSource,
  /objectUvLayers\.some\(\(layer\) =>\s*\(hasLowerRepaintUv \|\| isRenderedLocalRepaintLayer\(layer\)\) &&\s*previousLayerVisibilityById\.get\(layer\.id\) !== layer\.visible/,
  'Mixed UV composites and repaint sampler reassignment must reconcile on both eye directions.',
);

assert.match(
  layersPanelSource,
  /const layers = useLayerStore\(\(state\) => state\.layers\);[\s\S]*?const authoritativeLayers = layers;[\s\S]*?return authoritativeLayers\.find\(\(layer\) => layer\.id === previewLayerId && layer\.imageUrl\)/,
  'Layer image preview must resolve from the authoritative store during the UV-merge handoff.',
);

process.stdout.write('UV-merge layer preview regression test passed.\n');
