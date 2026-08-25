import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { stdout } from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(root, 'src/routes/BakeWorkspacePage.tsx'), 'utf8');

const oneClickStart = source.indexOf('function OneClickAssetCard');
const oneClickEnd = source.indexOf('function ConceptPanel', oneClickStart);
assert.ok(oneClickStart >= 0 && oneClickEnd > oneClickStart, 'OneClickAssetCard source is missing.');
const oneClickAssetCard = source.slice(oneClickStart, oneClickEnd);

assert.doesNotMatch(
  oneClickAssetCard,
  /\bpreview\b/,
  'One-click bake asset cards must not accept a decorative preview image.',
);
assert.doesNotMatch(
  oneClickAssetCard,
  /<img\b/,
  'One-click bake asset cards must not render a background preview image.',
);
assert.doesNotMatch(source, /preview=\{project\?\.thumbnail\}/);
assert.doesNotMatch(source, /preview=\{selectedProjectColor\?\.imageUrl\}/);

const materialSlotStart = source.indexOf('function MaterialMapSlot');
assert.ok(materialSlotStart >= 0 && materialSlotStart < oneClickStart, 'MaterialMapSlot source is missing.');
const materialMapSlot = source.slice(materialSlotStart, oneClickStart);
assert.match(
  materialMapSlot,
  /previewUrl\?: string/,
  'The material-management dialog must retain imported texture thumbnails.',
);
assert.match(materialMapSlot, /<img src=\{previewUrl\}/);

assert.match(
  source,
  /resultLightboxOpen && selectedResultUrl/,
  'The full-size bake result lightbox must remain available.',
);
assert.ok(
  (source.match(/src=\{selectedResultUrl\}/g) ?? []).length >= 2,
  'The completed bake result preview and lightbox must remain rendered.',
);

stdout.write('Bake asset-card preview policy regression test passed.\n');
