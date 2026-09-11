import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(
  new URL('../src/components/panels/LayersPanel.tsx', import.meta.url),
  'utf8',
);
const menuSource = source.slice(source.indexOf('function LayerMenu('));
const eraserPolicySource = await readFile(
  new URL('../src/engine/paint/eraserTargetPolicy.ts', import.meta.url),
  'utf8',
);
const viewportSource = await readFile(
  new URL('../src/engine/viewport/ViewportCanvas.tsx', import.meta.url),
  'utf8',
);
const sceneRootSource = await readFile(
  new URL('../src/engine/viewport/SceneRoot.tsx', import.meta.url),
  'utf8',
);

assert.match(
  source,
  /function getLocalRepaintPreviewMaskUrl[\s\S]{0,220}return layer\.localRepaintMaskUrl \|\| layer\.maskUrl;/,
  'local repaint thumbnails must prefer the authored brush mask over the blend mask',
);
// Exercise the real render branches instead of matching one spelling of the
// fail-closed guard. Simplifying that guard must preserve authored coverage.
const tree = ts.createSourceFile('LayersPanel.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const thumbnail = tree.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'VisibleLayerThumbnail');
const maskSource = tree.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'getLocalRepaintPreviewMaskUrl');
const renderThumbnail = new Function('React','useRef','useEffect','useProjectedLayerDisplayPreview',
  'isLocalRepaintPreviewLayer','getLiveProjectedTextureSourceState','getLiveProjectedCanvasState','useLayerImageSource',
  ts.transpileModule(maskSource.getText(tree) + '\n' + thumbnail.getText(tree), {
    compilerOptions:{target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React},
  }).outputText + '\nreturn VisibleLayerThumbnail;')(
  {createElement:(type,props)=>({type,props})}, () => ({current:null}), () => {}, () => undefined,
  layer => Boolean(layer.generationId?.startsWith('local-repaint-')), () => undefined,
  url => url === 'live:mask' ? {canvas:{}} : undefined, () => undefined,
);
const localLayer = {type:'projected',imageUrl:'returned-image',generationId:'local-repaint-test'};
assert.equal(renderThumbnail({layer:localLayer}),null,'Legacy local repaint without a mask must fail closed');
assert.equal(renderThumbnail({layer:{...localLayer,generationId:undefined}}),null,'Pending ordinary thumbnails must not decode the full original');
for(const mask of [{localRepaintMaskUrl:'brush-mask',maskUrl:'blend-mask'},{maskUrl:'legacy-mask'}]) {
  const rendered = renderThumbnail({layer:{...localLayer,...mask}});
  assert.equal(rendered.type,'img');
  assert.equal(rendered.props.src,'returned-image');
  assert.equal(rendered.props.style.maskImage,`url("${mask.localRepaintMaskUrl ?? mask.maskUrl}")`);
  assert.equal(rendered.props.style.WebkitMaskImage,rendered.props.style.maskImage);
}
assert.equal(renderThumbnail({layer:{...localLayer,localRepaintMaskUrl:'live:mask'}}).type,'canvas',
  'Live authored coverage keeps its canvas composition path');
assert.match(
  source,
  /该旧局部重绘图层缺少涂绘蒙版，无法显示区域预览。/,
  'the enlarged legacy preview must fail closed when authored coverage is unavailable',
);

for (const removedAction of [
  "t('moveLayerUp')",
  "t('moveLayerDown')",
  "t('replaceLayerImage')",
  "t('localRepaintEditLayer')",
]) {
  assert.ok(!menuSource.includes(removedAction), `${removedAction} should not appear in the layer menu`);
}

for (const retainedAction of [
  "t('view')",
  "t('imageEditLayerMenu')",
  "t('duplicate')",
  "t('contentAwareEditableCopy')",
  "t('downloadImage')",
  "t('clearEraserMask')",
  "t('rename')",
  "t('delete')",
]) {
  assert.ok(menuSource.includes(retainedAction), `${retainedAction} should remain in the layer menu`);
}

