import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'vite';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE
  ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const root = fileURLToPath(new URL('..', import.meta.url));
const server = await createServer({ root, configFile: false,
  resolve: { alias: { '@': `${root}/src` } },
  server: { host: '127.0.0.1', port: 0, watch: { ignored: () => true } },
});
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/**', route => route.abort());
  await page.goto(server.resolvedUrls.local[0] + 'scripts/fixtures/content-framing.html');
  await page.waitForFunction(() => document.getElementById('result')?.textContent.startsWith('{'), null, { timeout: 90_000 });
  const result = JSON.parse(await page.locator('#result').innerText());
  assert.deepEqual(errors, []);
  assert.equal(result.ok, true, JSON.stringify(result));
  console.log(JSON.stringify(result));
} finally {
  await browser?.close();
  await server.close();
}
