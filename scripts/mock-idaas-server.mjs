import { createServer } from 'node:http';

const port = Number(process.env.MOCK_IDAAS_PORT ?? 5199);
const issuer = process.env.MOCK_IDAAS_ISSUER ?? `http://127.0.0.1:${port}`;
const clientId = process.env.MOCK_IDAAS_CLIENT_ID ?? 'liclick-local-test';
const clientSecret = process.env.MOCK_IDAAS_CLIENT_SECRET ?? 'local-secret';

const codes = new Map();
const tokens = new Map();

function sendJson(response, status, payload) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
  });
  response.end(JSON.stringify(payload));
}

function sendHtml(response, status, html) {
  response.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(html);
}

function base64urlJson(payload) {
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

function fakeIdToken(user) {
  return [
    base64urlJson({ alg: 'none', typ: 'JWT' }),
    base64urlJson({
      iss: issuer,
      aud: clientId,
      sub: user.sub,
      union_id: user.unionId,
      open_id: user.openId,
      email: user.email,
      name: user.name,
      picture: user.picture,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    }),
    '',
  ].join('.');
}

function validateClient(request, body) {
  const auth = request.headers.authorization;
  if (auth?.startsWith('Basic ')) {
    const decoded = Buffer.from(auth.slice('Basic '.length), 'base64').toString('utf8');
    return decoded === `${clientId}:${clientSecret}`;
  }
  return body.get('client_id') === clientId && (!body.get('client_secret') || body.get('client_secret') === clientSecret);
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', issuer);

  if (request.method === 'GET' && url.pathname === '/health') {
    sendJson(response, 200, { ok: true, issuer, clientId });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/authorize') {
    const redirectUri = url.searchParams.get('redirect_uri') ?? '';
    const state = url.searchParams.get('state') ?? '';
    const requestedClientId = url.searchParams.get('client_id') ?? '';
    if (requestedClientId !== clientId || !redirectUri || !state) {
      sendHtml(response, 400, '<h1>IDaaS mock request invalid</h1>');
      return;
    }

    const finish = () => {
      const code = crypto.randomUUID();
      const user = {
        sub: 'mock-user-001',
        unionId: 'mock-union-001',
        openId: 'mock-open-001',
        email: 'mock.user@liclick.local',
        name: 'Liclick Mock User',
        picture: 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2296%22 height=%2296%22%3E%3Crect width=%2296%22 height=%2296%22 rx=%2248%22 fill=%22%23ef4bd2%22/%3E%3Ctext x=%2248%22 y=%2256%22 text-anchor=%22middle%22 font-size=%2238%22 font-family=%22Arial%22 fill=%22white%22%3EL%3C/text%3E%3C/svg%3E',
      };
      codes.set(code, { user, redirectUri, createdAt: Date.now() });
      const callback = new URL(redirectUri);
      callback.searchParams.set('code', code);
      callback.searchParams.set('state', state);
      response.writeHead(302, { location: callback.toString(), 'cache-control': 'no-store' });
      response.end();
    };

    if (url.searchParams.get('mock_auto') === '1') {
      finish();
      return;
    }

    sendHtml(
      response,
      200,
      `<!doctype html>
<meta charset="utf-8">
<title>IDaaS Mock Login</title>
<body style="font-family:Arial,'Microsoft YaHei',sans-serif;margin:0;background:#f7f8fb;color:#1f2937">
  <main style="min-height:100vh;display:grid;place-items:center">
    <section style="width:420px;background:white;border:1px solid #e5e7eb;border-radius:14px;padding:32px;box-shadow:0 20px 50px rgba(15,23,42,.08)">
      <div style="text-align:center;font-size:28px;font-weight:800;color:#111827">Lilith</div>
      <h1 style="font-size:18px;text-align:center;margin:18px 0 8px">Idaas认证</h1>
      <p style="font-size:13px;line-height:1.7;color:#64748b;text-align:center">本页面是 Liclick 本地测试用 IDaaS 模拟器，用于验证 OAuth 回调、Cookie 会话和用户隔离链路。</p>
      <form method="post" action="/approve" style="margin-top:24px">
        <input type="hidden" name="redirect_uri" value="${redirectUri.replaceAll('"', '&quot;')}">
        <input type="hidden" name="state" value="${state.replaceAll('"', '&quot;')}">
        <button style="width:100%;height:42px;border:0;border-radius:8px;background:#2563eb;color:white;font-weight:700;cursor:pointer">授权</button>
      </form>
    </section>
  </main>
</body>`,
    );
    return;
  }

  if (request.method === 'POST' && url.pathname === '/approve') {
    const body = new URLSearchParams(await readBody(request));
    const redirectUri = body.get('redirect_uri') ?? '';
    const state = body.get('state') ?? '';
    const code = crypto.randomUUID();
    const user = {
      sub: 'mock-user-001',
      unionId: 'mock-union-001',
      openId: 'mock-open-001',
      email: 'mock.user@liclick.local',
      name: 'Liclick Mock User',
    };
    codes.set(code, { user, redirectUri, createdAt: Date.now() });
    const callback = new URL(redirectUri);
    callback.searchParams.set('code', code);
    callback.searchParams.set('state', state);
    response.writeHead(302, { location: callback.toString(), 'cache-control': 'no-store' });
    response.end();
    return;
  }

  if (request.method === 'POST' && url.pathname === '/token') {
    const body = new URLSearchParams(await readBody(request));
    if (!validateClient(request, body)) {
      sendJson(response, 401, { error: 'invalid_client' });
      return;
    }
    const code = body.get('code') ?? '';
    const record = codes.get(code);
    if (!record) {
      sendJson(response, 400, { error: 'invalid_grant' });
      return;
    }
    codes.delete(code);
    const accessToken = `mock-access-${crypto.randomUUID()}`;
    tokens.set(accessToken, record.user);
    sendJson(response, 200, {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: 3600,
      id_token: fakeIdToken(record.user),
    });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/userinfo') {
    const token = request.headers.authorization?.replace(/^Bearer\s+/i, '');
    const user = token ? tokens.get(token) : undefined;
    if (!user) {
      sendJson(response, 401, { error: 'invalid_token' });
      return;
    }
    sendJson(response, 200, {
      data: {
        union_id: user.unionId,
        open_id: user.openId,
        sub: user.sub,
        email: user.email,
        name: user.name,
        picture: user.picture,
      },
    });
    return;
  }

  sendHtml(response, 404, '<h1>Not Found</h1>');
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Mock IDaaS server running at ${issuer}`);
  console.log(`Authorize URL: ${issuer}/authorize`);
});
