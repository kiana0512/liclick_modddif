import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { stdout } from 'node:process';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const server = await createServer({
  root,
  appType: 'custom',
  logLevel: 'silent',
  server: { middlewareMode: true },
});

try {
  const { getProjectThumbnailCaptureModels, resolvePublishedModelSelection } =
    await server.ssrLoadModule('/src/engine/scene/progressiveModelPolicy.ts');

  assert.equal(
    resolvePublishedModelSelection({
      publishedObjectIds: ['a', 'b', 'c'],
      selectedObjectId: 'c',
      requestedActiveObjectId: 'a',
    }),
    'c',
    'background restore publication must preserve the user-selected object',
  );
  assert.equal(
    resolvePublishedModelSelection({
      publishedObjectIds: ['a', 'b'],
      requestedActiveObjectId: 'b',
    }),
    'b',
    'the persisted active object initializes selection when no live selection exists',
  );
  assert.equal(
    resolvePublishedModelSelection({
      publishedObjectIds: ['a'],
      selectedObjectId: 'removed',
      requestedActiveObjectId: 'removed',
      sceneObjectIds: ['a', 'removed'],
    }),
    'a',
  );

  const bounds = { objectId: 'bounds', restoreStage: 'bounds' };
  const outline = { objectId: 'outline', restoreStage: 'outline' };
  const full = { objectId: 'full', restoreStage: 'full' };
  assert.deepEqual(getProjectThumbnailCaptureModels([bounds, outline, full]), [outline, full]);
  assert.deepEqual(
    getProjectThumbnailCaptureModels([bounds]),
    [bounds],
    'thumbnail capture must use the current placeholder rather than an unrelated old image',
  );

  const editorSource = await readFile(path.join(root, 'src/routes/EditorPage.tsx'), 'utf8');
  const sceneRootSource = await readFile(
    path.join(root, 'src/engine/viewport/SceneRoot.tsx'),
    'utf8',
  );
  const previewTextureCacheSource = await readFile(
    path.join(root, 'src/engine/viewport/previewTextureCache.ts'),
    'utf8',
  );
  const bitmapWorkerSource = await readFile(
    path.join(root, 'src/workers/previewImageBitmap.worker.ts'),
    'utf8',
  );
  const projectStoreSource = await readFile(path.join(root, 'src/stores/projectStore.ts'), 'utf8');
  assert.doesNotMatch(
    editorSource,
    /models\.some\(\(model\) => model\.restoreStage && model\.restoreStage !== 'full'\)[\s\S]{0,120}return undefined/,
    'a progressive background model must not force thumbnail capture to reuse the old project image',
  );
  assert.doesNotMatch(
    editorSource,
    /textureRestoreQueue|queueFullTextureRestore/,
    'background models must remain stable proxies instead of entering a serial full-material queue',
  );
  assert.match(
    editorSource,
    /sceneState\.selectedObjectId !== selectedObjectId[\s\S]{0,220}setImportedModelRestoreStage\(selectedObjectId, 'full'\)/,
    'only the still-selected model may promote from its proxy to full material',
  );
  assert.doesNotMatch(
    editorSource,
    /if \(!result\.model\) \{[\s\S]{0,300}restoredModelByObjectId\.delete/,
    'a failed source load must retain its scene placeholder',
  );
  assert.match(
    sceneRootSource,
    /const textureObjectId = selectedObjectId \?\? activeImportedModelId;[\s\S]{0,180}workspaceMode === 'texture'[\s\S]{0,120}importedModels\.filter\(\(model\) => model\.objectId === textureObjectId\)[\s\S]{0,80}: importedModels/,
    'texture authoring must render the selected model with the current runtime model as a defensive fallback',
  );
  assert.match(
    sceneRootSource,
    /const clearViewportSelection = useCallback\(\(\) => \{[\s\S]{0,320}if \(workspaceMode === 'texture'\) return;[\s\S]{0,80}selectObject\(undefined\);/,
    'an empty texture-viewport click must preserve the active object while scene review may still deselect',
  );
  assert.match(
    sceneRootSource,
    /const showSelectionGlow = workspaceMode === 'scene';/,
    'selection bounds must stay hidden while texture authoring and only render in scene review',
  );
  assert.match(
    sceneRootSource,
    /<group onPointerMissed=\{clearViewportSelection\}>/,
    'the scene pointer-miss boundary must use the workspace-aware selection guard',
  );
  assert.match(
    sceneRootSource,
    /model\.restoreStage === 'proxy'[\s\S]*?!loadedUvTexture[\s\S]*?revealInitialMaterialPresentation\(\);\s*return;/,
    'an empty proxy sampler must never replace the last visible neutral/material frame',
  );
  assert.match(
    editorSource,
    /prewarmPreviewTextures\([\s\S]{0,260}\{ maxSize: 512 \}/,
    'project hydration must prewarm bounded proxy textures before exact 4K assets',
  );
  assert.match(
    editorSource,
    /restoreStage: 'proxy'/,
    'parsed background geometry must enter the cached material-proxy stage',
  );
  assert.match(
    previewTextureCacheSource,
    /getPreviewTextureCacheKey[\s\S]{0,220}li3d-proxy-/,
    'proxy and full textures must have independent resident-cache entries',
  );
  assert.match(
    bitmapWorkerSource,
    /resizeWidth:[\s\S]{0,180}resizeQuality: 'medium'/,
    '512px proxy resizing must happen in the bitmap worker instead of blocking the UI thread',
  );
  assert.match(
    sceneRootSource,
    /importedModel\.group\.userData\.liclickRestoreOutlinePrepared === true \|\|[\s\S]{0,100}initialMaterialPresentationReadyForGroup/,
    'the white proxy must stay visible while the selected full material is being prepared',
  );
  assert.match(
    sceneRootSource,
    /scheduleCurrentProjectActiveObjectPersistence\(objectId\)/,
    'viewport selection must use the shared deferred active-object persistence contract',
  );
  assert.match(
    projectStoreSource,
    /setTimeout\([\s\S]{0,700}updateProjectById\(projectId, \{ activeObjectId \}\)/,
    'rapid model selection must coalesce project persistence while preserving the final active object',
  );

  stdout.write('Multi-model restore policy regression test passed.\n');
} finally {
  await server.close();
}
