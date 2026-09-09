import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = (...segments) => fs.readFile(path.join(root, 'src', ...segments), 'utf8');
const [appSource, mainSource, adminPageSource, bridgeSource, collectorSource, workerSource, apiSource] = await Promise.all([
  source('App.tsx'),
  source('main.tsx'),
  source('routes', 'PerformanceLabAdminPage.tsx'),
  source('features', 'performanceLab', 'PerformanceLabCloudBridge.tsx'),
  source('features', 'performanceLab', 'performanceLabCollector.ts'),
  source('features', 'performanceLab', 'performanceLabUpload.worker.ts'),
  source('features', 'performanceLab', 'performanceLabApiClient.ts'),
]);

assert.match(
  appSource,
  /lazy\(\(\) =>[\s\S]*PerformanceLabCloudBridge[\s\S]*performanceLabEnabled \? \(/,
  'The Cloud recorder must be conditionally bundled behind perfLab=1.',
);
assert.match(
  mainSource,
  /isPerformanceLabEnabled[\s\S]*<Profiler id="app-root"[\s\S]*recordReactProfilerCommit/,
  'React commit profiling must be mounted only for the explicit performance-lab route.',
);
assert.match(
  appSource,
  /VITE_LICLICK_PERFORMANCE_LAB_ENABLED === 'true'[\s\S]*get\('perfLab'\) === '1'/,
  'Local builds must not collect records unless the production deployment explicitly enables Performance Lab.',
);
assert.match(
  bridgeSource,
  /attributeFilter: \['data-perf-manual-local-repaint-recording'\]/,
  'The existing manual start/end control must drive a complete Cloud recording cycle.',
);
assert.match(bridgeSource, /if \(recording\) beginRecording\(\);[\s\S]*else endRecording\(\);/);
assert.match(
  bridgeSource,
  /createPerformanceLabSessionId\(\)[\s\S]*new PerformanceLabCollector/,
  'Every click cycle must create a new independent session id and collector.',
);
assert.match(
  bridgeSource,
  /manualHudReport[\s\S]*serverGpuMetricsIncluded: false/,
  'Reports must explicitly describe client GPU data and exclude A100 GPU metrics.',
);
assert.match(
  bridgeSource,
  /groupedSessions[\s\S]*group\.user\.avatarUrl[\s\S]*group\.user\.displayName/,
  'The maintenance view must group sessions by trusted Feishu avatar and display name.',
);
for (const entryType of ['longtask', 'long-animation-frame', 'event', 'layout-shift', 'resource']) {
  assert.ok(
    new RegExp(`this\\.observe\\(\\s*["']${entryType}["']`).test(collectorSource),
    `The client collector must include ${entryType} observations.`,
  );
}
assert.match(
  collectorSource,
  /WEBGL_debug_renderer_info[\s\S]*detectAngleBackend[\s\S]*timerQuerySupported/,
  'The report must contain real client ANGLE/D3D and WebGL GPU-timer capabilities.',
);
assert.match(
  collectorSource,
  /subscribePerformanceTimeline[\s\S]*timelineEvents[\s\S]*reactCommitP95Ms/,
  'Performance chunks must correlate business spans with React commit timings.',
);
assert.match(
  collectorSource,
  /isJavaScriptPerformanceResource[\s\S]*scriptTransferBytes[\s\S]*scriptDurationP95Ms/,
  'Session summaries must quantify the JavaScript actually loaded by the recorded workflow.',
);
assert.match(
  collectorSource,
  /allowedTimelineStringDetailKeys[\s\S]*prompt\|text\|url[\s\S]*MAX_TIMELINE_EVENTS_PER_CHUNK/,
  'Timeline detail must be privacy-filtered and bounded before upload.',
);
assert.match(
  collectorSource,
  /unsupportedWithoutNativeComponent[\s\S]*ETW\/DXGI\/D3DKMT/,
  'Unavailable native scheduler counters must be marked unsupported rather than fabricated.',
);
assert.match(
  collectorSource,
  /collectorOverheadP95Ms[\s\S]*collectorOverheadMaximumMs/,
  'The collector must report its own overhead.',
);
assert.match(
  workerSource,
  /sha256Hex[\s\S]*indexedDB\.open[\s\S]*credentials: 'include'/,
  'HTTP-safe integrity hashing, durable retry, and upload must run in the Worker.',
);
assert.doesNotMatch(
  workerSource,
  /crypto\.subtle\.digest/,
  'The A100 HTTP deployment must not require secure-context-only WebCrypto hashing.',
);
assert.match(
  collectorSource,
  /typeof crypto\.randomUUID === 'function'[\s\S]*crypto\.getRandomValues[\s\S]*0x40[\s\S]*0x80/,
  'Session ids must retain an RFC 4122 v4 fallback when HTTP disables crypto.randomUUID.',
);
assert.match(workerSource, /maximumRetryDelayMs = 60_000/);
assert.match(apiSource, /\/api\/performance-lab\/sessions/);
assert.match(
  appSource,
  /performance-lab-admin[\s\S]*PerformanceLabAdminPage/,
  'The authenticated app router must expose the dedicated Performance Lab administrator HTML.',
);
assert.match(adminPageSource, /PerformanceRecordsDialog adminOnly/);
assert.match(apiSource, /\/api\/performance-lab\/admin\/sessions/);
assert.match(
  bridgeSource,
  /adminOnly[\s\S]*listPerformanceLabAdminSessions[\s\S]*getPerformanceLabAdminSession/,
  'The dedicated administrator page must use server-enforced administrator endpoints.',
);

const vite = await createServer({
  root,
  appType: 'custom',
  logLevel: 'silent',
  server: { middlewareMode: true, watch: { ignored: () => true } },
});
try {
  const timeline = await vite.ssrLoadModule('/src/engine/performance/performanceTimeline.ts');
  timeline.setPerformanceTimelineEnabled(true);
  const observed = [];
  const unsubscribe = timeline.subscribePerformanceTimeline(event => observed.push({ ...event }));
  const finish = timeline.startPerformanceSpan('projection', 'test-projection');
  finish();
  unsubscribe();
  timeline.setPerformanceTimelineEnabled(false);
  assert.equal(observed[1].phase, 'end');
  assert.ok(Number.isFinite(observed[1].durationMs), 'Duration must be filled before notifying the Cloud collector.');
  const collector = await vite.ssrLoadModule(
    '/src/features/performanceLab/performanceLabCollector.ts',
  );
  assert.equal(collector.PERFORMANCE_LAB_REPORT_SCHEMA_VERSION, 2);
  assert.equal(collector.PERFORMANCE_LAB_COLLECTOR_VERSION, '2.2.1');
  assert.equal(
    collector.isJavaScriptPerformanceResource({
      initiatorType: 'worker',
      name: 'https://example.test/assets/texture.worker.js?v=1',
    }),
    true,
  );
  assert.equal(
    collector.isJavaScriptPerformanceResource({
      initiatorType: 'img',
      name: 'https://example.test/preview.png',
    }),
    false,
  );
  assert.deepEqual(
    collector.sanitizePerformanceTimelineDetail({
      profilerId: 'app-root',
      reactPhase: 'update',
      actualDurationMs: 12.5,
      layerCount: 8,
      textures: 12,
      projectors: 4,
      projectId: 'project-secret',
      taskId: 42,
      prompt: 'secret prompt',
      url: 'https://secret.example/path',
      nested: { secret: true },
    }),
    { profilerId: 'app-root', reactPhase: 'update', actualDurationMs: 12.5, layerCount: 8, textures: 12, projectors: 4 },
  );
  assert.equal(collector.detectAngleBackend('ANGLE (NVIDIA, Direct3D11 vs_5_0 ps_5_0)'), 'd3d11');
  assert.equal(collector.detectAngleBackend('ANGLE (NVIDIA, Direct3D12)'), 'd3d12');
  assert.equal(collector.detectAngleBackend('ANGLE Vulkan 1.3'), 'vulkan');
  assert.equal(collector.detectAngleBackend(''), 'unavailable');
  const originalCrypto = globalThis.crypto;
  Object.defineProperty(globalThis, 'crypto', {
    configurable: true,
    value: {
      getRandomValues(bytes) {
        bytes.fill(0x2a);
        return bytes;
      },
    },
  });
  try {
    assert.match(
      collector.createPerformanceLabSessionId(),
      /^perf_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  } finally {
    Object.defineProperty(globalThis, 'crypto', {
      configurable: true,
      value: originalCrypto,
    });
  }
  const sha256 = await vite.ssrLoadModule('/src/utils/sha256.ts');
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: {} });
  try {
    assert.equal(
      await sha256.sha256Hex(new TextEncoder().encode('abc')),
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  } finally {
    Object.defineProperty(globalThis, 'crypto', {
      configurable: true,
      value: originalCrypto,
    });
  }
} finally {
  await vite.close();
}

process.stdout.write(
  'Performance Lab Cloud recording passed: real client metrics, repeatable sessions, Worker upload, Feishu grouping, strict administrator HTML/API access, and no A100 GPU sampling.\n',
);
