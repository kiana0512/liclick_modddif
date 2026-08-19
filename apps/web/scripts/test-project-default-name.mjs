import assert from 'node:assert/strict';
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
  const { getNextDefaultProjectName } = await server.ssrLoadModule(
    '/src/features/projects/projectDefaultName.ts',
  );
  assert.equal(getNextDefaultProjectName([], '新项目'), '新项目1');
  assert.equal(getNextDefaultProjectName(['新项目1'], '新项目'), '新项目2');
  assert.equal(
    getNextDefaultProjectName(['新项目1', '自定义名称', '新项目3'], '新项目'),
    '新项目2',
  );
  assert.equal(
    getNextDefaultProjectName(['new project 1'], 'New Project '),
    'New Project 2',
  );
  stdout.write('Project default name regression test passed.\n');
} finally {
  await server.close();
}
