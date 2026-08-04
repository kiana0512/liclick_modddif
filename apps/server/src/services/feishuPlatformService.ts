import { createHash } from 'node:crypto';
import { serverConfig } from '../config.js';

const requestTimeoutMs = 15_000;
const maximumDepartmentDepth = 20;

type FeishuEnvelope = {
  code?: number;
  msg?: string;
  data?: unknown;
  [key: string]: unknown;
};

class FeishuPlatformRequestError extends Error {
  constructor(
    operation: string,
    readonly httpStatus?: number,
    readonly apiCode?: number,
  ) {
    const status = httpStatus ? ` HTTP ${httpStatus}` : '';
    const code = apiCode === undefined ? '' : ` code ${apiCode}`;
    super(`Feishu ${operation} failed.${status}${code}`);
    this.name = 'FeishuPlatformRequestError';
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

async function requestFeishuJson<T extends FeishuEnvelope>(
  operation: string,
  url: string,
  init: RequestInit,
) {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
  } catch {
    throw new FeishuPlatformRequestError(operation);
  }

  const payload = (await response.json().catch(() => undefined)) as T | undefined;
  const apiCode = typeof payload?.code === 'number' ? payload.code : undefined;
  if (!response.ok || (apiCode !== undefined && apiCode !== 0)) {
    throw new FeishuPlatformRequestError(operation, response.status, apiCode);
  }
  if (!payload) throw new FeishuPlatformRequestError(operation, response.status);
  return payload;
}

type TenantTokenResponse = FeishuEnvelope & {
  tenant_access_token?: string;
  expire?: number;
};

let cachedTenantToken:
  | {
      value: string;
      refreshAt: number;
    }
  | undefined;
let pendingTenantToken: Promise<string> | undefined;

async function requestTenantAccessToken() {
  const config = serverConfig.feishuPlatform;
  const payload = await requestFeishuJson<TenantTokenResponse>(
    'tenant access token request',
    config.tenantTokenUrl,
    {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({
        app_id: config.appId,
        app_secret: config.appSecret,
      }),
    },
  );
  if (!payload.tenant_access_token || typeof payload.tenant_access_token !== 'string') {
    throw new FeishuPlatformRequestError('tenant access token response');
  }
  const lifetimeSeconds = Number(payload.expire ?? 0);
  if (!Number.isFinite(lifetimeSeconds) || lifetimeSeconds <= 0) {
    throw new FeishuPlatformRequestError('tenant access token expiry');
  }
  cachedTenantToken = {
    value: payload.tenant_access_token,
    // Refresh after 80% of the advertised lifetime. This remains valid for
    // short-lived mock tokens without assuming the usual two-hour lifetime.
    refreshAt: Date.now() + Math.max(1_000, Math.floor(lifetimeSeconds * 800)),
  };
  return cachedTenantToken.value;
}

async function getTenantAccessToken() {
  if (cachedTenantToken && cachedTenantToken.refreshAt > Date.now()) {
    return cachedTenantToken.value;
  }
  pendingTenantToken ??= requestTenantAccessToken().finally(() => {
    pendingTenantToken = undefined;
  });
  return pendingTenantToken;
}

function bearerHeaders(token: string) {
  return {
    accept: 'application/json',
    authorization: `Bearer ${token}`,
    'content-type': 'application/json; charset=utf-8',
  };
}

type ContactUser = {
  open_id?: string;
  union_id?: string;
  user_id?: string;
  name?: string;
  en_name?: string;
  email?: string;
  enterprise_email?: string;
  department_ids?: unknown;
};

type ContactDepartment = {
  department_id?: string;
  open_department_id?: string;
  name?: string;
  parent_department_id?: string;
};

export type FeishuDirectoryProfile = {
  openId: string;
  unionId?: string;
  userId?: string;
  name: string;
  email?: string;
  department?: string;
  departmentIds: string[];
};

async function fetchContactDepartment(departmentId: string, token: string) {
  const config = serverConfig.feishuPlatform.directory;
  const url = new URL(
    `${config.contactBaseUrl}/departments/${encodeURIComponent(departmentId)}`,
  );
  url.searchParams.set('department_id_type', 'open_department_id');
  const payload = await requestFeishuJson<FeishuEnvelope>(
    'contact department request',
    url.toString(),
    { method: 'GET', headers: bearerHeaders(token) },
  );
  const data = isObject(payload.data) ? payload.data : undefined;
  const department = data && isObject(data.department) ? data.department : undefined;
  if (!department || typeof department.name !== 'string' || !department.name.trim()) {
    throw new FeishuPlatformRequestError('contact department response');
  }
  return department as ContactDepartment;
}

async function resolveDepartmentPath(departmentId: string, token: string) {
  const visited = new Set<string>();
  const names: string[] = [];
  let currentId: string | undefined = departmentId;

  for (let depth = 0; currentId && currentId !== '0'; depth += 1) {
    if (depth >= maximumDepartmentDepth) {
      throw new Error(`Feishu department hierarchy exceeds ${maximumDepartmentDepth} levels.`);
    }
    if (visited.has(currentId)) {
      throw new Error('Feishu department hierarchy contains a cycle.');
    }
    visited.add(currentId);
    const department = await fetchContactDepartment(currentId, token);
    names.push(department.name!.trim());
    currentId = department.parent_department_id?.trim() || undefined;
  }
  return names.reverse().join(' / ');
}

/**
 * Enrich a logged-in Feishu user by open_id. Disabled enrichment returns
 * undefined. API and hierarchy failures are intentionally surfaced so the
 * caller can keep the base login and degrade to name/email without a department.
 */
export async function enrichFeishuUserByOpenId(
  openId: string,
): Promise<FeishuDirectoryProfile | undefined> {
  if (!serverConfig.feishuPlatform.directory.enabled) return undefined;
  if (!/^ou_[A-Za-z0-9_-]{1,124}$/.test(openId)) {
    throw new Error('Feishu open_id has an invalid format.');
  }

  const token = await getTenantAccessToken();
  const config = serverConfig.feishuPlatform.directory;
  const url = new URL(`${config.contactBaseUrl}/users/${encodeURIComponent(openId)}`);
  url.searchParams.set('user_id_type', 'open_id');
  url.searchParams.set('department_id_type', 'open_department_id');
  const payload = await requestFeishuJson<FeishuEnvelope>(
    'contact user request',
    url.toString(),
    { method: 'GET', headers: bearerHeaders(token) },
  );
  const data = isObject(payload.data) ? payload.data : undefined;
  const user = data && isObject(data.user) ? (data.user as ContactUser) : undefined;
  if (!user) throw new FeishuPlatformRequestError('contact user response');

  const resolvedOpenId = typeof user.open_id === 'string' && user.open_id ? user.open_id : openId;
  const name =
    (typeof user.name === 'string' && user.name.trim()) ||
    (typeof user.en_name === 'string' && user.en_name.trim()) ||
    resolvedOpenId;
  // Some tenants populate only enterprise_email. Keep the historical priority.
  const email =
    (typeof user.email === 'string' && user.email.trim()) ||
    (typeof user.enterprise_email === 'string' && user.enterprise_email.trim()) ||
    undefined;
  const departmentIds = Array.isArray(user.department_ids)
    ? [...new Set(user.department_ids.filter((value): value is string => typeof value === 'string' && Boolean(value.trim())).map((value) => value.trim()))]
    : [];
  const departmentPaths: string[] = [];
  for (const departmentId of departmentIds) {
    const path = await resolveDepartmentPath(departmentId, token);
    if (path && !departmentPaths.includes(path)) departmentPaths.push(path);
  }

  return {
    openId: resolvedOpenId,
    unionId: typeof user.union_id === 'string' && user.union_id ? user.union_id : undefined,
    userId: typeof user.user_id === 'string' && user.user_id ? user.user_id : undefined,
    name,
    email,
    department: departmentPaths.length > 0 ? departmentPaths.join('；') : undefined,
    departmentIds,
  };
}

export const FEISHU_TELEMETRY_FIELD_NAMES = {
  aggregateKey: '聚合键',
  dateTime: '日期时间',
  dateKey: '日期键',
  version: '工具版本',
  hostVersion: '宿主版本',
  userName: '用户姓名',
  email: '飞书邮箱',
  department: '所属部门',
  computerName: '电脑名',
  downloadCount: '下载次数',
  texturePaintingCount: '贴图绘制次数',
  generationCount: '生图次数',
  modelBakingCount: '模型烘焙次数',
  toolboxCount: '工具箱次数',
  autoRetopologyCount: '自动拓扑次数',
  autoUvCount: '自动展UV次数',
  localRepaintCount: '局部重绘次数',
  localComponentDownloadCount: '本地组件下载次数',
  userKey: '用户唯一ID',
  eventCount: '事件总数',
  countsJson: '动作计数JSON',
  syncHash: '同步哈希',
} as const;

export type TelemetryAggregateForBitable = {
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
  last_event_at: string;
  sync_hash?: string;
  sync_record_id?: string;
};

export type BitableAggregateSyncResult = {
  aggregateKey: string;
  recordId: string;
  action: 'created' | 'updated';
};

type BitableFieldValue = string | number;
type BitableFields = Record<string, BitableFieldValue>;

function assertBoundedString(value: unknown, name: string, maximumLength: number) {
  if (typeof value !== 'string' || !value || value.length > maximumLength) {
    throw new Error(`${name} must be a non-empty string no longer than ${maximumLength} characters.`);
  }
  return value;
}

function countFor(counts: Record<string, number>, module: string, action: string) {
  return counts[`${module}_${action}_count`] ?? 0;
}

function totalDownloadCount(counts: Record<string, number>) {
  return Object.entries(counts).reduce(
    (total, [key, value]) => total + (key.endsWith('_download_count') ? value : 0),
    0,
  );
}

export function prepareTelemetryAggregateForBitable(aggregate: TelemetryAggregateForBitable) {
  const aggregateKey = assertBoundedString(aggregate.aggregate_key, 'aggregate_key', 2_000);
  const dateKey = assertBoundedString(aggregate.date_key, 'date_key', 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) throw new Error('date_key must use YYYY-MM-DD.');
  const userKey = assertBoundedString(aggregate.user_key, 'user_key', 256);
  const version = typeof aggregate.version === 'string' ? aggregate.version.slice(0, 64) : '';
  const hostVersion = typeof aggregate.host_version === 'string' ? aggregate.host_version.slice(0, 128) : '';
  if (!Number.isSafeInteger(aggregate.event_count) || aggregate.event_count < 0) {
    throw new Error('event_count must be a non-negative safe integer.');
  }
  if (!isObject(aggregate.counts)) throw new Error('counts must be an object.');
  const counts = Object.fromEntries(
    Object.entries(aggregate.counts)
      .map(([key, value]) => {
        if (!key || key.length > 128 || !Number.isSafeInteger(value) || value < 0) {
          throw new Error('counts contains an invalid key or value.');
        }
        return [key, value] as const;
      })
      .sort(([left], [right]) => left.localeCompare(right)),
  );
  const lastEventTimestamp = Date.parse(aggregate.last_event_at);
  if (!Number.isFinite(lastEventTimestamp)) throw new Error('last_event_at must be a valid timestamp.');
  if (aggregate.sync_record_id && !/^rec[A-Za-z0-9_-]+$/.test(aggregate.sync_record_id)) {
    throw new Error('sync_record_id has an invalid format.');
  }
  if (aggregate.sync_hash && !/^[a-f0-9]{64}$/i.test(aggregate.sync_hash)) {
    throw new Error('sync_hash must be a SHA-256 hexadecimal string.');
  }

  const fields: BitableFields = {
    [FEISHU_TELEMETRY_FIELD_NAMES.aggregateKey]: aggregateKey,
    [FEISHU_TELEMETRY_FIELD_NAMES.dateTime]: lastEventTimestamp,
    [FEISHU_TELEMETRY_FIELD_NAMES.dateKey]: dateKey,
    [FEISHU_TELEMETRY_FIELD_NAMES.version]: version,
    [FEISHU_TELEMETRY_FIELD_NAMES.hostVersion]: hostVersion,
    [FEISHU_TELEMETRY_FIELD_NAMES.userName]: aggregate.user_name ?? '',
    [FEISHU_TELEMETRY_FIELD_NAMES.email]: aggregate.email ?? '',
    [FEISHU_TELEMETRY_FIELD_NAMES.department]: aggregate.department ?? '',
    // Browser telemetry has no trustworthy host name. Keep the field explicit
    // and empty instead of inventing a value from user-controlled headers.
    [FEISHU_TELEMETRY_FIELD_NAMES.computerName]: '',
    [FEISHU_TELEMETRY_FIELD_NAMES.downloadCount]: totalDownloadCount(counts),
    [FEISHU_TELEMETRY_FIELD_NAMES.texturePaintingCount]: countFor(counts, 'texture_painting', 'open'),
    [FEISHU_TELEMETRY_FIELD_NAMES.generationCount]: countFor(counts, 'texture_painting', 'start'),
    [FEISHU_TELEMETRY_FIELD_NAMES.modelBakingCount]: countFor(counts, 'model_baking', 'start'),
    [FEISHU_TELEMETRY_FIELD_NAMES.toolboxCount]: countFor(counts, 'toolbox', 'open'),
    [FEISHU_TELEMETRY_FIELD_NAMES.autoRetopologyCount]: countFor(counts, 'auto_retopology', 'start'),
    [FEISHU_TELEMETRY_FIELD_NAMES.autoUvCount]: countFor(counts, 'auto_uv', 'start'),
    [FEISHU_TELEMETRY_FIELD_NAMES.localRepaintCount]: countFor(counts, 'local_repaint', 'start'),
    [FEISHU_TELEMETRY_FIELD_NAMES.localComponentDownloadCount]: countFor(counts, 'local_component', 'download'),
    [FEISHU_TELEMETRY_FIELD_NAMES.userKey]: userKey,
    [FEISHU_TELEMETRY_FIELD_NAMES.eventCount]: aggregate.event_count,
    [FEISHU_TELEMETRY_FIELD_NAMES.countsJson]: JSON.stringify(counts),
  };
  const syncHash =
    aggregate.sync_hash ??
    createHash('sha256').update(JSON.stringify(fields)).digest('hex');
  fields[FEISHU_TELEMETRY_FIELD_NAMES.syncHash] = syncHash;
  return {
    aggregateKey,
    fields,
    syncHash,
    recordId: aggregate.sync_record_id,
  };
}

function deterministicUuidV4(value: string) {
  const bytes = Buffer.from(createHash('sha256').update(value).digest().subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function bitableRecordsUrl(suffix = '') {
  const config = serverConfig.feishuPlatform.bitable;
  return `${config.baseUrl}/apps/${encodeURIComponent(config.appToken)}/tables/${encodeURIComponent(config.tableId)}/records${suffix}`;
}

type BitableRecord = {
  record_id?: string;
  fields?: Record<string, unknown>;
};

async function searchBitableRecord(aggregateKey: string, token: string) {
  const url = new URL(bitableRecordsUrl('/search'));
  url.searchParams.set('page_size', '2');
  const payload = await requestFeishuJson<FeishuEnvelope>(
    'Bitable aggregate search',
    url.toString(),
    {
      method: 'POST',
      headers: bearerHeaders(token),
      body: JSON.stringify({
        field_names: [FEISHU_TELEMETRY_FIELD_NAMES.aggregateKey],
        filter: {
          conjunction: 'and',
          conditions: [
            {
              field_name: FEISHU_TELEMETRY_FIELD_NAMES.aggregateKey,
              operator: 'is',
              value: [aggregateKey],
            },
          ],
        },
      }),
    },
  );
  const data = isObject(payload.data) ? payload.data : undefined;
  const items = data && Array.isArray(data.items) ? (data.items as BitableRecord[]) : [];
  if (items.length > 1) {
    throw new Error('Bitable contains duplicate rows for the same telemetry aggregate key.');
  }
  const recordId = items[0]?.record_id;
  return typeof recordId === 'string' && recordId ? recordId : undefined;
}

async function createBitableRecord(
  aggregateKey: string,
  fields: BitableFields,
  token: string,
) {
  const url = new URL(bitableRecordsUrl());
  url.searchParams.set('client_token', deterministicUuidV4(`create:${aggregateKey}`));
  const payload = await requestFeishuJson<FeishuEnvelope>(
    'Bitable aggregate create',
    url.toString(),
    {
      method: 'POST',
      headers: bearerHeaders(token),
      body: JSON.stringify({ fields }),
    },
  );
  const data = isObject(payload.data) ? payload.data : undefined;
  const record = data && isObject(data.record) ? data.record : undefined;
  const recordId = record && typeof record.record_id === 'string' ? record.record_id : undefined;
  if (!recordId) throw new FeishuPlatformRequestError('Bitable aggregate create response');
  return recordId;
}

async function updateBitableRecord(
  recordId: string,
  aggregateKey: string,
  syncHash: string,
  fields: BitableFields,
  token: string,
) {
  const url = new URL(bitableRecordsUrl(`/${encodeURIComponent(recordId)}`));
  url.searchParams.set('client_token', deterministicUuidV4(`update:${aggregateKey}:${syncHash}`));
  const payload = await requestFeishuJson<FeishuEnvelope>(
    'Bitable aggregate update',
    url.toString(),
    {
      method: 'PUT',
      headers: bearerHeaders(token),
      body: JSON.stringify({ fields }),
    },
  );
  const data = isObject(payload.data) ? payload.data : undefined;
  const record = data && isObject(data.record) ? data.record : undefined;
  return record && typeof record.record_id === 'string' && record.record_id
    ? record.record_id
    : recordId;
}

let bitableWriteQueue = Promise.resolve();

function runBitableExclusive<T>(task: () => Promise<T>) {
  const result = bitableWriteQueue.then(task, task);
  bitableWriteQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

/**
 * Upsert one absolute daily aggregate. The stable aggregate key prevents row
 * duplication, while deterministic UUIDv4 client_token values make retries of
 * the same create/update idempotent. Persist result.recordId locally and pass
 * it back as sync_record_id to avoid a search on the next update.
 */
export function syncTelemetryAggregateToBitable(
  aggregate: TelemetryAggregateForBitable,
): Promise<BitableAggregateSyncResult> {
  if (!serverConfig.feishuPlatform.bitable.enabled) {
    return Promise.reject(new Error('Feishu Bitable sync is disabled.'));
  }
  const prepared = prepareTelemetryAggregateForBitable(aggregate);
  return runBitableExclusive(async () => {
    const token = await getTenantAccessToken();
    if (prepared.recordId) {
      try {
        const recordId = await updateBitableRecord(
          prepared.recordId,
          prepared.aggregateKey,
          prepared.syncHash,
          prepared.fields,
          token,
        );
        return { aggregateKey: prepared.aggregateKey, recordId, action: 'updated' };
      } catch (error) {
        if (!(error instanceof FeishuPlatformRequestError) || error.apiCode !== 1254043) throw error;
      }
    }

    const existingRecordId = await searchBitableRecord(prepared.aggregateKey, token);
    if (existingRecordId) {
      const recordId = await updateBitableRecord(
        existingRecordId,
        prepared.aggregateKey,
        prepared.syncHash,
        prepared.fields,
        token,
      );
      return { aggregateKey: prepared.aggregateKey, recordId, action: 'updated' };
    }

    try {
      const recordId = await createBitableRecord(
        prepared.aggregateKey,
        prepared.fields,
        token,
      );
      return { aggregateKey: prepared.aggregateKey, recordId, action: 'created' };
    } catch (error) {
      // A previous create may have succeeded while its response was lost. On
      // idempotency conflict, resolve the stable key and switch to an update.
      if (
        !(error instanceof FeishuPlatformRequestError) ||
        ![1255006, 1254608].includes(error.apiCode ?? -1)
      ) {
        throw error;
      }
      const recordId = await searchBitableRecord(prepared.aggregateKey, token);
      if (!recordId) throw error;
      const updatedRecordId = await updateBitableRecord(
        recordId,
        prepared.aggregateKey,
        prepared.syncHash,
        prepared.fields,
        token,
      );
      return {
        aggregateKey: prepared.aggregateKey,
        recordId: updatedRecordId,
        action: 'updated',
      };
    }
  });
}
