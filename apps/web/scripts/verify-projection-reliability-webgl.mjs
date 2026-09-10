import { createRequire } from 'node:module';
import path from 'node:path';
import { createServer } from 'vite';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.LICLICK_TEST_PLAYWRIGHT_MODULE || 'playwright');
const server = await createServer({ root:path.resolve(import.meta.dirname,'..'), server:{host:'127.0.0.1',port:0,watch:null} });
server.middlewares.use('/__projection_test',(_req,res)=>{res.setHeader('Content-Type','text/html');res.end('<html><body>Projection regression</body></html>');});
let browser;
try {
  await server.listen();
  browser=await chromium.launch({headless:true,channel:process.env.LICLICK_TEST_BROWSER_CHANNEL || 'msedge',args:['--enable-webgl','--ignore-gpu-blocklist']});
  const page=await browser.newPage();
  page.on('console',m=>{if(m.type()==='error')console.error(m.text());});
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__projection_test`);
  console.log(JSON.stringify(await page.evaluate(async()=> (await import('/scripts/projection-reliability-browser-fixture.mjs')).run()),null,2));
} finally { await browser?.close(); await server.close(); }
