/* global console */

import assert from 'node:assert/strict';
import path from 'node:path';
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
  const { getProjectPipelineTaskHistory } = await server.ssrLoadModule(
    '/src/services/taskHistoryApiClient.ts',
  );
  const timestamp = '2026-08-21T04:00:00.000Z';
  const project = {
    id: 'account-project-a',
    pipeline: {
      version: 1,
      revisions: [
        {
          id: 'local-uv-revision',
          stage: 'uv',
          sourceMode: 'browser-local',
          inputAssets: [{ id: 'source', kind: 'high-model', name: 'robot.obj', url: '/source.obj' }],
          outputAssets: [{
            id: 'uv-output',
            kind: 'uv-model',
            name: 'robot_local_uv.glb',
            url: '/api/assets/account-a/robot_local_uv.glb',
            sizeBytes: 4096,
          }],
          settings: {
            jobId: 'local-uv-hash',
            resolution: 2048,
            padding: 10,
            meshCount: 2,
            triangleCount: 128,
            chartCount: 7,
            utilization: 0.625,
          },
          status: 'ready',
          createdAt: timestamp,
          updatedAt: timestamp,
          completedAt: timestamp,
        },
        {
          id: 'remote-uv-revision',
          stage: 'uv',
          sourceMode: 'processing-job',
          inputAssets: [],
          outputAssets: [],
          settings: {},
          status: 'ready',
          createdAt: timestamp,
          updatedAt: timestamp,
          completedAt: timestamp,
        },
      ],
    },
  };

  const records = getProjectPipelineTaskHistory(project, 'uv');
  assert.equal(records.length, 1, 'only browser-local account project revisions are supplemental');
  assert.equal(records[0].id, 'pipeline:local-uv-revision');
  assert.equal(records[0].sourceName, 'robot.obj');
  assert.equal(records[0].status, 'succeeded');
  assert.equal(records[0].progress, 100);
  assert.deepEqual(records[0].outputs[0], {
    id: 'uv-output',
    label: 'UV 模型',
    filename: 'robot_local_uv.glb',
    sizeBytes: 4096,
    downloadUrl: '/api/assets/account-a/robot_local_uv.glb',
  });
  assert.ok(records[0].parameters.some((item) => item.label === '输出尺寸' && item.value === '2048'));
  assert.ok(records[0].parameters.some((item) => item.label === '利用率' && item.value === '62.5%'));
  assert.deepEqual(getProjectPipelineTaskHistory(undefined, 'uv'), []);
  assert.deepEqual(getProjectPipelineTaskHistory({ id: 'account-project-b' }, 'uv'), []);

  console.log('Account-scoped browser-local UV history mapping passed.');
} finally {
  await server.close();
}
