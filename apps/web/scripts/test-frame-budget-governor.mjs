import assert from 'node:assert/strict';
import path from 'node:path';
import { stdout } from 'node:process';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const server = await createServer({
  root,
  appType: 'custom',
  logLevel: 'silent',
  server: { middlewareMode: true },
});

try {
  const governor = await server.ssrLoadModule(
    '/src/engine/performance/frameBudgetGovernor.ts',
  );
  let budget = governor.createTextureUploadBudget();
  assert.equal(budget.pixels, 128 * 1024);

  const healthy = {
    frameMaximumMs: 16.7,
    frameSampleCount: 1,
    frameTargetMs: 16.7,
    synchronousWorkMs: 0.4,
    interactionBusy: false,
  };
  budget = governor.updateTextureUploadBudget(budget, healthy);
  budget = governor.updateTextureUploadBudget(budget, healthy);
  assert.equal(budget.pixels, 128 * 1024, 'Two healthy frames must not ramp prematurely.');
  budget = governor.updateTextureUploadBudget(budget, healthy);
  assert.equal(budget.pixels, 128 * 1024);
  budget = governor.updateTextureUploadBudget(budget, healthy);
  budget = governor.updateTextureUploadBudget(budget, healthy);
  budget = governor.updateTextureUploadBudget(budget, healthy);
  assert.equal(budget.pixels, 128 * 1024, 'The production ceiling protects frame pacing.');

  budget = governor.updateTextureUploadBudget(budget, {
    ...healthy,
    frameMaximumMs: 33.4,
  });
  assert.equal(budget.pixels, 64 * 1024, 'A missed frame must halve the next submission.');
  budget = governor.updateTextureUploadBudget(budget, {
    ...healthy,
    interactionBusy: true,
  });
  assert.equal(budget.pixels, 64 * 1024, 'Interaction must immediately reduce background work.');
  budget = governor.updateTextureUploadBudget(budget, {
    ...healthy,
    synchronousWorkMs: 4,
  });
  assert.equal(budget.pixels, 64 * 1024);
  budget = governor.updateTextureUploadBudget(budget, {
    ...healthy,
    frameMaximumMs: 50,
  });
  assert.equal(budget.pixels, 64 * 1024, 'The safety floor must remain bounded.');

  budget = governor.createTextureUploadBudget();
  budget = governor.updateTextureUploadBudget(budget, {
    ...healthy,
    frameMaximumMs: 16.7,
    frameTargetMs: 8.3,
  });
  assert.equal(
    budget.pixels,
    64 * 1024,
    'A 120 Hz missed frame must throttle even though 16.7ms is healthy at 60 Hz.',
  );

  stdout.write('Frame-budget governor regression test passed.\n');
} finally {
  await server.close();
}
