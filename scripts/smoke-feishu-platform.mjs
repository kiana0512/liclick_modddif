import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import http from 'node:http';

function readJson(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      try {
        resolve(chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch (error) {
        reject(error);
      }
    });
    request.on('error', reject);
  });
}

function sendJson(response, status, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
  });
  response.end(body);
}

async function main() {
  const configModuleUrl = new URL('../apps/server/dist/config.js', import.meta.url).href;
  const strictConfigCheck = spawnSync(
    process.execPath,
    ['--input-type=module', '--eval', `await import(${JSON.stringify(configModuleUrl)})`],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        SERVER_HOST: '127.0.0.1',
        SESSION_SECRET: 'feishu-platform-config-smoke-only',
        FEISHU_DIRECTORY_ENRICHMENT_ENABLED: 'true',
        FEISHU_BITABLE_SYNC_ENABLED: 'false',
        FEISHU_OAUTH_CLIENT_ID: '',
        FEISHU_OAUTH_CLIENT_SECRET: '',
      },
    },
  );
  assert.notEqual(strictConfigCheck.status, 0, 'Enabled directory integration must require App ID/Secret.');
  assert.match(
    strictConfigCheck.stderr,
    /required configuration is missing: FEISHU_OAUTH_CLIENT_ID, FEISHU_OAUTH_CLIENT_SECRET/,
  );
  const strictBitableConfigCheck = spawnSync(
    process.execPath,
    ['--input-type=module', '--eval', `await import(${JSON.stringify(configModuleUrl)})`],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        SERVER_HOST: '127.0.0.1',
        SESSION_SECRET: 'feishu-platform-config-smoke-only',
        FEISHU_DIRECTORY_ENRICHMENT_ENABLED: 'false',
        FEISHU_BITABLE_SYNC_ENABLED: 'true',
        FEISHU_OAUTH_CLIENT_ID: 'cli_smoke',
        FEISHU_OAUTH_CLIENT_SECRET: 'smoke-app-secret',
        FEISHU_BITABLE_APP_TOKEN: '',
        FEISHU_BITABLE_TABLE_ID: '',
      },
    },
  );
  assert.notEqual(
    strictBitableConfigCheck.status,
    0,
    'Enabled Bitable integration must require app_token and table_id.',
  );
  assert.match(
    strictBitableConfigCheck.stderr,
    /required configuration is missing: FEISHU_BITABLE_APP_TOKEN, FEISHU_BITABLE_TABLE_ID/,
  );

  let tokenRequests = 0;
  let created = false;
  let createFields;
  const updateFields = [];
  const updateClientTokens = [];
  let mockFailure;

  const mock = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (request.method === 'POST' && url.pathname === '/tenant-token') {
        tokenRequests += 1;
        assert.deepEqual(await readJson(request), {
          app_id: 'cli_smoke',
          app_secret: 'smoke-app-secret',
        });
        sendJson(response, 200, {
          code: 0,
          msg: 'ok',
          tenant_access_token: 'tenant-smoke-token-must-not-be-logged',
          expire: 7200,
        });
        return;
      }

      assert.equal(
        request.headers.authorization,
        'Bearer tenant-smoke-token-must-not-be-logged',
        'Platform calls must use the cached tenant token.',
      );

      if (request.method === 'GET' && url.pathname === '/contact/v3/users/ou_smoke') {
        assert.equal(url.searchParams.get('user_id_type'), 'open_id');
        assert.equal(url.searchParams.get('department_id_type'), 'open_department_id');
        sendJson(response, 200, {
          code: 0,
          data: {
            user: {
              open_id: 'ou_smoke',
              union_id: 'on_smoke',
              user_id: 'user_smoke',
              name: 'Smoke User',
              email: '',
              enterprise_email: 'smoke.user@example.invalid',
              department_ids: ['od_team'],
            },
          },
        });
        return;
      }

      if (
        request.method === 'GET' &&
        ['/contact/v3/users/ou_cycle', '/contact/v3/users/ou_deep'].includes(url.pathname)
      ) {
        const cycle = url.pathname.endsWith('ou_cycle');
        sendJson(response, 200, {
          code: 0,
          data: {
            user: {
              open_id: cycle ? 'ou_cycle' : 'ou_deep',
              name: cycle ? 'Cycle User' : 'Deep User',
              department_ids: [cycle ? 'od_cycle_a' : 'od_depth_1'],
            },
          },
        });
        return;
      }

      if (request.method === 'GET' && url.pathname === '/contact/v3/departments/od_team') {
        sendJson(response, 200, {
          code: 0,
          data: {
            department: {
              open_department_id: 'od_team',
              name: 'Team',
              parent_department_id: 'od_studio',
            },
          },
        });
        return;
      }

      if (request.method === 'GET' && url.pathname === '/contact/v3/departments/od_studio') {
        sendJson(response, 200, {
          code: 0,
          data: {
            department: {
              open_department_id: 'od_studio',
              name: 'Studio',
              parent_department_id: '0',
            },
          },
        });
        return;
      }


      const cycleDepartment = /^\/contact\/v3\/departments\/od_cycle_([ab])$/.exec(url.pathname);
      if (request.method === 'GET' && cycleDepartment) {
        const side = cycleDepartment[1];
        sendJson(response, 200, {
          code: 0,
          data: {
            department: {
              open_department_id: `od_cycle_${side}`,
              name: `Cycle ${side.toUpperCase()}`,
              parent_department_id: side === 'a' ? 'od_cycle_b' : 'od_cycle_a',
            },
          },
        });
        return;
      }

      const depthDepartment = /^\/contact\/v3\/departments\/od_depth_(\d+)$/.exec(url.pathname);
      if (request.method === 'GET' && depthDepartment) {
        const depth = Number(depthDepartment[1]);
        sendJson(response, 200, {
          code: 0,
          data: {
            department: {
              open_department_id: `od_depth_${depth}`,
              name: `Depth ${depth}`,
              parent_department_id: depth >= 21 ? '0' : `od_depth_${depth + 1}`,
            },
          },
        });
        return;
      }

      const recordsPath = '/bitable/v1/apps/app_smoke/tables/tblSmoke/records';
      if (request.method === 'POST' && url.pathname === `${recordsPath}/search`) {
        const body = await readJson(request);
        assert.equal(body.filter.conditions[0].field_name, '聚合键');
        assert.equal(body.filter.conditions[0].operator, 'is');
        assert.equal(body.filter.conditions[0].value[0], 'aggregate-smoke-key');
        sendJson(response, 200, {
          code: 0,
          data: {
            items: created ? [{ record_id: 'recSmoke123' }] : [],
            total: created ? 1 : 0,
          },
        });
        return;
      }

      if (request.method === 'POST' && url.pathname === recordsPath) {
        assert.match(
          url.searchParams.get('client_token') ?? '',
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
        );
        const body = await readJson(request);
        createFields = body.fields;
        created = true;
        sendJson(response, 200, {
          code: 0,
          data: { record: { record_id: 'recSmoke123', fields: body.fields } },
        });
        return;
      }

      if (request.method === 'PUT' && url.pathname === `${recordsPath}/recSmoke123`) {
        const clientToken = url.searchParams.get('client_token') ?? '';
        assert.match(
          clientToken,
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
        );
        const body = await readJson(request);
        updateClientTokens.push(clientToken);
        updateFields.push(body.fields);
        sendJson(response, 200, {
          code: 0,
          data: { record: { record_id: 'recSmoke123', fields: body.fields } },
        });
        return;
      }

      sendJson(response, 404, { code: 404, msg: 'not found' });
    } catch (error) {
      mockFailure = error;
      sendJson(response, 500, { code: 999, msg: 'mock assertion failed' });
    }
  });

  await new Promise((resolve, reject) => {
    mock.once('error', reject);
    mock.listen(0, '127.0.0.1', resolve);
  });
  const address = mock.address();
  if (!address || typeof address === 'string') throw new Error('Could not allocate mock port.');
  const mockBase = `http://127.0.0.1:${address.port}`;

  try {
    process.env.SERVER_HOST = '127.0.0.1';
    process.env.SESSION_SECRET = 'feishu-platform-smoke-only';
    process.env.LICLICK_ENABLE_ATLAS_LOCAL_LOGIN = 'false';
    process.env.FEISHU_OAUTH_CLIENT_ID = 'cli_smoke';
    process.env.FEISHU_OAUTH_CLIENT_SECRET = 'smoke-app-secret';
    process.env.FEISHU_DIRECTORY_ENRICHMENT_ENABLED = 'true';
    process.env.FEISHU_TENANT_TOKEN_URL = `${mockBase}/tenant-token`;
    process.env.FEISHU_CONTACT_BASE_URL = `${mockBase}/contact/v3`;
    process.env.FEISHU_BITABLE_SYNC_ENABLED = 'true';
    process.env.FEISHU_BITABLE_BASE_URL = `${mockBase}/bitable/v1`;
    process.env.FEISHU_BITABLE_APP_TOKEN = 'app_smoke';
    process.env.FEISHU_BITABLE_TABLE_ID = 'tblSmoke';

    const service = await import(
      `../apps/server/dist/services/feishuPlatformService.js?smoke=${Date.now()}`
    );

    const directoryProfile = await service.enrichFeishuUserByOpenId('ou_smoke');
    assert.equal(directoryProfile.name, 'Smoke User');
    assert.equal(
      directoryProfile.email,
      'smoke.user@example.invalid',
      'enterprise_email must be used when email is empty.',
    );
    assert.equal(directoryProfile.department, 'Studio / Team');

    await assert.rejects(
      service.enrichFeishuUserByOpenId('ou_cycle'),
      /department hierarchy contains a cycle/,
    );
    await assert.rejects(
      service.enrichFeishuUserByOpenId('ou_deep'),
      /department hierarchy exceeds 20 levels/,
    );

    await service.enrichFeishuUserByOpenId('ou_smoke');
    assert.equal(tokenRequests, 1, 'tenant_access_token must be cached across platform calls.');

    const baseAggregate = {
      aggregate_key: 'aggregate-smoke-key',
      date_key: '2026-08-03',
      user_key: 'feishu:ou_smoke',
      user_name: 'Smoke User',
      email: 'smoke.user@example.invalid',
      department: 'Studio / Team',
      version: '0.1.4',
      host_version: 'browser',
      event_count: 1,
      counts: { texture_painting_open_count: 1 },
      last_event_at: '2026-08-03T10:00:00.000Z',
      sync_hash: 'a'.repeat(64),
    };
    const createdResult = await service.syncTelemetryAggregateToBitable(baseAggregate);
    assert.deepEqual(createdResult, {
      aggregateKey: 'aggregate-smoke-key',
      recordId: 'recSmoke123',
      action: 'created',
    });
    assert.equal(createFields['事件总数'], 1);
    assert.equal(
      createFields['动作计数JSON'],
      JSON.stringify({ texture_painting_open_count: 1 }),
    );
    assert.equal(createFields['贴图绘制次数'], 1);
    assert.equal(createFields['生图次数'], 0);
    assert.equal(createFields['下载次数'], 0);
    assert.equal(createFields['电脑名'], '');

    const updatedAggregate = {
      ...baseAggregate,
      event_count: 2,
      counts: { texture_painting_open_count: 2 },
      sync_hash: 'b'.repeat(64),
      sync_record_id: createdResult.recordId,
    };
    const updatedResult = await service.syncTelemetryAggregateToBitable(updatedAggregate);
    assert.equal(updatedResult.action, 'updated');
    assert.equal(updatedResult.recordId, 'recSmoke123');
    assert.equal(updateFields[0]['事件总数'], 2, 'Bitable updates must write an absolute value.');

    await service.syncTelemetryAggregateToBitable(updatedAggregate);
    assert.equal(
      updateClientTokens[0],
      updateClientTokens[1],
      'Retries of identical content must reuse the same update client_token.',
    );
    assert.equal(tokenRequests, 1, 'directory and Bitable must share the cached tenant token.');
    if (mockFailure) throw mockFailure;
    console.log('Feishu platform mock smoke passed: token cache, directory hierarchy, and idempotent Bitable upsert.');
  } finally {
    await new Promise((resolve) => mock.close(resolve));
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
