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
  const { migrateWorkspaceLayoutState } = await server.ssrLoadModule(
    '/src/components/workspace/workspaceLayoutStore.ts',
  );
  const migrated = migrateWorkspaceLayoutState({
    mode: 'segments',
    dockDensity: 'compact',
    panels: [
      {
        id: 'segments',
        title: 'Segments',
        dock: 'left',
        order: 10,
        collapsed: false,
        visible: true,
        mode: 'segments',
      },
      {
        id: 'quickMask',
        title: 'Quick Mask',
        dock: 'left',
        order: 20,
        collapsed: true,
        visible: false,
        mode: 'segments',
      },
      {
        id: 'layers',
        title: 'Layers',
        dock: 'right',
        order: 30,
        collapsed: false,
        visible: true,
        mode: 'texture',
      },
    ],
  });

  assert.equal(migrated.mode, 'texture');
  assert.equal(migrated.dockDensity, 'compact');
  assert.equal(migrated.panels.some((panel) => panel.id === 'segments'), false);
  assert.equal(migrated.panels.some((panel) => panel.id === 'quickMask'), false);
  assert.equal(migrated.panels.filter((panel) => panel.id === 'layers').length, 1);
  assert.equal(
    migrated.panels.length,
    new Set(migrated.panels.map((panel) => panel.id)).size,
    'the migrated layout must contain each supported panel once',
  );

  const defaults = migrateWorkspaceLayoutState(undefined);
  assert.equal(defaults.mode, 'scene');
  assert.equal(defaults.panels.some((panel) => panel.id === 'segments'), false);
  assert.equal(defaults.panels.some((panel) => panel.id === 'quickMask'), false);

} finally {
  await server.close();
}
