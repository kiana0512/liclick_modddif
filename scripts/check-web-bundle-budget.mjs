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
  // Generation framing adds the submission guards and lazy entry (~480 bytes).
  // Retain both measured allowances when integrating paired generation.
  // CHG-20260910-GPT-GUIDE-CAPTURE-ISOLATION: per-tile material identity
  // guard + authored-before-clay sequencing measures 498,829 bytes. Allow
  // 512 bytes here; retain the existing 3,160,000-byte total and other limits.
  { label: 'editor route', prefix: 'EditorPage-', maxBytes: 499_024 },
  // CHG-20260910-UV-REPAINT: lazy UV engine/session, shared visibility and
  // viewport adapters measure ~701,300 bytes here. Allocate 2,000 bytes only.
  { label: 'high bake snapshot', prefix: 'bakeHighSnapshot-', maxBytes: 702_000 },
  {
    label: 'shared 3D pipeline',
    // Rollup chooses the facade name from the shared module graph. Adding the
    // browser GLTF exporter changed only this generated name, not the boundary.
    prefixes: ['projectPipeline-', 'exportUtils-'],
    maxBytes: 850_000,
  },
];
// Repaint selection consumption adds ~4.9 KiB of shader/history code: the cloud
// candidate measures 3,144,697 bytes (previous 3,139,864). Grant only this feature's
// measured growth; retain the existing shell/editor/bake/shared hot-path limits.
// CHG-20260909-PROJECTED-ERASER-STORAGE adds 171 bytes over master-73c6e03
// (3,147,367 -> 3,147,538 with matching Cloud settings). Allow 250 bytes for
// this correctness fix only; individual chunk and quality limits stay intact.
// GPT-only UI and generation-time layer deletion: Cloud 3,147,349 -> 3,148,233
// (+884 bytes). Allow 1,000 bytes for this feature; per-chunk limits unchanged.
// Single-view restored-result auto projection adds recovery/commit guards.
// Candidate Cloud build: 3,150,063 bytes; allow 2,000 bytes of feature growth.
// Individual chunk limits, image resolution and QA gates remain unchanged.
// CHG-20260910-GPT-MULTIVIEW-PAIRS: lazy pair scheduler + fresh-capture /
// resident barriers add 5,191 bytes (3,150,085 -> 3,155,276). Editor adapters
// measure 497,751 bytes. Grant only this feature's measured payload; preserve
// the shell/bake/shared limits, output resolution and every QA contract.
// CHG-20260910-GENERATION-CAMERA-FRAMING: new camera animation/framing feature,
// measured 3,153,807 bytes, mostly loaded only on generation. Allocate 4,000
// bytes for this feature; image quality and all other chunk budgets unchanged.
// Combined feature allowance; final integrated release must be measured again.
// CHG-20260910-LOCAL-BOUNDARY-REPAIR: shared main/Worker interpolation adds
// 2,662 bytes with matching Cloud settings (3,159,715 -> 3,162,377).
// Allow 3,000 bytes including release metadata. Lazy compatibility loading
// reduces the editor to 486,072 bytes; all individual chunk/quality gates stay.
// CHG-20260910-ADAPTIVE-GAP-DISTANCE: same Cloud configuration grows 876
// bytes (3,162,508 -> 3,163,384) for adaptive CPU/Worker traversal and partial
// result feedback. Allow 1,000 bytes; individual chunks/quality gates unchanged.
// CHG-20260910-UV-REPAINT: full-resolution UV painting is a new capability.
// Matching Cloud builds: 3,163,590 -> 3,185,232 bytes (+21,642). The engine
// and commit coordinator are lazy; grant 22,000 bytes, keeping every other
// chunk limit, regression contract and output-resolution gate unchanged.
const maxTotalJavaScriptBytes = 3_186_000;

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
