import process from 'node:process';
import console from 'node:console';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

if (!process.env.TELEMETRY_TEST_CHILD) {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'li3d-source-'));
  try {
    const results = [];
    for (const source of ['A100', '正式站']) {
      const child = spawnSync(process.execPath, [import.meta.filename], {
        env: { ...process.env, TELEMETRY_TEST_CHILD: '1',
          LICLICK_WORKSPACE_DIR: path.join(workspace, source),
          LICLICK_TELEMETRY_SOURCE: source,
          FEISHU_BITABLE_SYNC_ENABLED: 'false', SERVER_HOST: '127.0.0.1',
          SESSION_SECRET: 'dual-source-test-only' },
        encoding: 'utf8', windowsHide: true,
      });
      assert.equal(child.status, 0, child.stderr || child.stdout);
      results.push(JSON.parse(child.stdout));
    }
    assert.notEqual(results[0].aggregate_key, results[1].aggregate_key,
      'Same user/date/version on two deployments must never update the same row.');
    console.log('Dual-source telemetry: isolated keys, login deduplication, legacy migration and forged input rejection passed.');
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
} else {
  const source = process.env.LICLICK_TELEMETRY_SOURCE;
  const rawPath = path.join(process.env.LICLICK_WORKSPACE_DIR, 'telemetry/events.ndjson');
  await fs.mkdir(path.dirname(rawPath), { recursive: true });
  const event = {
    event_id: 'evt_11111111-1111-4111-8111-111111111111', event_type: 'module_action',
    ts: new Date().toISOString(), machine_id: 'machine_11111111-1111-4111-8111-111111111111',
    host_version: 'browser', data: { module: 'texture_painting', action: 'open' },
    received_at: new Date().toISOString(),
    identity: { user_key: 'feishu:test', user_name: 'Test', email: 'test@example.invalid' },
  };
  await fs.writeFile(rawPath, JSON.stringify(event) + '\n');
  const identity = await import('../dist/services/identityTelemetryService.js');
  const platform = await import('../dist/services/feishuPlatformService.js');
  const { serverConfig } = await import('../dist/config.js');
  const user = { id: 'feishu-test', displayName: 'Test', email: 'test@example.invalid', authSource: 'feishu-oauth' };
  await identity.identityTelemetryStorage.initialize();
  await identity.recordFeishuLogin(user, 'same-login');
  await identity.recordFeishuLogin(user, 'same-login');
  await identity.recordFeishuLogin(user, 'another-login');
  const [aggregate] = await identity.identityTelemetryStorage.listPendingAggregates();
  assert.equal(aggregate.source, source);
  assert.equal(aggregate.event_count, 3);
  const fields = platform.prepareTelemetryAggregateForBitable(aggregate).fields;
  assert.equal(fields['来源'], source);
  assert.equal(fields['登录次数'], 2);
  assert.equal(fields['贴图绘制次数'], 1);
  await identity.identityTelemetryStorage.markAggregateSynced({
    aggregate_key: aggregate.aggregate_key, sync_hash: aggregate.sync_hash, record_id: 'recTest',
  });
  assert.equal((await identity.identityTelemetryStorage.listPendingAggregates()).length, 0);
  assert.equal(JSON.parse((await fs.readFile(rawPath, 'utf8')).split('\n')[0]).source, source);
  const { received_at, identity: ignoredIdentity, ...publicEvent } = event;
  void received_at; void ignoredIdentity;
  assert.throws(() => identity.parseTelemetryEvent({ ...publicEvent, source: 'forged' }));
  assert.throws(() => identity.parseTelemetryEvent({ ...publicEvent, event_type: 'login_success', data: { module: 'auth', action: 'login' } }));
  serverConfig.telemetrySource = 'changed';
  await identity.recordFeishuLogin(user, 'same-login');
  assert.equal((await identity.identityTelemetryStorage.listPendingAggregates()).length, 0);
  console.log(JSON.stringify(aggregate));
}
