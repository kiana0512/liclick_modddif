import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const workspace = path.join(os.tmpdir(), `li3d-telemetry-fields-${process.pid}-${randomUUID()}`);

function telemetryEvent(device, module, action, index) {
  return {
    event_id: `evt_${randomUUID()}`,
    event_type: 'module_action',
    ts: new Date(Date.parse('2026-08-03T16:30:00.000Z') + index * 1_000).toISOString(),
    ...device,
    session_id: `sess_${randomUUID()}`,
    version: '0.1.9',
    host_version: 'Chrome 140',
    data: { module, action },
  };
}

async function main() {
  process.env.LICLICK_WORKSPACE_DIR = workspace;
  process.env.SERVER_HOST = '127.0.0.1';
  process.env.SESSION_SECRET = 'telemetry-field-test-only';

  const identity = await import('../dist/services/identityTelemetryService.js');
  const platform = await import('../dist/services/feishuPlatformService.js');
  const device = {
    machine_id: `machine_${randomUUID()}`,
    install_id: `install_${randomUUID()}`,
  };
  const detailedProfile = {
    authUserId: 'feishu-test-user',
    userKey: 'feishu:test-union',
    userName: '统计测试用户',
    email: 'telemetry@example.invalid',
    department: '研发中心 / 美术工具',
    openId: 'ou_telemetry_test',
    unionId: 'on_telemetry_test',
    userId: 'user_telemetry_test',
    tenantKey: 'tenant_telemetry_test',
  };

  await identity.identityTelemetryStorage.initialize();
  await identity.identityTelemetryStorage.bind(device, detailedProfile);
  await identity.identityTelemetryStorage.bind(device, {
    authUserId: detailedProfile.authUserId,
    userKey: detailedProfile.userKey,
    userName: detailedProfile.userName,
  });
  const status = await identity.identityTelemetryStorage.status(device);
  assert.equal(status.email, detailedProfile.email, 'A sparse profile refresh must preserve the stored email.');
  assert.equal(status.department, detailedProfile.department, 'A sparse profile refresh must preserve the stored department.');

  const storedBindings = JSON.parse(
    await fs.readFile(path.join(workspace, 'identity', 'device-bindings.json'), 'utf8'),
  );
  const storedPair = Object.values(storedBindings.by_pair)[0];
  assert.equal(storedPair.feishu_open_id, detailedProfile.openId);
  assert.equal(storedPair.feishu_union_id, detailedProfile.unionId);
  assert.equal(storedPair.feishu_user_id, detailedProfile.userId);
  assert.equal(storedPair.tenant_key, detailedProfile.tenantKey);

  const actionCounts = [
    ['texture_painting', 'open', 2],
    ['texture_painting', 'start', 3],
    ['model_baking', 'start', 4],
    ['toolbox', 'open', 5],
    ['auto_retopology', 'start', 6],
    ['auto_uv', 'start', 7],
    ['local_repaint', 'start', 8],
    ['local_component', 'download', 9],
    ['model_baking', 'download', 2],
  ];
  let index = 0;
  const events = actionCounts.flatMap(([module, action, count]) =>
    Array.from({ length: count }, () =>
      identity.parseTelemetryEvent(telemetryEvent(device, module, action, index++)),
    ),
  );
  await identity.identityTelemetryStorage.ingest(events, {
    authUserId: detailedProfile.authUserId,
    userKey: detailedProfile.userKey,
    userName: detailedProfile.userName,
  });

  const [aggregate] = await identity.identityTelemetryStorage.listPendingAggregates();
  assert.ok(aggregate, 'The ingested events must produce a pending aggregate.');
  assert.equal(aggregate.date_key, '2026-08-04', 'The daily key must use Asia/Shanghai rather than UTC.');
  assert.equal(JSON.parse(aggregate.aggregate_key)[0], '2026-08-04');
  assert.equal(aggregate.email, detailedProfile.email, 'Sparse session identity must preserve the stored email.');
  assert.equal(aggregate.department, detailedProfile.department, 'Sparse session identity must preserve the stored department.');

  const prepared = platform.prepareTelemetryAggregateForBitable(aggregate);
  const fields = prepared.fields;
  assert.equal(fields['日期键'], '2026-08-04');
  assert.equal(fields['日期时间'], Date.parse(aggregate.last_event_at));
  assert.equal(fields['电脑名'], '');
  assert.equal(fields['下载次数'], 11);
  assert.equal(fields['贴图绘制次数'], 2);
  assert.equal(fields['生图次数'], 3);
  assert.equal(fields['模型烘焙次数'], 4);
  assert.equal(fields['工具箱次数'], 5);
  assert.equal(fields['自动拓扑次数'], 6);
  assert.equal(fields['自动展UV次数'], 7);
  assert.equal(fields['局部重绘次数'], 8);
  assert.equal(fields['本地组件下载次数'], 9);
  assert.equal(fields['用户唯一ID'], detailedProfile.userKey);
  assert.equal(fields['事件总数'], events.length);
  assert.deepEqual(JSON.parse(fields['动作计数JSON']), aggregate.counts);
  assert.match(fields['同步哈希'], /^[a-f0-9]{64}$/);

  assert.deepEqual(new Set(Object.keys(fields)), new Set([
    '聚合键',
    '日期时间',
    '日期键',
    '工具版本',
    '宿主版本',
    '用户姓名',
    '飞书邮箱',
    '所属部门',
    '电脑名',
    '下载次数',
    '贴图绘制次数',
    '生图次数',
    '模型烘焙次数',
    '工具箱次数',
    '自动拓扑次数',
    '自动展UV次数',
    '局部重绘次数',
    '本地组件下载次数',
    '用户唯一ID',
    '事件总数',
    '动作计数JSON',
    '同步哈希',
  ]));
}

try {
  await fs.mkdir(workspace, { recursive: true });
  await main();
  console.log('Telemetry aggregation field mapping test passed.');
} finally {
  await fs.rm(workspace, { recursive: true, force: true });
}
