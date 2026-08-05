import assert from 'node:assert/strict';
import path from 'node:path';
import { stdout } from 'node:process';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const server = await createServer({
  root,
  appType: 'custom',
  logLevel: 'silent',
  server: { middlewareMode: true },
});

try {
  const progress = await server.ssrLoadModule(
    '/src/engine/loaders/modelImportProgress.ts',
  );
  const events = [
    { phase: 'preparing', phaseProgress: 0 },
    { phase: 'preparing', phaseProgress: 1 },
    { phase: 'reading', loadedBytes: 0, totalBytes: 100 },
    { phase: 'reading', loadedBytes: 45, totalBytes: 100 },
    { phase: 'reading', loadedBytes: 100, totalBytes: 100 },
    { phase: 'parsing' },
    { phase: 'parsing', phaseProgress: 1 },
    { phase: 'materials' },
    { phase: 'materials', phaseProgress: 1 },
    { phase: 'persisting', loadedBytes: 0, totalBytes: 100 },
    { phase: 'persisting', loadedBytes: 70, totalBytes: 100 },
    { phase: 'persisting', phaseProgress: 1 },
    { phase: 'registering', phaseProgress: 0.55 },
    { phase: 'registering', phaseProgress: 0.9 },
    { phase: 'complete', phaseProgress: 1 },
  ];

  const singleFileValues = events.map(progress.getModelImportFileProgress);
  singleFileValues.forEach((value, index) => {
    assert(Number.isFinite(value), `Progress event ${index} must produce a finite value.`);
    assert(value >= 0 && value <= 1, `Progress event ${index} must stay within 0..1.`);
    if (index > 0) {
      assert(
        value >= singleFileValues[index - 1],
        `Progress event ${index} must not move backwards.`,
      );
    }
  });
  assert.equal(singleFileValues.at(-1), 1);

  const firstComplete = progress.getModelImportBatchProgress(0, 2, {
    phase: 'complete',
    phaseProgress: 1,
  });
  const secondPreparing = progress.getModelImportBatchProgress(1, 2, {
    phase: 'preparing',
    phaseProgress: 0,
  });
  const secondComplete = progress.getModelImportBatchProgress(1, 2, {
    phase: 'complete',
    phaseProgress: 1,
  });
  assert.equal(firstComplete, 0.5);
  assert.equal(secondPreparing, 0.5);
  assert.equal(secondComplete, 1);

  const unknownTotal = { phase: 'reading', loadedBytes: 20, totalBytes: 0 };
  assert(Number.isFinite(progress.getModelImportFileProgress(unknownTotal)));
  assert.equal(progress.isModelImportProgressIndeterminate(unknownTotal), true);
  assert.equal(
    progress.getModelImportFileProgress({ phase: 'reading', phaseProgress: 99 }),
    progress.getModelImportFileProgress({ phase: 'reading', phaseProgress: 1 }),
  );

  const { AutoBakeProgressBar } = await server.ssrLoadModule(
    '/src/components/panels/AutoBakeProgressBar.tsx',
  );
  const determinateMarkup = renderToStaticMarkup(
    createElement(AutoBakeProgressBar, {
      progress: { title: 'Importing model', detail: 'Reading model data', progress: 0.42 },
    }),
  );
  assert.match(determinateMarkup, /role="progressbar"/);
  assert.match(determinateMarkup, /aria-label="Importing model"/);
  assert.match(determinateMarkup, /aria-valuenow="42"/);
  assert.match(determinateMarkup, /aria-live="polite"/);

  const indeterminateMarkup = renderToStaticMarkup(
    createElement(AutoBakeProgressBar, {
      progress: {
        title: 'Importing model',
        detail: 'Parsing geometry',
        progress: 0.52,
        indeterminate: true,
      },
    }),
  );
  assert.doesNotMatch(indeterminateMarkup, /aria-valuenow=/);
  assert.match(indeterminateMarkup, /aria-busy="true"/);

  stdout.write('Model import progress regression test passed.\n');
} finally {
  await server.close();
}
