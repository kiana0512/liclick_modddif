import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [generatePanel, feishuLoginFlow, authGate] = await Promise.all([
  readFile(path.join(root, 'src/components/panels/GeneratePanel.tsx'), 'utf8'),
  readFile(path.join(root, 'src/services/feishuLoginFlow.ts'), 'utf8'),
  readFile(path.join(root, 'src/components/auth/AppAuthGate.tsx'), 'utf8'),
]);

assert.match(
  generatePanel,
  /if \(!\(await requireFeishuLogin\(\)\)\)[\s\S]*createLiclickApiClient/,
  'The original generation invocation must continue after server-side Feishu authentication.',
);
assert.match(
  generatePanel,
  /runFeishuLoginFlow\([\s\S]*setAuthenticated/,
  'Generation authentication must use the shared Web OAuth popup and publish the returned session.',
);
assert.match(
  feishuLoginFlow,
  /window\.open\('about:blank',[\s\S]*popup\.location\.href = started\.redirectUrl/,
  'Feishu authorization must run in a popup without replacing the Li3D workspace route.',
);
assert.match(
  authGate,
  /runFeishuLoginFlow\([\s\S]*setAuthenticated/,
  'The global login gate and generation continuation must share one server-side OAuth flow.',
);
assert.doesNotMatch(
  `${generatePanel}\n${feishuLoginFlow}\n${authGate}`,
  /liclickAccountBindingFlow|continueToLiclickBinding|atlas\s+login|Atlas CLI/i,
  'Zero-install Web authentication must not restore Atlas CLI or a local account-binding component.',
);
assert.doesNotMatch(
  feishuLoginFlow,
  /window\.location\s*=|window\.location\.href\s*=/,
  'The parent Li3D tab must keep its current deep link throughout authentication.',
);

process.stdout.write('Server Web OAuth continuation regression test passed.\n');
