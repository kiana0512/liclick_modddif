import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CURRENT_PROTOCOL_VERSIONS,
  createReleaseManifest,
  evaluateReleaseCompatibility,
  parseReleaseManifest,
  isProjectRevision,
  nextProjectRevision,
  projectRevisionMatches,
  parseProjectCommand,
  parseCreateAssetUploadIntent,
  parseCompleteAssetUploadIntent,
  selectLocalComputePlan,
} from '../dist/index.js';

function manifest(overrides = {}) {
  return createReleaseManifest({
    releaseId: '2026.08.21-ea86557',
    gitSha: 'ea86557ca8f15b600d3a8fc3274ea0727cc5c887',
    version: '0.1.13',
    builtAt: '2026-08-21T00:00:00.000Z',
    runtimeMode: 'cloud',
    component: 'web',
    protocols: CURRENT_PROTOCOL_VERSIONS,
    capabilities: ['browser-local-compute', 'browser-local-compute'],
    ...overrides,
  });
}

test('normalizes and parses a release manifest', () => {
  const value = manifest();
  assert.deepEqual(value.capabilities, ['browser-local-compute']);
  assert.deepEqual(parseReleaseManifest(JSON.parse(JSON.stringify(value))), value);
});

test('allows a mixed release only when protocols stay compatible', () => {
  const web = manifest();
  const server = manifest({ releaseId: '2026.08.22-next', component: 'server' });
  const result = evaluateReleaseCompatibility(web, server);
  assert.equal(result.compatible, true);
  assert.equal(result.sameRelease, false);
  assert.equal(result.issues[0]?.code, 'MIXED_RELEASE');
});

test('blocks incompatible protocol versions', () => {
  const web = manifest();
  const server = manifest({
    component: 'server',
    protocols: { ...CURRENT_PROTOCOL_VERSIONS, project: '1.0' },
  });
  const result = evaluateReleaseCompatibility(web, server);
  assert.equal(result.compatible, false);
  assert.equal(result.issues.some((issue) => issue.code === 'PROJECT_PROTOCOL_MISMATCH'), true);
});

test('rejects malformed release data', () => {
  assert.throws(() => manifest({ gitSha: 'not a sha' }), /gitSha/);
  assert.throws(() => manifest({ runtimeMode: 'desktop-legacy' }), /runtimeMode/);
  assert.throws(() => manifest({ component: 'local-agent' }), /component/);
  assert.throws(() => parseReleaseManifest({ schemaVersion: 999 }), /Unsupported/);
});

test('selects WebGPU and OPFS for a capable browser without server fallback', () => {
  const plan = selectLocalComputePlan({
    webGpu: true,
    webGl2: true,
    workers: true,
    offscreenCanvas: true,
    wasm: true,
    sharedMemory: true,
    opfs: true,
    indexedDb: true,
    logicalProcessors: 16,
    deviceMemoryGb: 16,
  });
  assert.equal(plan.textureBackend, 'webgpu-worker');
  assert.equal(plan.cpuBackend, 'wasm-worker');
  assert.equal(plan.persistenceBackend, 'opfs');
  assert.equal(plan.qualityTier, 'high');
  assert.equal(plan.serverFallbackAllowed, false);
  assert.equal(plan.maxHeavyTaskConcurrency, 4);
});

test('degrades locally when GPU and workers are unavailable', () => {
  const plan = selectLocalComputePlan({
    webGpu: false,
    webGl2: false,
    workers: false,
    offscreenCanvas: false,
    wasm: true,
    sharedMemory: false,
    opfs: false,
    indexedDb: true,
    logicalProcessors: 2,
    deviceMemoryGb: 2,
  });
  assert.equal(plan.textureBackend, 'cpu-main-limited');
  assert.equal(plan.cpuBackend, 'js-main-limited');
  assert.equal(plan.persistenceBackend, 'indexeddb');
  assert.equal(plan.qualityTier, 'limited');
  assert.equal(plan.serverFallbackAllowed, false);
  assert.ok(plan.limitations.length >= 3);
});

test('creates a monotonic opaque project revision chain', () => {
  const first = nextProjectRevision(undefined, {
    id: 'revision-00000001',
    savedAt: '2026-08-21T00:00:00.000Z',
  });
  const second = nextProjectRevision(first, {
    id: 'revision-00000002',
    savedAt: '2026-08-21T00:01:00.000Z',
  });
  assert.equal(first.number, 1);
  assert.equal(second.number, 2);
  assert.equal(second.parentRevisionId, first.id);
  assert.equal(isProjectRevision(second), true);
  assert.equal(projectRevisionMatches(first.id, first), true);
  assert.equal(projectRevisionMatches(first.id, second), false);
});

test('parses versioned project commands and rejects malformed payloads', () => {
  const command = parseProjectCommand({
    schemaVersion: 1,
    id: 'command-00000001',
    projectId: 'project-00000001',
    expectedRevisionId: 'revision-00000001',
    issuedAt: '2026-08-21T00:00:00.000Z',
    kind: 'rename-project',
    payload: { name: '  New name  ' },
  });
  assert.equal(command.kind, 'rename-project');
  assert.equal(command.payload.name, 'New name');
  assert.throws(
    () => parseProjectCommand({ ...command, kind: 'delete-everything' }),
    /Unsupported project command kind/,
  );
  assert.throws(
    () => parseProjectCommand({ ...command, id: '../escape' }),
    /command id/,
  );
});

test('validates direct asset transfer metadata', () => {
  const intent = parseCreateAssetUploadIntent({
    protocolVersion: 1,
    category: 'layers',
    filename: 'paint.png',
    mimeType: 'image/png',
    sizeBytes: 1024,
    sha256: 'a'.repeat(64),
  });
  assert.equal(intent.category, 'layers');
  assert.equal(intent.mimeType, 'image/png');
  assert.throws(
    () => parseCreateAssetUploadIntent({ ...intent, filename: '../escape.png' }),
    /filename/,
  );
  assert.throws(
    () => parseCreateAssetUploadIntent({ ...intent, sizeBytes: 0 }),
    /sizeBytes/,
  );
  assert.deepEqual(
    parseCompleteAssetUploadIntent({
      protocolVersion: 1,
      assetId: 'asset-00000001',
      sha256: 'b'.repeat(64),
    }),
    {
      protocolVersion: 1,
      assetId: 'asset-00000001',
      sha256: 'b'.repeat(64),
    },
  );
});
