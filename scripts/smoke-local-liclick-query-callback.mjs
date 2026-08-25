import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'li3d-liclick-query-callback-'));
const tokenFile = path.join(temporaryRoot, 'atlas.json');
let mockGateway;

function encodeJwtPart(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

try {
  mockGateway = http.createServer((request, response) => {
    request.resume();
    request.once('end', () => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ jsonrpc: '2.0', id: 'smoke', result: { content: [] } }));
    });
  });
  await new Promise((resolve, reject) => {
    mockGateway.once('error', reject);
    mockGateway.listen(0, '127.0.0.1', resolve);
  });
  const address = mockGateway.address();
  if (!address || typeof address === 'string') throw new Error('Mock gateway did not expose a TCP port.');

  process.env.ATLAS_TOKEN_FILE = tokenFile;
  process.env.ATLAS_GATEWAY_URL = `http://127.0.0.1:${address.port}`;

  const service = await import('../apps/server/dist/services/localLiclickAccountService.js');
  const email = 'test.user@example.invalid';
  const token = [
    encodeJwtPart({ alg: 'none', typ: 'JWT' }),
    encodeJwtPart({ email, name: 'Test User', exp: Math.floor(Date.now() / 1000) + 3600 }),
    'smoke',
  ].join('.');
  const binding = await service.startLocalLiclickAccountBinding(email);
  const response = await fetch(
    `http://localhost:20265/callback?id_token=${encodeURIComponent(token)}`,
  );
  const html = await response.text();
  const progress = service.getLocalLiclickAccountBindingProgress(binding.loginId, email);
  const redirectUri = new URL(binding.redirectUrl).searchParams.get('redirect_uri');
  const result = {
    status: response.status,
    successPage: html.includes('绑定成功'),
    progress: progress.status,
    email: progress.account?.email,
    redirectUri,
    credentialSaved: fs.existsSync(tokenFile),
  };
  console.log(JSON.stringify(result, null, 2));
  if (
    response.status !== 200 ||
    !result.successPage ||
    progress.status !== 'succeeded' ||
    progress.account?.email !== email ||
    redirectUri !== 'http://localhost:20265/callback' ||
    !result.credentialSaved
  ) {
    throw new Error('Query-string IDaaS callback smoke test failed.');
  }
} finally {
  if (mockGateway?.listening) {
    await new Promise((resolve) => mockGateway.close(resolve));
  }
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}
