import { createRequire } from 'node:module';
import path from 'node:path';
import { createServer } from 'vite';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.LICLICK_TEST_PLAYWRIGHT_MODULE || 'playwright');
const server = await createServer({ root: path.resolve(import.meta.dirname, '..'), server: { host: '127.0.0.1', port: 0, watch: null } });
server.middlewares.use('/__repair_test', (_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<html><body>Local repair regression</body></html>'); });
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ headless: true, channel: process.env.LICLICK_TEST_BROWSER_CHANNEL || 'msedge' });
  const page = await browser.newPage();
  const resolution = process.env.LICLICK_CONTENT_REPAIR_TEST_RESOLUTION || '2048';
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__repair_test?resolution=${resolution}`);
  console.log(JSON.stringify(await page.evaluate(async (size) => (await import('/scripts/local-boundary-blend-browser-fixture.mjs')).run(size), Number(resolution)), null, 2));
} finally { await browser?.close(); await server.close(); }
