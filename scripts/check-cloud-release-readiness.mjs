import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const allowedStatuses = new Set(['passed', 'in_progress', 'failed', 'not_tested', 'deferred']);
const matrixPath = path.resolve('quality/cloud-release-readiness.json');
const matrix = JSON.parse(await fs.readFile(matrixPath, 'utf8'));

if (matrix.schemaVersion !== 1 || !Array.isArray(matrix.capabilities)) {
  throw new Error('Cloud release readiness matrix has an unsupported schema.');
}

const ids = new Set();
for (const capability of matrix.capabilities) {
  if (!capability.id || ids.has(capability.id)) {
    throw new Error(`Cloud release readiness contains an invalid or duplicate id: ${capability.id}`);
  }
  ids.add(capability.id);
  if (!allowedStatuses.has(capability.status)) {
    throw new Error(`${capability.id} has unsupported status: ${capability.status}`);
  }
  if (!Array.isArray(capability.evidence) || capability.evidence.length === 0) {
    throw new Error(`${capability.id} must contain verification evidence.`);
  }
}

const incomplete = matrix.capabilities.filter(
  (capability) => capability.required && capability.status !== 'passed',
);
if (incomplete.length > 0) {
  console.error('Cloud release is NOT ready. Required capabilities without passing evidence:');
  incomplete.forEach((capability) => {
    console.error(`- ${capability.id}: ${capability.status} — ${capability.name}`);
  });
  process.exitCode = 1;
} else {
  console.log(`Cloud release is ready: ${matrix.capabilities.length} capabilities passed.`);
}
