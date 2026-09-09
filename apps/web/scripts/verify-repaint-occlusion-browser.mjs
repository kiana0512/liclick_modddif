import { createServer } from 'vite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('../', import.meta.url));
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE
  ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const server = await createServer({ root, configFile: false,
  resolve: { alias: { '@': path.join(root, 'src') } },
  server: { host: '127.0.0.1', port: 5197, strictPort: true },
});
await server.listen();
let browser;
try {
  browser = await chromium.launch({ headless: true, channel: 'msedge' });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => { errors.push(String(error)); console.error(error); });
  page.on('console', message => { if (message.type() === 'error') { errors.push(message.text()); console.error(message.text()); } });
  await page.goto('http://127.0.0.1:5197/test-fixtures/repaint-occlusion.html');
  await page.waitForFunction(() => window.__occlusionResult, null, { timeout: 60000 });
  const result = await page.evaluate(() => window.__occlusionResult);
  console.log(JSON.stringify({ ...result, errors }, null, 2));
  assert.deepEqual(errors, []);
  assert.ok(result.legacyFailures > 0, 'The negative control must reproduce occlusion failure');
  assert.equal(result.currentFailureCount, 0, 'Current shader must preserve occlusion and visible repaint');
} finally {
  await browser?.close();
  await server.close();
}
