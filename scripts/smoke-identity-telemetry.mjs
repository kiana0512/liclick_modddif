import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const smokeRoot = path.join(os.tmpdir(), `li3d-identity-telemetry-${process.pid}-${randomUUID()}`);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function event(device, eventId = `evt_${randomUUID()}`) {
  return {
    event_id: eventId,
    event_type: 'module_action',
    ts: new Date().toISOString(),
    ...device,
    session_id: `sess_${randomUUID()}`,
    version: '0.1.4',
    host_version: 'browser',
    data: {
      module: 'texture_painting',
      action: 'open',
    },
  };
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

async function main() {
  await fs.mkdir(smokeRoot, { recursive: true });
  try {
    process.env.LICLICK_WORKSPACE_DIR = smokeRoot;
    process.env.SERVER_HOST = '127.0.0.1';
    process.env.SESSION_SECRET = 'identity-telemetry-smoke-only';

  const service = await import(
    `../apps/server/dist/services/identityTelemetryService.js?smoke=${Date.now()}`
  );
  const device = {
    machine_id: `machine_${randomUUID()}`,
    install_id: `install_${randomUUID()}`,
  };

  await service.identityTelemetryStorage.initialize();
  const initial = await service.identityTelemetryStorage.status(device);
  assert(initial.bound === false, 'Fresh random device must start unbound.');

  const anonymousEvent = event(device);
  const firstIngest = await service.identityTelemetryStorage.ingest([anonymousEvent]);
  assert(firstIngest.accepted === 1, 'First event must be accepted.');

  const duplicateIngest = await service.identityTelemetryStorage.ingest([anonymousEvent]);
  assert(duplicateIngest.duplicates === 1, 'Repeated event_id must be deduplicated.');

  await service.bindDeviceToFeishuIdentity(device, {
    authUserId: 'feishu-user-a',
    userKey: 'feishu:union-a',
    userName: 'Smoke User A',
    email: 'smoke.a@example.invalid',
    openId: 'open-a',
    unionId: 'union-a',
  });
  const bound = await service.identityTelemetryStorage.status(device);
  assert(bound.bound === true && bound.user_key === 'feishu:union-a', 'First binding must resolve uniquely.');

  const rawEventsPath = path.join(smokeRoot, 'telemetry', 'events.ndjson');
  const rawEvents = (await fs.readFile(rawEventsPath, 'utf8'))
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert(rawEvents.length === 1, 'Deduplication must leave one raw event.');
  assert(rawEvents[0].identity?.user_key === 'feishu:union-a', 'Anonymous event must migrate after first binding.');

  const aggregateStore = await readJson(path.join(smokeRoot, 'telemetry', 'daily-aggregates.json'));
  assert(aggregateStore.aggregates?.length === 1, 'Migrated event must produce exactly one daily aggregate.');
  assert(aggregateStore.aggregates[0].event_count === 1, 'Migration must not increment the event count.');
  assert(
    aggregateStore.aggregates[0].counts?.texture_painting_open_count === 1,
    'Module counter must remain exactly one after migration.',
  );
  const pendingBeforeSync = await service.identityTelemetryStorage.listPendingAggregates();
  assert(pendingBeforeSync.length === 1, 'New daily aggregate must be pending sync.');
  await service.identityTelemetryStorage.markAggregateSynced({
    aggregate_key: pendingBeforeSync[0].aggregate_key,
    sync_hash: pendingBeforeSync[0].sync_hash,
    record_id: 'rec_identity_smoke',
  });

  // Rebinding the same explicit identity rebuilds aggregates but must preserve
  // a successful sink state when the absolute aggregate content is unchanged.
  await service.bindDeviceToFeishuIdentity(device, {
    authUserId: 'feishu-user-a',
    userKey: 'feishu:union-a',
    userName: 'Smoke User A',
    email: 'smoke.a@example.invalid',
    openId: 'open-a',
    unionId: 'union-a',
  });
  assert(
    (await service.identityTelemetryStorage.listPendingAggregates()).length === 0,
    'Aggregate rebuild must preserve successful sync state for unchanged absolute values.',
  );

  await service.bindDeviceToFeishuIdentity(device, {
    authUserId: 'feishu-user-b',
    userKey: 'feishu:union-b',
    userName: 'Smoke User B',
    email: 'smoke.b@example.invalid',
    openId: 'open-b',
    unionId: 'union-b',
  });
  const sharedDevice = await service.identityTelemetryStorage.status(device);
  assert(
    sharedDevice.bound === false && sharedDevice.ambiguous === true,
    'A shared device with multiple candidates must require explicit reauthorization.',
  );

  const sharedEvent = event(device);
  await service.identityTelemetryStorage.ingest([sharedEvent]);
  const latestRawEvents = (await fs.readFile(rawEventsPath, 'utf8'))
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert(
    latestRawEvents.at(-1)?.identity?.user_key.startsWith('machine:'),
    'Ambiguous shared-device events must stay anonymous.',
  );

  const explicitlyAuthenticatedEvent = event(device);
  await service.identityTelemetryStorage.ingest(
    [explicitlyAuthenticatedEvent],
    {
      authUserId: 'feishu-user-b',
      userKey: 'feishu:union-b',
      userName: 'Smoke User B',
      email: 'smoke.b@example.invalid',
      openId: 'open-b',
      unionId: 'union-b',
    },
  );
  const eventsAfterSessionOverride = (await fs.readFile(rawEventsPath, 'utf8'))
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert(
    eventsAfterSessionOverride.at(-1)?.identity?.user_key === 'feishu:union-b',
    'An explicit Feishu session must override ambiguous device attribution for that event batch.',
  );

  const pendingAfterNewEvents = await service.identityTelemetryStorage.listPendingAggregates();
  assert(pendingAfterNewEvents.length === 2, 'Anonymous and explicit-session aggregates must both remain pending.');
  const failedAggregate = await service.identityTelemetryStorage.markAggregateSyncFailed({
    aggregate_key: pendingAfterNewEvents[0].aggregate_key,
    sync_hash: pendingAfterNewEvents[0].sync_hash,
    error: 'temporary sink failure token=must-be-redacted',
  });
  assert(
    failedAggregate.sync_pending === true && !failedAggregate.sync_error?.includes('must-be-redacted'),
    'Sink failures must remain pending and redact token-like values.',
  );

  let sensitivePayloadRejected = false;
  try {
    service.parseTelemetryBatch({
      events: [
        {
          ...event(device),
          data: {
            module: 'texture_painting',
            action: 'open',
            prompt: 'must-not-be-accepted',
          },
        },
      ],
    });
  } catch {
    sensitivePayloadRejected = true;
  }
  assert(sensitivePayloadRejected, 'Unexpected prompt/image/path-style fields must be rejected.');

    console.log('Identity and telemetry smoke test passed.');
  } finally {
    await fs.rm(smokeRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
