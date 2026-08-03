import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { serverConfig } from '../config.js';
import type { AuthUser } from '../auth/authTypes.js';

const identityDirectory = path.join(serverConfig.workspaceDir, 'identity');
const telemetryDirectory = path.join(serverConfig.workspaceDir, 'telemetry');
const identityFile = path.join(identityDirectory, 'device-bindings.json');
const rawEventsFile = path.join(telemetryDirectory, 'events.ndjson');
const dailyAggregatesFile = path.join(telemetryDirectory, 'daily-aggregates.json');

const uuidV4Pattern = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const machineIdPattern = new RegExp(`^machine_${uuidV4Pattern}$`, 'i');
const installIdPattern = new RegExp(`^(?:install|tool)_${uuidV4Pattern}$`, 'i');
const eventIdPattern = new RegExp(`^evt_${uuidV4Pattern}$`, 'i');
const sessionIdPattern = new RegExp(`^sess_${uuidV4Pattern}$`, 'i');
const versionPattern = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,31}$/;
const hostVersionPattern = /^[A-Za-z0-9][A-Za-z0-9 ._()+-]{0,63}$/;
const eventNamePattern = /^[a-z][a-z0-9_.:-]{0,63}$/;
const dimensionPattern = /^[a-z][a-z0-9_.:-]{0,63}$/;

const allowedEventTypes = new Set(['module_action']);
const allowedModules = new Set([
  'texture_painting',
  'model_baking',
  'toolbox',
  'auto_retopology',
  'auto_uv',
  'local_repaint',
  'local_component',
]);
const allowedActions = new Set(['open', 'start', 'complete', 'fail', 'download', 'install', 'detect']);

export type DeviceIdentityInput = {
  machine_id?: string;
  install_id?: string;
  version?: string;
  host_version?: string;
};

export type FeishuIdentityProfile = {
  authUserId: string;
  userKey: string;
  userName: string;
  email?: string;
  department?: string;
  openId?: string;
  unionId?: string;
  userId?: string;
  tenantKey?: string;
};

type StoredIdentityProfile = {
  user_key: string;
  auth_user_id: string;
  user_name: string;
  email?: string;
  department?: string;
  feishu_open_id?: string;
  feishu_union_id?: string;
  feishu_user_id?: string;
  tenant_key?: string;
  created_at: string;
  updated_at: string;
};

type CandidateIndexEntry = {
  candidates: Record<string, StoredIdentityProfile>;
  updated_at: string;
};

type IdentityDatabase = {
  schema_version: 1;
  by_machine: Record<string, CandidateIndexEntry>;
  by_install: Record<string, CandidateIndexEntry>;
  by_pair: Record<string, StoredIdentityProfile>;
  updated_at: string;
};

export type TelemetryEventInput = {
  event_id: string;
  event_type: string;
  ts: string;
  machine_id?: string;
  install_id?: string;
  session_id?: string;
  version?: string;
  host_version?: string;
  data: {
    module: string;
    action: string;
  };
};

type StoredTelemetryEvent = TelemetryEventInput & {
  received_at: string;
  identity: {
    user_key: string;
    user_name?: string;
    email?: string;
    department?: string;
  };
};

export type DailyTelemetryAggregate = {
  aggregate_key: string;
  date_key: string;
  user_key: string;
  user_name?: string;
  email?: string;
  department?: string;
  version: string;
  host_version: string;
  event_count: number;
  counts: Record<string, number>;
  processed_event_ids: string[];
  last_event_at: string;
  sync_pending: boolean;
  sync_hash: string;
  sync_record_id?: string;
  synced_at?: string;
  sync_error?: string;
  updated_at: string;
};

export type IdentityStatus = {
  ok: true;
  bound: boolean;
  ambiguous?: boolean;
  user_key?: string;
  user_name?: string;
  email?: string;
  department?: string;
};

export type EventIngestResult = {
  ok: true;
  accepted: number;
  duplicates: number;
  rejected: 0;
  accepted_event_ids: string[];
  duplicate_event_ids: string[];
};

