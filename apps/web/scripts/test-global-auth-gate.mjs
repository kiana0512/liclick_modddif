import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [app, gate, logo] = await Promise.all([
  readFile(path.join(root, 'src/App.tsx'), 'utf8'),
  readFile(path.join(root, 'src/components/auth/AppAuthGate.tsx'), 'utf8'),
  readFile(path.join(root, 'src/components/common/Li3dLogo.tsx'), 'utf8'),
]);

const gateIndex = app.indexOf("if (authStatus !== 'authenticated')");
const firstRouteIndex = app.indexOf("if (route.name === 'editor'", gateIndex);
assert(
  gateIndex >= 0 && firstRouteIndex >= 0 && gateIndex < firstRouteIndex,
  'The global authentication gate must protect every application route before route rendering.',
);
assert.match(app, /<AppAuthGate\s*\/>/, 'Unauthenticated users must see the global Li3D gate.');
assert(
  gate.includes('<Li3dLogo') && !gate.includes('liclick-icon.png'),
  'The login gate must display the supplied Li3D branding.',
);
assert(
  logo.includes('branding/li3d-logo-dark-source.png') && logo.includes('<feColorMatrix'),
  'The Li3D logo must preserve the supplied artwork while removing its black background.',
);
assert.match(
  gate,
  /runFeishuLoginFlow[\s\S]*setAuthenticated/,
  'The login gate must use the server-side Feishu Web OAuth session.',
);
assert.doesNotMatch(
  `${app}\n${gate}`,
  /Atlas CLI|liclickAccountBindingFlow/i,
  'The global gate must remain independent from the retired local component.',
);
assert.doesNotMatch(
  gate,
  /window\.history|window\.location/,
  'Authentication must preserve the original deep link rather than redirecting the main tab.',
);

process.stdout.write('Global Li3D authentication gate regression test passed.\n');
