import assert from 'node:assert/strict';
import {
  isCurrentEditorProjectLoad,
  isEditorProjectServerReady,
  shouldLoadEditorProjectRoute,
} from '../apps/web/src/services/editorProjectRouteLoad.ts';

const routeProjectId = 'project-orchid-speaker';
const collidingMockProject = {
  id: routeProjectId,
  workspaceMode: 'none',
  objects: [{ id: 'object-demo-capsule', format: 'primitive' }],
  layers: [],
};

assert.equal(collidingMockProject.id, routeProjectId);
assert.equal(
  shouldLoadEditorProjectRoute(routeProjectId),
  true,
  'A same-id cached mock must never bypass the authoritative project request.',
);
assert.equal(
  isEditorProjectServerReady(routeProjectId, undefined),
  false,
  'Cached placeholder data must not unlock the editor or autosave.',
);

const currentToken = { projectId: routeProjectId, revision: 4 };
assert.equal(
  isCurrentEditorProjectLoad({
    token: currentToken,
    currentRevision: 4,
    currentRouteProjectId: routeProjectId,
    resultProjectId: routeProjectId,
  }),
  true,
);
assert.equal(
  isCurrentEditorProjectLoad({
    token: { projectId: routeProjectId, revision: 3 },
    currentRevision: 4,
    currentRouteProjectId: routeProjectId,
    resultProjectId: routeProjectId,
  }),
  false,
  'A stale project response must not overwrite the current route.',
);
assert.equal(
  isCurrentEditorProjectLoad({
    token: currentToken,
    currentRevision: 4,
    currentRouteProjectId: 'another-project',
    resultProjectId: routeProjectId,
  }),
  false,
  'A response from the previous route must be ignored.',
);

assert.equal(isEditorProjectServerReady(routeProjectId, routeProjectId), true);
assert.equal(shouldLoadEditorProjectRoute(routeProjectId), true);

process.stdout.write(
  'Editor refresh smoke passed: cached mocks cannot bypass server hydration and stale loads are ignored.\n',
);