/**
 * Storage boundary for the single-node MVP. A multi-instance deployment must
 * replace this file-backed implementation with shared transactional storage
 * (for example PostgreSQL for bindings/events and Redis for short-lived state).
 */
export interface IdentityTelemetryStorage {
  initialize(): Promise<void>;
  status(device: DeviceIdentityInput): Promise<IdentityStatus>;
  bind(device: DeviceIdentityInput, profile: FeishuIdentityProfile): Promise<IdentityStatus>;
  ingest(events: TelemetryEventInput[], identityOverride?: FeishuIdentityProfile): Promise<EventIngestResult>;
  listPendingAggregates(limit?: number): Promise<DailyTelemetryAggregate[]>;
  markAggregateSynced(input: AggregateSyncSuccess): Promise<DailyTelemetryAggregate>;
  markAggregateSyncFailed(input: AggregateSyncFailure): Promise<DailyTelemetryAggregate>;
}

export type AggregateSyncSuccess = {
  aggregate_key: string;
  sync_hash: string;
  record_id?: string;
  synced_at?: string;
};

export type AggregateSyncFailure = {
  aggregate_key: string;
  sync_hash: string;
  error: string;
};

function emptyIdentityDatabase(): IdentityDatabase {
  return {
    schema_version: 1,
    by_machine: {},
    by_install: {},
    by_pair: {},
    updated_at: new Date(0).toISOString(),
  };
}

function assertPlainObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object.`);
  }
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: readonly string[], label: string) {
  const allowedKeys = new Set(allowed);
  const unexpected = Object.keys(value).filter((key) => !allowedKeys.has(key));
  if (unexpected.length > 0) {
    throw new Error(`${label} contains unsupported fields: ${unexpected.join(', ')}.`);
  }
}

function optionalString(
  value: unknown,
  label: string,
  pattern: RegExp,
  maximumLength: number,
) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || value.length > maximumLength || !pattern.test(value)) {
    throw new Error(`${label} has an invalid format.`);
  }
  return value;
}

export function parseDeviceIdentityInput(value: unknown): DeviceIdentityInput {
  assertPlainObject(value, 'Device identity');
  assertOnlyKeys(value, ['machine_id', 'install_id', 'version', 'host_version'], 'Device identity');
  const machine_id = optionalString(value.machine_id, 'machine_id', machineIdPattern, 128);
  const install_id = optionalString(value.install_id, 'install_id', installIdPattern, 128);
  if (!machine_id && !install_id) {
    throw new Error('machine_id or install_id is required. Use an application-generated random identifier.');
  }
  return {
    machine_id,
    install_id,
    version: optionalString(value.version, 'version', versionPattern, 32),
    host_version: optionalString(value.host_version, 'host_version', hostVersionPattern, 64),
  };
}

function requiredString(value: unknown, label: string, pattern: RegExp, maximumLength: number) {
  const parsed = optionalString(value, label, pattern, maximumLength);
  if (!parsed) throw new Error(`${label} is required.`);
  return parsed;
}

function parseEventData(value: unknown) {
  assertPlainObject(value, 'event.data');
  assertOnlyKeys(value, ['module', 'action'], 'event.data');
  const module = requiredString(value.module, 'event.data.module', dimensionPattern, 64);
  const action = requiredString(value.action, 'event.data.action', dimensionPattern, 64);
  if (!allowedModules.has(module)) throw new Error(`event.data.module is not allowed: ${module}.`);
  if (!allowedActions.has(action)) throw new Error(`event.data.action is not allowed: ${action}.`);
  return { module, action };
}

export function parseTelemetryEvent(value: unknown): TelemetryEventInput {
  assertPlainObject(value, 'Telemetry event');
  assertOnlyKeys(
    value,
    [
      'event_id',
      'event_type',
      'event_name',
      'ts',
      'occurred_at',
      'machine_id',
      'install_id',
      'session_id',
      'version',
      'host_version',
      'data',
      'properties',
    ],
    'Telemetry event',
  );
  if (value.event_type !== undefined && value.event_name !== undefined) {
    throw new Error('Telemetry event must not contain both event_type and event_name.');
  }
  if (value.ts !== undefined && value.occurred_at !== undefined) {
    throw new Error('Telemetry event must not contain both ts and occurred_at.');
  }
  if (value.data !== undefined && value.properties !== undefined) {
    throw new Error('Telemetry event must not contain both data and properties.');
  }
  const event_id = requiredString(value.event_id, 'event_id', eventIdPattern, 128);
  const event_type = requiredString(
    value.event_type ?? value.event_name,
    'event_type',
    eventNamePattern,
    64,
  );
  if (!allowedEventTypes.has(event_type)) throw new Error(`event_type is not allowed: ${event_type}.`);
  const ts = requiredString(value.ts ?? value.occurred_at, 'ts', /^\d{4}-\d{2}-\d{2}T[^\s]{1,40}$/, 48);
  const parsedTimestamp = new Date(ts);
  if (!Number.isFinite(parsedTimestamp.getTime())) throw new Error('ts must be a valid ISO-8601 timestamp.');
  const device = parseDeviceIdentityInput({
    machine_id: value.machine_id,
    install_id: value.install_id,
    version: value.version,
    host_version: value.host_version,
  });
  return {
    event_id,
    event_type,
    ts: parsedTimestamp.toISOString(),
    machine_id: device.machine_id,
    install_id: device.install_id,
    session_id: optionalString(value.session_id, 'session_id', sessionIdPattern, 128),
    version: device.version,
    host_version: device.host_version,
    data: parseEventData(value.data ?? value.properties),
  };
}

export function parseTelemetryBatch(value: unknown, maximumEvents = 20) {
  assertPlainObject(value, 'Telemetry request');
  let rawEvents: unknown[];
  if ('events' in value) {
    assertOnlyKeys(value, ['events'], 'Telemetry request');
    if (!Array.isArray(value.events)) throw new Error('events must be an array.');
    rawEvents = value.events;
  } else {
    rawEvents = [value];
  }
  if (rawEvents.length === 0) throw new Error('At least one telemetry event is required.');
  if (rawEvents.length > maximumEvents) throw new Error(`A telemetry batch may contain at most ${maximumEvents} events.`);
  return rawEvents.map(parseTelemetryEvent);
}

function machineKey(machineId: string) {
  return `machine:${machineId}`;
}

function installKey(installId: string) {
  return `install:${installId}`;
}

function pairKey(device: DeviceIdentityInput) {
  return device.machine_id && device.install_id
    ? `pair:${device.machine_id}|${device.install_id}`
    : undefined;
}

function anonymousKey(device: DeviceIdentityInput) {
  return device.machine_id ? machineKey(device.machine_id) : installKey(device.install_id!);
}

function candidateProfiles(entry?: CandidateIndexEntry) {
  return entry ? Object.values(entry.candidates) : [];
}

function uniqueCandidate(entry?: CandidateIndexEntry) {
  const candidates = candidateProfiles(entry);
  return candidates.length === 1 ? candidates[0] : undefined;
}

function resolveStoredIdentity(database: IdentityDatabase, device: DeviceIdentityInput) {
  const machineEntry = device.machine_id ? database.by_machine[machineKey(device.machine_id)] : undefined;
  const installEntry = device.install_id ? database.by_install[installKey(device.install_id)] : undefined;
  const machineProfile = uniqueCandidate(machineEntry);
  const installProfile = uniqueCandidate(installEntry);
  const machineAmbiguous = candidateProfiles(machineEntry).length > 1;
  const installAmbiguous = candidateProfiles(installEntry).length > 1;
  if (machineAmbiguous || installAmbiguous) return { profile: undefined, ambiguous: true };
  if (machineProfile && installProfile && machineProfile.user_key !== installProfile.user_key) {
    return { profile: undefined, ambiguous: true };
  }
  const exactPair = pairKey(device);
  if (exactPair && database.by_pair[exactPair]) {
    return { profile: database.by_pair[exactPair], ambiguous: false };
  }
  return { profile: machineProfile ?? installProfile, ambiguous: false };
}

function publicIdentityStatus(database: IdentityDatabase, device: DeviceIdentityInput): IdentityStatus {
  const resolved = resolveStoredIdentity(database, device);
  if (!resolved.profile) {
    return { ok: true, bound: false, ambiguous: resolved.ambiguous || undefined };
  }
  return {
    ok: true,
    bound: true,
    user_key: resolved.profile.user_key,
    user_name: resolved.profile.user_name,
    email: resolved.profile.email,
    department: resolved.profile.department,
  };
}

function storedProfile(input: FeishuIdentityProfile, existing?: StoredIdentityProfile): StoredIdentityProfile {
  const timestamp = new Date().toISOString();
  return {
    user_key: input.userKey,
    auth_user_id: input.authUserId,
    user_name: input.userName,
    email: input.email,
    department: input.department,
    feishu_open_id: input.openId,
    feishu_union_id: input.unionId,
    feishu_user_id: input.userId,
    tenant_key: input.tenantKey,
    created_at: existing?.created_at ?? timestamp,
    updated_at: timestamp,
  };
}

function addCandidate(
  index: Record<string, CandidateIndexEntry>,
  key: string,
  profile: FeishuIdentityProfile,
) {
  const existing = index[key];
  const nextProfile = storedProfile(profile, existing?.candidates[profile.userKey]);
  index[key] = {
    candidates: { ...(existing?.candidates ?? {}), [profile.userKey]: nextProfile },
    updated_at: nextProfile.updated_at,
  };
  return nextProfile;
}

function eventMatchesResolvedProfile(
  database: IdentityDatabase,
  event: StoredTelemetryEvent,
  profile: StoredIdentityProfile,
) {
  if (!event.identity.user_key.startsWith('machine:') && !event.identity.user_key.startsWith('install:')) {
    return false;
  }
  const resolved = resolveStoredIdentity(database, {
    machine_id: event.machine_id,
    install_id: event.install_id,
  });
  return resolved.profile?.user_key === profile.user_key;
}

function aggregateKey(event: StoredTelemetryEvent) {
  return JSON.stringify([
    event.ts.slice(0, 10),
    event.identity.user_key,
    event.version ?? '',
    event.host_version ?? '',
  ]);
}

function aggregateContentHash(aggregate: DailyTelemetryAggregate) {
  return createHash('sha256')
    .update(JSON.stringify({
      date_key: aggregate.date_key,
      user_key: aggregate.user_key,
      user_name: aggregate.user_name ?? '',
      email: aggregate.email ?? '',
      department: aggregate.department ?? '',
      version: aggregate.version,
      host_version: aggregate.host_version,
      event_count: aggregate.event_count,
      counts: Object.fromEntries(Object.entries(aggregate.counts).sort(([left], [right]) => left.localeCompare(right))),
      last_event_at: aggregate.last_event_at,
    }))
    .digest('hex');
}

function buildDailyAggregates(
  events: StoredTelemetryEvent[],
  previousSyncState = new Map<string, DailyTelemetryAggregate>(),
) {
  const aggregates = new Map<string, DailyTelemetryAggregate>();
  for (const event of events) {
    const key = aggregateKey(event);
    const counterKey = `${event.data.module}_${event.data.action}_count`;
    const existing = aggregates.get(key);
    if (existing) {
      existing.event_count += 1;
      existing.counts[counterKey] = (existing.counts[counterKey] ?? 0) + 1;
      existing.processed_event_ids.push(event.event_id);
      if (event.ts > existing.last_event_at) existing.last_event_at = event.ts;
      existing.updated_at = new Date().toISOString();
      continue;
    }
    aggregates.set(key, {
      aggregate_key: key,
      date_key: event.ts.slice(0, 10),
      user_key: event.identity.user_key,
      user_name: event.identity.user_name,
      email: event.identity.email,
      department: event.identity.department,
      version: event.version ?? '',
      host_version: event.host_version ?? '',
      event_count: 1,
      counts: { [counterKey]: 1 },
      processed_event_ids: [event.event_id],
      last_event_at: event.ts,
      sync_pending: true,
      sync_hash: '',
      updated_at: new Date().toISOString(),
    });
  }
  return [...aggregates.values()]
    .map((aggregate) => {
      const syncHash = aggregateContentHash(aggregate);
      const previous = previousSyncState.get(aggregate.aggregate_key);
      const sameContent = previous?.sync_hash === syncHash;
      return {
        ...aggregate,
        sync_pending: sameContent ? previous.sync_pending : true,
        sync_hash: syncHash,
        sync_record_id: previous?.sync_record_id,
        synced_at: previous?.synced_at,
        sync_error: sameContent ? previous.sync_error : undefined,
      };
    })
    .sort((left, right) => left.aggregate_key.localeCompare(right.aggregate_key));
}

async function writeJsonAtomic(filePath: string, value: unknown) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fs.rename(temporaryPath, filePath);
}

async function writeNdjsonAtomic(filePath: string, events: StoredTelemetryEvent[]) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  const payload = events.length > 0 ? `${events.map((event) => JSON.stringify(event)).join('\n')}\n` : '';
  await fs.writeFile(temporaryPath, payload, 'utf8');
  await fs.rename(temporaryPath, filePath);
}

function cloneAggregate(aggregate: DailyTelemetryAggregate): DailyTelemetryAggregate {
  return {
    ...aggregate,
    counts: { ...aggregate.counts },
    processed_event_ids: [...aggregate.processed_event_ids],
  };
}

function optionalSyncRecordId(value?: string) {
  if (value === undefined || value === '') return undefined;
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new Error('record_id has an invalid format.');
  return value;
}

function normalizeSyncTimestamp(value: string) {
  if (value.length > 48) throw new Error('synced_at has an invalid format.');
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error('synced_at must be a valid ISO-8601 timestamp.');
  return parsed.toISOString();
}

function sanitizeSyncError(value: string) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('error is required.');
  return value
    .trim()
    .slice(0, 1000)
    .replace(/((?:access_token|refresh_token|token|app_secret)=)[^&\s]+/gi, '$1[redacted]')
    .replace(/(authorization:\s*bearer\s+)[^\s]+/gi, '$1[redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[redacted-jwt]');
}

class FileIdentityTelemetryStorage implements IdentityTelemetryStorage {
  private identityDatabase = emptyIdentityDatabase();
  private rawEvents: StoredTelemetryEvent[] = [];
  private seenEventIds = new Set<string>();
  private dailyAggregates = new Map<string, DailyTelemetryAggregate>();
  private initialization?: Promise<void>;
  private writeQueue = Promise.resolve();

  initialize() {
    this.initialization ??= this.load();
    return this.initialization;
  }

  private async load() {
    await Promise.all([fs.mkdir(identityDirectory, { recursive: true }), fs.mkdir(telemetryDirectory, { recursive: true })]);
    try {
      const parsed = JSON.parse(await fs.readFile(identityFile, 'utf8')) as IdentityDatabase;
      this.identityDatabase = {
        ...emptyIdentityDatabase(),
        ...parsed,
        by_machine: parsed.by_machine ?? {},
        by_install: parsed.by_install ?? {},
        by_pair: parsed.by_pair ?? {},
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await writeJsonAtomic(identityFile, this.identityDatabase);
    }

    try {
      const aggregateDocument = JSON.parse(await fs.readFile(dailyAggregatesFile, 'utf8')) as {
        aggregates?: DailyTelemetryAggregate[];
      };
      this.dailyAggregates = new Map(
        (Array.isArray(aggregateDocument.aggregates) ? aggregateDocument.aggregates : [])
          .filter((aggregate) => aggregate?.aggregate_key)
          .map((aggregate) => [aggregate.aggregate_key, aggregate]),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }

    let raw = '';
    try {
      raw = await fs.readFile(rawEventsFile, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await fs.writeFile(rawEventsFile, '', 'utf8');
    }
    const seen = new Set<string>();
    this.rawEvents = raw
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line, index) => {
        try {
          return JSON.parse(line) as StoredTelemetryEvent;
        } catch {
          throw new Error(`Telemetry event log contains invalid JSON on line ${index + 1}.`);
        }
      })
      .filter((event) => {
        if (!event.event_id || seen.has(event.event_id)) return false;
        seen.add(event.event_id);
        return true;
      });
    this.seenEventIds = seen;
    await this.persistAggregates();
  }

  private runExclusive<T>(task: () => Promise<T>) {
    const result = this.writeQueue.then(task, task);
    this.writeQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async persistAggregates() {
    const aggregates = buildDailyAggregates(this.rawEvents, this.dailyAggregates);
    this.dailyAggregates = new Map(aggregates.map((aggregate) => [aggregate.aggregate_key, aggregate]));
    await writeJsonAtomic(dailyAggregatesFile, {
      schema_version: 1,
      generated_at: new Date().toISOString(),
      aggregates,
    });
  }

  async status(device: DeviceIdentityInput) {
    await this.initialize();
    return publicIdentityStatus(this.identityDatabase, device);
  }

  async bind(device: DeviceIdentityInput, input: FeishuIdentityProfile) {
    await this.initialize();
    return this.runExclusive(async () => {
      let profile: StoredIdentityProfile | undefined;
      if (device.machine_id) profile = addCandidate(this.identityDatabase.by_machine, machineKey(device.machine_id), input);
      if (device.install_id) profile = addCandidate(this.identityDatabase.by_install, installKey(device.install_id), input);
      const exactPair = pairKey(device);
      if (exactPair) this.identityDatabase.by_pair[exactPair] = storedProfile(input, this.identityDatabase.by_pair[exactPair]);
      this.identityDatabase.updated_at = new Date().toISOString();
      await writeJsonAtomic(identityFile, this.identityDatabase);

      const resolvedProfile = profile ?? storedProfile(input);
      let migrated = false;
      this.rawEvents = this.rawEvents.map((event) => {
        if (!eventMatchesResolvedProfile(this.identityDatabase, event, resolvedProfile)) return event;
        migrated = true;
        return {
          ...event,
          identity: {
            user_key: resolvedProfile.user_key,
            user_name: resolvedProfile.user_name,
            email: resolvedProfile.email,
            department: resolvedProfile.department,
          },
        };
      });
      if (migrated) await writeNdjsonAtomic(rawEventsFile, this.rawEvents);
      await this.persistAggregates();
      return publicIdentityStatus(this.identityDatabase, device);
    });
  }

  async ingest(events: TelemetryEventInput[], identityOverride?: FeishuIdentityProfile) {
    await this.initialize();
    return this.runExclusive(async () => {
      const acceptedIds: string[] = [];
      const duplicateIds: string[] = [];
      const pendingIds = new Set<string>();
      const acceptedEvents: StoredTelemetryEvent[] = [];
      const receivedAt = new Date().toISOString();
      for (const event of events) {
        if (this.seenEventIds.has(event.event_id) || pendingIds.has(event.event_id)) {
          duplicateIds.push(event.event_id);
          continue;
        }
        pendingIds.add(event.event_id);
        const resolved = identityOverride
          ? storedProfile(identityOverride)
          : resolveStoredIdentity(this.identityDatabase, {
              machine_id: event.machine_id,
              install_id: event.install_id,
            }).profile;
        acceptedEvents.push({
          ...event,
          received_at: receivedAt,
          identity: resolved
            ? {
                user_key: resolved.user_key,
                user_name: resolved.user_name,
                email: resolved.email,
                department: resolved.department,
              }
            : { user_key: anonymousKey(event) },
        });
        acceptedIds.push(event.event_id);
      }
      if (acceptedEvents.length > 0) {
        await fs.appendFile(rawEventsFile, acceptedEvents.map((event) => `${JSON.stringify(event)}\n`).join(''), 'utf8');
        this.rawEvents.push(...acceptedEvents);
        for (const eventId of acceptedIds) this.seenEventIds.add(eventId);
        await this.persistAggregates();
      }
      return {
        ok: true,
        accepted: acceptedIds.length,
        duplicates: duplicateIds.length,
        rejected: 0,
        accepted_event_ids: acceptedIds,
        duplicate_event_ids: duplicateIds,
      } satisfies EventIngestResult;
    });
  }

  async listPendingAggregates(limit = 100) {
    await this.initialize();
    const safeLimit = Math.max(1, Math.min(500, Math.floor(limit)));
    return this.runExclusive(async () =>
      [...this.dailyAggregates.values()]
        .filter((aggregate) => aggregate.sync_pending)
        .sort((left, right) => left.updated_at.localeCompare(right.updated_at))
        .slice(0, safeLimit)
        .map(cloneAggregate),
    );
  }

  async markAggregateSynced(input: AggregateSyncSuccess) {
    await this.initialize();
    return this.runExclusive(async () => {
      const aggregate = this.requireCurrentAggregate(input.aggregate_key, input.sync_hash);
      const syncedAt = input.synced_at ? normalizeSyncTimestamp(input.synced_at) : new Date().toISOString();
      const next: DailyTelemetryAggregate = {
        ...aggregate,
        sync_pending: false,
        sync_record_id:
          input.record_id === undefined ? aggregate.sync_record_id : optionalSyncRecordId(input.record_id),
        synced_at: syncedAt,
        sync_error: undefined,
        updated_at: new Date().toISOString(),
      };
      this.dailyAggregates.set(next.aggregate_key, next);
      await this.persistAggregates();
      return cloneAggregate(this.dailyAggregates.get(next.aggregate_key)!);
    });
  }

  async markAggregateSyncFailed(input: AggregateSyncFailure) {
    await this.initialize();
    return this.runExclusive(async () => {
      const aggregate = this.requireCurrentAggregate(input.aggregate_key, input.sync_hash);
      const next: DailyTelemetryAggregate = {
        ...aggregate,
        sync_pending: true,
        sync_error: sanitizeSyncError(input.error),
        updated_at: new Date().toISOString(),
      };
      this.dailyAggregates.set(next.aggregate_key, next);
      await this.persistAggregates();
      return cloneAggregate(this.dailyAggregates.get(next.aggregate_key)!);
    });
  }

  private requireCurrentAggregate(aggregateKey: string, syncHash: string) {
    if (!aggregateKey || aggregateKey.length > 512) throw new Error('aggregate_key has an invalid format.');
    if (!/^[a-f0-9]{64}$/i.test(syncHash)) throw new Error('sync_hash has an invalid format.');
    const aggregate = this.dailyAggregates.get(aggregateKey);
    if (!aggregate) throw new Error('Daily aggregate was not found.');
    if (aggregate.sync_hash !== syncHash) {
      throw new Error('Daily aggregate changed after it was read. Reload pending aggregates before marking sync status.');
    }
    return aggregate;
  }
}

export const identityTelemetryStorage: IdentityTelemetryStorage = new FileIdentityTelemetryStorage();

export async function bindDeviceToFeishuIdentity(
  device: DeviceIdentityInput,
  profile: FeishuIdentityProfile,
) {
  return identityTelemetryStorage.bind(device, profile);
}

export async function bindDeviceToCurrentUser(device: DeviceIdentityInput, user: AuthUser) {
  return bindDeviceToFeishuIdentity(device, feishuIdentityFromAuthUser(user));
}

export function feishuIdentityFromAuthUser(user: AuthUser): FeishuIdentityProfile {
  const externalId = user.id.startsWith('feishu-') ? user.id.slice('feishu-'.length) : user.id;
  return {
    authUserId: user.id,
    userKey: `feishu:${externalId}`,
    userName: user.displayName,
    email: user.email,
  };
}
