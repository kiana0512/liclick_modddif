/* global URL, Response, Request, console */
import assert from 'node:assert/strict';
import worker from '../worker/sites-worker.js';

const origin = 'https://li3d.example.test';
const env = {
  FEISHU_OAUTH_CLIENT_ID: 'cli_test',
  FEISHU_OAUTH_CLIENT_SECRET: 'test-secret',
  FEISHU_OAUTH_REDIRECT_URL: `${origin}/api/auth/feishu/callback`,
  LI3D_SESSION_SECRET: 'session-secret-that-is-long-enough-for-a-smoke-test',
  ASSETS: {
    fetch: async () => new Response('asset missing', { status: 404 }),
  },
};

const originalFetch = globalThis.fetch;
globalThis.fetch = async (input) => {
  const url = typeof input === 'string' ? input : input.url;
  if (url.includes('/oauth/token')) {
    return Response.json({ access_token: 'access-token' });
  }
  if (url.includes('/user_info')) {
    return Response.json({
      code: 0,
      data: {
        open_id: 'ou_smoke',
        union_id: 'on_smoke',
        name: 'Li3D Smoke User',
        enterprise_email: 'smoke@example.test',
        avatar_url: 'https://example.test/avatar.png',
      },
    });
  }
  throw new Error(`Unexpected outbound request: ${url}`);
};

try {
  const start = await worker.fetch(
    new Request(`${origin}/api/auth/feishu/start`),
    env,
  );
  assert.equal(start.status, 200);
  const started = await start.json();
  assert.match(started.loginId, /^web-oauth-/);
  const authorization = new URL(started.redirectUrl);
  assert.equal(authorization.searchParams.get('client_id'), env.FEISHU_OAUTH_CLIENT_ID);
  assert.equal(authorization.searchParams.get('redirect_uri'), env.FEISHU_OAUTH_REDIRECT_URL);
  assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(authorization.searchParams.get('code_challenge'));

  const oauthCookie = start.headers.get('set-cookie')?.match(/li3d_oauth_state=[^;]+/)?.[0];
  assert.ok(oauthCookie);
  const callback = await worker.fetch(
    new Request(
      `${env.FEISHU_OAUTH_REDIRECT_URL}?code=smoke-code&state=${encodeURIComponent(authorization.searchParams.get('state'))}`,
      { headers: { cookie: oauthCookie } },
    ),
    env,
  );
  assert.equal(callback.status, 200);
  const callbackCookies = callback.headers.get('set-cookie') ?? '';
  const sessionCookie = callbackCookies.match(/li3d_session=[^;]+/)?.[0];
  assert.ok(sessionCookie);

  const me = await worker.fetch(
    new Request(`${origin}/api/auth/me`, { headers: { cookie: sessionCookie } }),
    env,
  );
  assert.equal(me.status, 200);
  const mePayload = await me.json();
  assert.equal(mePayload.authenticated, true);
  assert.equal(mePayload.user.displayName, 'Li3D Smoke User');
  assert.equal(mePayload.user.email, 'smoke@example.test');

  const poll = await worker.fetch(
    new Request(`${origin}/api/auth/feishu/poll/${started.loginId}`, {
      headers: { cookie: sessionCookie },
    }),
    env,
  );
  assert.equal((await poll.json()).done, true);

  const invalidCallback = await worker.fetch(
    new Request(`${env.FEISHU_OAUTH_REDIRECT_URL}?code=smoke-code&state=wrong`, {
      headers: { cookie: oauthCookie },
    }),
    env,
  );
  assert.equal(invalidCallback.status, 409);

  console.log('Sites Feishu auth smoke passed.');
} finally {
  globalThis.fetch = originalFetch;
}
