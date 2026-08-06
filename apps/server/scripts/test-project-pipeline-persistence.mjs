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

  const userId = 'pipeline-test-user';
  const created = await createProject(userId, { name: 'Pipeline persistence' });
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
    layers: [{ id: 'anchor-layer', objectId: anchorObject.id }],
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
  assert.equal(raw.pipeline.futureMetadata.preserved, true);
  assert.equal(raw.pipeline.revisions[0].futureRevisionField[0], 'keep-me-too');
  assert.equal(raw.pipeline.revisions[0].inputAssets[0].futureAssetField, 'keep-me');
  assert.equal(raw.pipeline.revisions[0].inputAssets[0].url, 'assets/models/a.glb');
  assert.equal(raw.pipeline.revisions[0].outputAssets[0].url, 'assets/generations/a.png');

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

  // Simulate an older/partial client that knows neither the pipeline field nor
  // the model metadata it owns. Existing pipeline state must be retained, and
  // its object reference must prevent data loss.
  const { pipeline: _omittedPipeline, ...legacyClientProject } = loaded.project;
  const secondSave = await saveProject(userId, created.project.id, {
    ...legacyClientProject,
    updatedAt: firstSave.project.updatedAt,
    objects: [anchorObject],
  });
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
  assert.deepEqual(
    deletionSave.project.objects.map((object) => object.id),
    ['anchor-model'],
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