assert.match(
  eraserPolicySource,
  /function hasClearableProjectedEraserMask[\s\S]*?layer\.type === 'projected'[\s\S]*?!isLocalRepaintEraserLayer\(layer\)[\s\S]*?layer\.maskSpace === 'uv'[\s\S]*?layer\.eraserAlgorithmVersion === ERASER_ALGORITHM_VERSION/,
  'clear mask must target only versioned ordinary projected-layer eraser keep-masks',
);
assert.match(
  source,
  /dispatchEvent\([\s\S]*?'liclick:clear-projected-eraser-mask'[\s\S]*?maskUrl: undefined[\s\S]*?maskSpace: undefined[\s\S]*?eraserAlgorithmVersion: undefined/,
  'the menu action must cancel the live runtime before removing persistent eraser-mask ownership',
);
assert.match(
  viewportSource,
  /const clearProjectedEraserRuntime[\s\S]*?cancelProjectedEraserBatch\(layerId\)[\s\S]*?clearLiveSurfacePaintPreview\(layerId\)[\s\S]*?syncProjectedLayerLiveEraserPreviewInObject\(model\.group, undefined, undefined\)[\s\S]*?disposeUvPaintLayer\(paintLayer\)[\s\S]*?layerRef\.current = undefined[\s\S]*?addEventListener\('liclick:clear-projected-eraser-mask'/,
  'clearing a mask must cancel deferred refinement, detach the shared resident mask, and discard the stable live canvas session',
);

assert.doesNotMatch(
  sceneRootSource,
  /const projectedMaterialStructureKey = \[[\s\S]*?liveProjectedEraserMaskTexture\?\.uuid[\s\S]*?\];/,
  'the transient live eraser texture must not rebuild the complete resident projected material',
);

// Execute the production row and policy: internal capture/brush coverage must
// not masquerade as a removable user eraser mask.
const policyExports = {};
new Function('exports', ts.transpileModule(eraserPolicySource, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText)(policyExports);
const row = tree.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'LayerRow');
assert(row);
const rowDependencies = {
  React: { createElement: (type, props, ...children) => ({ type, props, children }) },
  hasClearableProjectedEraserMask: policyExports.hasClearableProjectedEraserMask,
  cn: (...parts) => parts.filter(Boolean).join(' '), checkerStyle: {},
  ...Object.fromEntries(['Eye', 'EyeOff', 'LayerThumbnail', 'SmallLayerToggle',
    'LayerOpacityGlyph', 'LayerOverlayGlyph', 'LayerBlendGlyph', 'LayerMaskGlyph',
    'MoreVertical'].map(name => [name, name])),
};
const renderRow = new Function(...Object.keys(rowDependencies), ts.transpileModule(row.getText(tree), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React },
}).outputText + '\nreturn LayerRow;')(...Object.values(rowDependencies));
function hasBadge(layer) {
  const visit = node => Boolean(node && typeof node === 'object' &&
    (node.props?.icon?.type === 'LayerMaskGlyph' || node.children?.flat().some(visit)));
  return visit(renderRow({ layer }));
}
const ordinary = { id: 'projected-test', name: '投射贴图 · 当前视角', type: 'projected',
  imageUrl: 'result.png', visible: true, opacity: 1, blendMode: 'normal' };
const erased = { ...ordinary, maskUrl: 'keep-mask.png', maskSpace: 'uv', eraserAlgorithmVersion: 1 };
for (const layer of [ordinary,
  { ...ordinary, maskUrl: 'capture.png', maskSpace: 'projection' },
  { ...ordinary, maskUrl: 'capture.png', maskSpace: 'projection', eraserAlgorithmVersion: 1 },
  { ...ordinary, maskUrl: 'prepared-neutral-mask', maskSpace: 'uv' },
  { ...erased, role: 'local-repaint-overlay', localRepaintMaskUrl: 'brush.png' },
  { ...erased, type: 'uv' }, { ...erased, maskUrl: undefined },
]) assert.equal(hasBadge(layer), false, JSON.stringify(layer));
assert.equal(hasBadge(erased), true);
assert.equal(hasBadge(JSON.parse(JSON.stringify(erased))), true, 'Saved eraser masks keep their badge');

// Extract actual store patches, including the deferred refinement patch, so a
// hard-coded version republished after undo cannot silently restore the badge.
const viewportTree = ts.createSourceFile('ViewportCanvas.tsx', viewportSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const updates = [];
function collect(node) {
  if (ts.isCallExpression(node) && node.expression.getText(viewportTree).endsWith('.updateLayer') &&
      node.arguments[1] && ts.isObjectLiteralExpression(node.arguments[1])) updates.push(node);
  ts.forEachChild(node, collect);
}
collect(viewportTree);
function patchBetween(start, end, bindings) {
  const from = viewportSource.indexOf(start), to = viewportSource.indexOf(end, from);
  assert(from >= 0 && to > from);
  const call = updates.find(node => node.getStart(viewportTree) > from && node.getEnd() < to);
  assert(call, start);
  const js = ts.transpileModule(`const patch = ${call.arguments[1].getText(viewportTree)};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return new Function(...Object.keys(bindings), js + '\nreturn patch;')(...Object.values(bindings));
}
assert.match(viewportSource, /const eraserVersionBefore = latestLayer\.eraserAlgorithmVersion;/);
let state = { ...ordinary, maskUrl: 'capture.png', maskSpace: 'projection' };
const paintLayer = { layerId: state.id, target: 'projected-mask', assetUrl: 'live-keep-mask' };
state = { ...state, ...patchBetween('restoreStroke = applyTiles;',
  'if (projectedEraserCommit ||', { layer: paintLayer, latestLayer: state, ERASER_ALGORITHM_VERSION: 1 }) };
assert.equal(hasBadge(state), true, 'First committed erase creates a user mask badge');
function restore(side, before) {
  state = { ...state, ...patchBetween('const applyTiles = (side:', 'restoreStroke = applyTiles;', {
    layer: paintLayer, latestLayer: state, side, eraserVersionBefore: before, ERASER_ALGORITHM_VERSION: 1,
  }) };
}
function refine() {
  state = { ...state, ...patchBetween('projectedEraserBatchesRef.current.delete(batch.layer.layerId);',
    'publishMs = performance.now()', { batch: { layer: paintLayer }, latestLayer: state, ERASER_ALGORITHM_VERSION: 1 }) };
}
restore('before', 1); refine();
assert.equal(hasBadge(state), true, 'Undoing second stroke retains first erase');
restore('before', undefined); refine();
assert.equal(hasBadge(state), false, 'Undo all + delayed refinement must hide the badge');
assert.equal(hasBadge(JSON.parse(JSON.stringify(state))), false, 'Saving the undone state cannot resurrect the badge');
restore('after', undefined); refine();
assert.equal(hasBadge(state), true, 'Redo restores the badge');
assert.equal(hasBadge({ ...state, maskUrl: undefined, maskSpace: undefined, eraserAlgorithmVersion: undefined }), false,
  'Clear eraser mask removes the badge');

console.log('layer context-menu and eraser mask indicator regression passed');
