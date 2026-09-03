/* global console */

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const assetsDir = path.resolve('apps/web/dist/assets');
const budgets = [
  {
    label: 'application shell',
    prefix: 'index-',
    maxBytes: 265_000,
    // Lazy routes may produce a tiny generated index facade. It is not the
    // application shell and is counted by the total JavaScript budget below.
    minimumMatchBytes: 100_000,
  },
  { label: 'editor route', prefix: 'EditorPage-', maxBytes: 495_000 },
  { label: 'high bake snapshot', prefix: 'bakeHighSnapshot-', maxBytes: 700_000 },
  {
    label: 'shared 3D pipeline',
    // Rollup chooses the facade name from the shared module graph. Adding the
    // browser GLTF exporter changed only this generated name, not the boundary.
    prefixes: ['projectPipeline-', 'exportUtils-'],
    maxBytes: 850_000,
  },
];
// The integrated performance release, centered transform proxy and per-model
// atomic texture reveal measure 3,125,470 bytes in the cloud build. Keep about
// 8 KiB of deterministic-build headroom; the tighter shell, editor, bake and
// shared-pipeline budgets still guard every hot path independently.
const maxTotalJavaScriptBytes = 3_134_000;

let entries;
try {
  entries = await fs.readdir(assetsDir, { withFileTypes: true });
} catch (error) {
  if (error?.code === 'ENOENT') {
    console.error('Cloud Web dist is missing. Build @liclick/web before checking bundle budgets.');
    process.exit(1);
  }
  throw error;
}

const scripts = await Promise.all(
  entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.js'))
    .map(async (entry) => ({
      name: entry.name,
      bytes: (await fs.stat(path.join(assetsDir, entry.name))).size,
    })),
);

const failures = [];
for (const budget of budgets) {
  const prefixes = budget.prefixes ?? [budget.prefix];
  const prefixMatches = scripts.filter((script) =>
    prefixes.some((prefix) => script.name.startsWith(prefix)),
  );
  // A tiny route helper can legitimately keep the exportUtils facade while
  // Rollup names the actual shared 3D graph projectPipeline (or vice versa).
  // Budget the single substantial graph, not an unrelated 1 kB facade.
  const minimumMatchBytes = budget.minimumMatchBytes ?? (prefixes.length > 1 ? 100_000 : 0);
  const matches = prefixMatches.filter((script) => script.bytes >= minimumMatchBytes);
  if (matches.length !== 1) {
    failures.push(
      `${budget.label}: expected one of ${prefixes.join(', ')}*.js, found ${matches.length}`,
    );
    continue;
  }
  if (matches[0].bytes > budget.maxBytes) {
    failures.push(
      `${budget.label}: ${matches[0].bytes} bytes exceeds ${budget.maxBytes} (${matches[0].name})`,
    );
  }
}

const totalJavaScriptBytes = scripts.reduce((total, script) => total + script.bytes, 0);
if (totalJavaScriptBytes > maxTotalJavaScriptBytes) {
  failures.push(
    `total JavaScript: ${totalJavaScriptBytes} bytes exceeds ${maxTotalJavaScriptBytes}`,
  );
}

if (failures.length > 0) {
  console.error('Cloud Web bundle budget failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(
  `Cloud Web bundle budget passed: ${scripts.length} chunks, ${totalJavaScriptBytes} bytes total.`,
);
