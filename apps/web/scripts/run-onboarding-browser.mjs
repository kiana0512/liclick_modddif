import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { fileURLToPath, pathToFileURL } from 'node:url';
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright'
);
const root = fileURLToPath(new URL('..', import.meta.url));
const server = await createServer({
  root,
  configFile: false,
  appType: 'custom',
  esbuild: { jsx: 'automatic' },
  resolve: { alias: { '@': `${root}/src` } },
  optimizeDeps: {
    entries: ['scripts/onboarding-browser-fixture.mjs'],
    include: ['clsx', 'tailwind-merge'],
  },
  server: { host: '127.0.0.1', port: 0 },
});
server.middlewares.use('/__onboarding', (_req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.end(
    '<!doctype html><title>Onboarding regression fixture</title><link rel="icon" href="data:,"><script type="module" src="/scripts/onboarding-browser-fixture.mjs"></script>',
  );
});
await server.listen();
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  page.on('pageerror', (error) => {
    errors.push(error.message);
    console.error(error.message);
  });
  page.on('console', (message) => {
    if (message.type() === 'error') console.error(message.text());
  });
  await page.goto(`${server.resolvedUrls.local[0]}__onboarding`);
  await page.waitForFunction(() => Boolean(window.fixture));
  await page.evaluate(() => window.fixture.mount('browser-main'));
  await page.getByRole('dialog', { name: '基础入门：导入模型', exact: true }).waitFor();
  const launcher = page.getByRole('button', { name: '新手引导 · 1/3', exact: true });
  const entryBox = await launcher.boundingBox();
  const resolutionBox = await page
    .getByRole('button', { name: 'Resolution', exact: true })
    .boundingBox();
  assert.ok(
    entryBox.x > resolutionBox.x + resolutionBox.width &&
      Math.abs(entryBox.y + entryBox.height / 2 - resolutionBox.y - resolutionBox.height / 2) < 1,
  );
  assert.equal(await page.getByRole('button', { name: '定位操作区', exact: true }).count(), 0);
  await launcher.click();
  for (const width of [1200, 1024, 768, 640, 360]) {
    await page.setViewportSize({ width, height: 800 });
    await page.waitForTimeout(100);
    const box = await page.getByRole('region', { name: '新手引导菜单', exact: true }).boundingBox();
    assert.ok(
      box.x >= 0 && box.x + box.width <= width && box.y + box.height <= 800,
      `menu must fit inside the ${width}px viewport`,
    );
  }
  await page.setViewportSize({ width: 1200, height: 800 });
  await launcher.click();
  const card = await page.getByRole('dialog').boundingBox();
  const target = await page.locator('[data-texture-onboarding="import-model"]').boundingBox();
  assert.ok(card.x >= target.x + target.width, 'card must not obscure the import control');
  await page.evaluate(() => window.fixture.complete('import-model'));
  await page.getByRole('dialog', { name: '基础入门：添加参考图', exact: true }).waitFor();
  await page.getByRole('button', { name: '暂停引导', exact: true }).click();
  await page.evaluate(() => window.fixture.remount());
  await page.getByRole('button', { name: '新手引导', exact: true }).waitFor();
  assert.equal((await page.evaluate(() => window.fixture.progress())).status, 'paused');
  await page.reload();
  await page.waitForFunction(() => Boolean(window.fixture));
  await page.evaluate(() => window.fixture.mount('browser-main'));
  await page.getByRole('button', { name: '新手引导', exact: true }).waitFor();
  assert.equal((await page.evaluate(() => window.fixture.progress())).step, 1);
  await page.getByRole('button', { name: '新手引导', exact: true }).click();
  await page.getByRole('button', { name: '继续基础入门 · 第 2 步', exact: true }).click();
  await page.getByRole('dialog', { name: '基础入门：添加参考图', exact: true }).waitFor();
  await page.evaluate(() => window.fixture.suspend(true));
  await page.waitForFunction(() => !document.querySelector('[role="dialog"]'));
  await page.evaluate(() => window.fixture.suspend(false));
  await page.getByRole('dialog', { name: '基础入门：添加参考图', exact: true }).waitFor();
  await page.evaluate(() => window.fixture.complete('reference-images'));
  await page.getByRole('dialog', { name: '基础入门：生成纹理', exact: true }).waitFor();
  await page.getByRole('button', { name: '上一步', exact: true }).click();
  await page.getByRole('dialog', { name: '基础入门：添加参考图', exact: true }).waitFor();
  await page.waitForTimeout(900);
  assert.equal(
    (await page.evaluate(() => window.fixture.progress())).step,
    1,
    'back must not immediately auto-advance',
  );
  await page.getByRole('button', { name: '下一步', exact: true }).click();
  assert.equal(
    await page.getByRole('button', { name: '完成引导', exact: true }).isEnabled(),
    false,
  );
  await page.evaluate(() => window.fixture.complete('generate-texture'));
  await page.waitForFunction(() =>
    [...document.querySelectorAll('button')].some(
      (b) => b.textContent === '完成引导' && !b.disabled,
    ),
  );
  await page.getByRole('button', { name: '完成引导', exact: true }).click();
  await page.getByRole('button', { name: '引导已完成 · 进阶教程', exact: true }).click();
  await page.getByRole('button', { name: '选学：单视图调整', exact: true }).click();
  await page.getByRole('dialog', { name: '单视图调整：切换到单视图', exact: true }).waitFor();
  await page.evaluate(() => window.fixture.complete('single-view'));
  await page.getByRole('dialog', { name: '单视图调整：调整当前视角', exact: true }).waitFor();
  await page.waitForTimeout(900);
  assert.equal((await page.evaluate(() => window.fixture.progress())).status, 'active');
  await page.evaluate(() => window.fixture.complete('generate-texture', true, 'new-single'));
  await page.getByRole('button', { name: '引导已完成 · 进阶教程', exact: true }).click();
  await page.getByRole('button', { name: '选学：局部重绘', exact: true }).click();
  await page.getByRole('dialog', { name: '局部重绘：画出修改范围', exact: true }).waitFor();
  await page.locator('[data-texture-onboarding="repaint-mask"]').click();
  await page.waitForTimeout(900);
  assert.equal(
    (await page.evaluate(() => window.fixture.progress())).step,
    0,
    'tool selection is not a painted mask',
  );
  await page.evaluate(() => window.fixture.complete('repaint-mask'));
  await page.getByRole('dialog', { name: '局部重绘：生成局部效果', exact: true }).waitFor();
  await page.evaluate(() => window.fixture.complete('repaint-generate'));
  await page.waitForTimeout(900);
  assert.equal(
    (await page.evaluate(() => window.fixture.progress())).step,
    1,
    'old result is not the new exercise',
  );
  await page.evaluate(() => window.fixture.complete('repaint-generate', true, 'new-result'));
  await page.getByRole('dialog', { name: '局部重绘：涂抹应用结果', exact: true }).waitFor();
  await page.evaluate(() => window.fixture.complete('repaint-apply'));
  await page.locator('[data-texture-onboarding="repaint-apply"]').click();
  await page.waitForTimeout(900);
  assert.equal(
    (await page.evaluate(() => window.fixture.progress())).status,
    'active',
    'selecting apply must not finish the tutorial',
  );
  await page.getByRole('button', { name: '已涂抹并确认效果', exact: true }).click();
  await page.getByRole('button', { name: '引导已完成 · 进阶教程', exact: true }).click();
  await page.getByRole('button', { name: '重新学习基础入门', exact: true }).click();
  await page.getByRole('dialog', { name: '基础入门：导入模型', exact: true }).waitFor();
  await page.waitForTimeout(900);
  assert.equal((await page.evaluate(() => window.fixture.progress())).step, 0);
  await page.keyboard.press('Escape');
  await page.evaluate(() => {
    window.fixture.complete('import-model', false);
    window.fixture.mount('other-project');
  });
  await page.getByRole('dialog', { name: '基础入门：导入模型', exact: true }).waitFor();
  await page.setViewportSize({ width: 360, height: 640 });
  await page.evaluate(() => {
    const t = document.querySelector('[data-texture-onboarding="import-model"]');
    t.style.cssText = 'position:fixed;left:8px;top:8px;width:344px;height:624px';
  });
  await page.getByRole('button', { name: '新手引导 · 1/3', exact: true }).waitFor();
  await page.getByRole('button', { name: '新手引导 · 1/3', exact: true }).click();
  await page.getByRole('region', { name: '新手引导菜单', exact: true }).waitFor();
  await page.getByRole('button', { name: '暂停引导', exact: true }).click();
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.evaluate(() => {
    const t = document.querySelector('[data-texture-onboarding="import-model"]');
    t.style.display = 'none';
    window.fixture.mount('missing-target');
  });
  await page
    .getByText('请展开左侧对应面板；如仍未显示，请先导入并选中模型。', { exact: true })
    .waitFor();
  assert.deepEqual(errors, []);
  console.log(
    'Browser onboarding passed: 3 steps, pause/remount, busy/resume, back/restart, project isolation, optional repaint, real completion signals, narrow/missing targets.',
  );
} finally {
  await browser.close();
  await server.close();
}
