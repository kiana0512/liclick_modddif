/* global console, process */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const workspace = path.join(
  os.tmpdir(),
  `li3d-project-pipeline-${process.pid}-${randomUUID()}`,
);

async function main() {
  process.env.LICLICK_WORKSPACE_DIR = workspace;
  process.env.LICLICK_PUBLIC_WORKSPACE_URL = 'http://127.0.0.1:49731';

  const { createProject, loadProject, saveProject } = await import(
    '../dist/services/projectFileService.js'
  );
  const { executeProjectCommand } = await import(
    '../dist/services/projectCommandService.js'
  );

  const userId = 'pipeline-test-user';
  const created = await createProject(userId, { name: 'Pipeline persistence' });
  assert.equal(created.project.revision.number, 1);
  const projectUrlPrefix = `${process.env.LICLICK_PUBLIC_WORKSPACE_URL}/workspace/users/${userId}/projects/${created.slug}`;
  const modelObject = { id: 'pipeline-model', sourcePath: `${projectUrlPrefix}/assets/models/a.glb` };
  const anchorObject = { id: 'anchor-model', sourcePath: `${projectUrlPrefix}/assets/models/b.glb` };
  const pipeline = {
    version: 1,
    futureMetadata: { preserved: true },
    revisions: [
      {
        id: 'texture-r1',
        stage: 'texture',
        inputAssets: [
          {
            id: 'input-a',
            kind: 'model',
            objectId: modelObject.id,
            url: `${projectUrlPrefix}/assets/models/a.glb`,
            futureAssetField: 'keep-me',
          },
        ],
        outputAssets: [
          {
            id: 'output-a',
            kind: 'base-color',
            objectId: modelObject.id,
            url: `${projectUrlPrefix}/assets/generations/a.png`,
          },
        ],
        futureRevisionField: ['keep-me-too'],
      },
    ],
  };

  const firstSave = await saveProject(userId, created.project.id, {
    ...created.project,
    objects: [modelObject, anchorObject],
    layers: [
      { id: 'anchor-layer', objectId: anchorObject.id },
      {
        id: 'local-repaint-projection-test',
        type: 'projected',
        objectId: modelObject.id,
        imageUrl: `${projectUrlPrefix}/assets/generations/repaint.png`,
        maskUrl: `${projectUrlPrefix}/assets/layers/repaint-mask.png`,
        localRepaintSourceUrl: `${projectUrlPrefix}/assets/generations/repaint.png`,
        localRepaintMaskUrl: `${projectUrlPrefix}/assets/layers/repaint-mask.png`,
      },
    ],
    pipeline,
  });

  const rawProjectPath = path.join(
    workspace,
    'users',
    userId,
    'projects',
    created.slug,
    'project.liclick.json',
  );
  const raw = JSON.parse(await fs.readFile(rawProjectPath, 'utf8'));
  assert.equal(firstSave.project.revision.number, 2);
  assert.equal(firstSave.project.revision.parentRevisionId, created.project.revision.id);
  assert.equal(raw.revision.id, firstSave.project.revision.id);
  assert.equal(raw.pipeline.futureMetadata.preserved, true);
  assert.equal(raw.pipeline.revisions[0].futureRevisionField[0], 'keep-me-too');
  assert.equal(raw.pipeline.revisions[0].inputAssets[0].futureAssetField, 'keep-me');
  assert.equal(raw.pipeline.revisions[0].inputAssets[0].url, 'assets/models/a.glb');
  assert.equal(raw.pipeline.revisions[0].outputAssets[0].url, 'assets/generations/a.png');
  const rawLocalRepaint = raw.layers.find(
    (layer) => layer.id === 'local-repaint-projection-test',
  );
  assert.equal(rawLocalRepaint.localRepaintSourceUrl, 'assets/generations/repaint.png');
  assert.equal(rawLocalRepaint.localRepaintMaskUrl, 'assets/layers/repaint-mask.png');

  assert.equal(
    firstSave.project.pipeline.revisions[0].inputAssets[0].url,
    `${projectUrlPrefix}/assets/models/a.glb`,
  );
  const loaded = await loadProject(userId, created.project.id);
  assert.ok(loaded);
  assert.equal(
    loaded.project.pipeline.revisions[0].outputAssets[0].url,
    `${projectUrlPrefix}/assets/generations/a.png`,
  );

  await assert.rejects(
    () =>
      saveProject(userId, created.project.id, {
        ...created.project,
        name: 'stale overwrite attempt',
        objects: [modelObject, anchorObject],
      }),
    (error) => error?.code === 'PROJECT_REVISION_CONFLICT',
  );

  const revisionlessProject = { ...loaded.project };
  delete revisionlessProject.revision;
  process.env.LICLICK_RUNTIME_MODE = 'cloud';
  try {
    await assert.rejects(
      () => saveProject(userId, created.project.id, revisionlessProject),
      (error) => error?.code === 'PROJECT_REVISION_CONFLICT',
    );
  } finally {
    delete process.env.LICLICK_RUNTIME_MODE;
  }
  const loadedLocalRepaint = loaded.project.layers.find(
    (layer) => layer.id === 'local-repaint-projection-test',
  );
  assert.equal(
    loadedLocalRepaint.localRepaintSourceUrl,
    `${projectUrlPrefix}/assets/generations/repaint.png`,
  );
  assert.equal(
    loadedLocalRepaint.localRepaintMaskUrl,
    `${projectUrlPrefix}/assets/layers/repaint-mask.png`,
  );

  // A late GPU/runtime snapshot must never replace already durable masks.
  // This models the autosave race where the renderer promotes a layer to its
  // live canvas URL after a previous save has uploaded the exact same pixels.
  const runtimeMaskUrl =
    'liclick-live-projected-canvas://local-repaint-projection-test:inward-crossfade';
  const runtimeAuthoredMaskUrl =
    'liclick-live-projected-canvas://local-repaint-projection-test';
  const volatileSave = await saveProject(userId, created.project.id, {
    ...loaded.project,
    layers: loaded.project.layers.map((layer) =>
      layer.id === 'local-repaint-projection-test'
        ? {
            ...layer,
            maskUrl: runtimeMaskUrl,
            localRepaintMaskUrl: runtimeAuthoredMaskUrl,
          }
        : layer,
    ),
  });
  const protectedLocalRepaint = volatileSave.project.layers.find(
    (layer) => layer.id === 'local-repaint-projection-test',
  );
  assert.equal(protectedLocalRepaint.maskUrl, `${projectUrlPrefix}/assets/layers/repaint-mask.png`);
  assert.equal(
    protectedLocalRepaint.localRepaintMaskUrl,
    `${projectUrlPrefix}/assets/layers/repaint-mask.png`,
  );

  await assert.rejects(
    () =>
      saveProject(userId, created.project.id, {
        ...volatileSave.project,
        layers: [
          ...volatileSave.project.layers,
          {
            id: 'local-repaint-projection-without-durable-mask',
            type: 'projected',
            objectId: modelObject.id,
            imageUrl: `${projectUrlPrefix}/assets/generations/repaint-new.png`,
            maskUrl: 'liclick-live-projected-canvas://missing-mask',
            localRepaintMaskUrl: 'liclick-live-projected-canvas://missing-authored-mask',
          },
        ],
      }),
    (error) => error?.code === 'PROJECT_SAVE_CONFLICT',
  );

  // Simulate an older/partial client that knows neither the pipeline field nor
  // the model metadata it owns. Existing pipeline state must be retained, and
  // its object reference must prevent data loss.
  const legacyClientProject = { ...loaded.project };
  delete legacyClientProject.pipeline;
  const secondSave = await saveProject(userId, created.project.id, {
    ...legacyClientProject,
    revision: volatileSave.project.revision,
    updatedAt: volatileSave.project.updatedAt,
    objects: [anchorObject],
  });
  assert.equal(secondSave.project.revision.number, 4);
  assert.equal(secondSave.project.revision.parentRevisionId, volatileSave.project.revision.id);
  assert.equal(secondSave.project.pipeline.revisions[0].id, 'texture-r1');
  assert.deepEqual(
    secondSave.project.objects.map((object) => object.id).sort(),
    ['anchor-model', 'pipeline-model'],
  );

  // An explicit deletion remains authoritative even when immutable pipeline
  // history still refers to that object's assets.
  const deletionSave = await saveProject(userId, created.project.id, {
    ...secondSave.project,
    objects: [anchorObject],
    deletedObjectIds: [modelObject.id],
  });
  assert.equal(deletionSave.project.revision.number, 5);
  assert.deepEqual(
    deletionSave.project.objects.map((object) => object.id),
    ['anchor-model'],
  );

  const renameCommand = {
    schemaVersion: 1,
    id: 'command-idempotent-0001',
    projectId: created.project.id,
    expectedRevisionId: deletionSave.project.revision.id,
    issuedAt: '2026-08-21T00:00:00.000Z',
    kind: 'rename-project',
    payload: { name: 'Command-renamed project' },
  };
  const commandResult = await executeProjectCommand(userId, renameCommand);
  assert.ok(commandResult);
  assert.equal(commandResult.command.replayed, false);
  assert.equal(commandResult.project.name, 'Command-renamed project');
  assert.equal(commandResult.project.revision.number, 6);

  const commandReceiptPath = path.join(
    workspace,
    'users',
    userId,
    'projects',
    created.slug,
    '.commands',
    `${renameCommand.id}.json`,
  );
  const receipt = JSON.parse(await fs.readFile(commandReceiptPath, 'utf8'));
  assert.equal(receipt.commandId, renameCommand.id);
  assert.equal(receipt.revision.id, commandResult.project.revision.id);

  // Simulate a crash after the project write but before receipt persistence.
  // The bounded project journal must restore the receipt without a second save.
  await fs.rm(commandReceiptPath);
  const replayedCommand = await executeProjectCommand(userId, renameCommand);
  assert.ok(replayedCommand);
  assert.equal(replayedCommand.command.replayed, true);
  assert.equal(replayedCommand.project.revision.id, commandResult.project.revision.id);
  assert.equal(replayedCommand.project.revision.number, 6);
  await fs.access(commandReceiptPath);

  await assert.rejects(
    () =>
      executeProjectCommand(userId, {
        ...renameCommand,
        payload: { name: 'Malicious id reuse' },
      }),
    (error) => error?.code === 'PROJECT_COMMAND_ID_REUSE_CONFLICT',
  );

  await assert.rejects(
    () =>
      executeProjectCommand(userId, {
        schemaVersion: 1,
        id: 'command-stale-move-0001',
        projectId: created.project.id,
        expectedRevisionId: deletionSave.project.revision.id,
        issuedAt: '2026-08-21T00:01:00.000Z',
        kind: 'move-project',
        payload: { folderId: null },
      }),
    (error) => error?.code === 'PROJECT_REVISION_CONFLICT',
  );

  const legacy = await createProject(userId, { name: 'Legacy project' });
  assert.equal(Object.hasOwn(legacy.project, 'pipeline'), false);

  console.log('project pipeline persistence tests passed');
}

try {
  await main();
} finally {
  await fs.rm(workspace, { recursive: true, force: true });
}
