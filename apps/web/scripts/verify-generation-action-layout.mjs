import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import { createServer } from 'vite';

// Render the production action JSX and measurement effect, not a duplicated mock UI.
const root = fileURLToPath(new URL('..', import.meta.url)).replaceAll('\\', '/').replace(/\/$/, '');
const source = readFileSync(`${root}/src/components/panels/GeneratePanel.tsx`, 'utf8');
const ast = ts.createSourceFile('panel.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let action, effect;
function visit(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'generateAction') action = node.initializer.getText(ast);
  if (ts.isCallExpression(node) && node.expression.getText(ast) === 'useLayoutEffect' && node.getText(ast).includes('--generate-action-space')) effect = node.getText(ast);
  ts.forEachChild(node, visit);
}
visit(ast);
assert(action?.includes('GptGenerationOptions'));
assert.equal(source.match(/<GptGenerationOptions/g)?.length, 1);
assert(effect);
const dock = readFileSync(`${root}/src/components/workspace/WorkspaceDock.tsx`, 'utf8');
assert.equal(dock.match(/var\(--generate-action-space, 76px\)/g)?.length, 3);
const compiled = ts.transpileModule(`${effect}; return ${action};`, { compilerOptions: {
  target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React,
} }).outputText;
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
process.chdir(root);
const server = await createServer({ root, configFile: false, resolve: { alias: { '@': `${root}/src` } },
  esbuild: { jsx: 'automatic' }, logLevel: 'error', server: { host: '127.0.0.1', port: 0, watch: { ignored: () => true } },
  plugins: [{ name: 'action-layout-fixture',
    configureServer(server) { installFixturePage(server); },
    resolveId(id) { if (id === '/__action.mjs') return `${root}/__action.mjs`; },
    load(id) { if (id === `${root}/__action.mjs`) return `
      import React, {useLayoutEffect, useRef, useState} from 'react';
      import {createRoot} from 'react-dom/client';
      import {Button} from '/src/components/ui/Button.tsx';
      import {GptGenerationOptions} from '/src/components/ui/GptGenerationOptions.tsx';
      import {SegmentedControl} from '/src/components/ui/SegmentedControl.tsx';
      import {GPT_TEXTURE_MODELS, getGptTextureQualities, resolveGptTextureModel, resolveGptTextureQuality} from '/src/engine/generation/gptTextureModels.ts';
      import '/src/styles/globals.css';
      const root = createRoot(document.getElementById('footer'));
      window.writes = [];
      function Fixture({mode, locked}) {
        const [settings, setSettings] = useState({textureGptModel: GPT_TEXTURE_MODELS[0].value, textureGptQuality: 'high'});
        const scope = {React, useLayoutEffect, Button, GptGenerationOptions, SegmentedControl, GPT_TEXTURE_MODELS, getGptTextureQualities, resolveGptTextureModel, resolveGptTextureQuality,
          generateActionRef: useRef(null), workspaceActive: true, generatePanelExpanded: true, portalRoot: document.body,
          previewGeneration: undefined, canCancelGeneration: locked, isTextureMapTab: mode === 'single' || mode === 'multi',
          isGptLocalRepaint: mode === 'gpt', isLocalRepaintTab: mode === 'gpt' || mode === 'remote',
          textureGptModel: settings.textureGptModel, textureGptQuality: resolveGptTextureQuality(settings.textureGptQuality, settings.textureGptModel), textureViewMode: mode,
          workflowConfigurationLocked: locked, workflowSubmissionLocked: locked, resolution: '2K', textureMultiviewMode: 'stable',
          updateGenerationSettings: patch => { window.writes.push(patch); setSettings(previous => ({...previous, ...patch})); }, textureActionProgress: undefined,
          tab: mode === 'gpt' || mode === 'remote' ? 'repaint' : 'multiview', texturePipelineProgress: undefined,
          previewIsGenerating: false, displayedReferenceGroupGenerationState: undefined, generateActionRunning: locked,
          contentAwareRepairActive: false, localRepaintPreparationCancellable: false, snapshotPreparing: false,
          Sparkles: () => null, LoaderCircle: () => null, Square: () => null,
          handleGenerate: () => {}, notifyWorkflowOperationLocked: () => {}, cancelCurrentGeneration: () => {},
          t: key => ({generateTextureMap: '生成纹理贴图', generating: '生成中', generateImage: '生成图片'}[key] || key)};
        return new Function(...Object.keys(scope), ${JSON.stringify(compiled)})(...Object.values(scope));
      }
      window.renderCase = (mode, locked=false) => root.render(React.createElement(Fixture, {mode, locked}));
      window.unmountCase = () => root.unmount();
    `; },
  }],
});
function installFixturePage(server) { server.middlewares.use((req, res, next) => {
  if (req.url !== '/__action') return next();
  res.setHeader('Content-Type', 'text/html'); res.end(`<!doctype html>
  <meta charset="utf-8"><link rel="icon" href="data:,"><style>
  body { margin:0; background:#090914; --workspace-bottom-offset:16px; --workspace-left-top-offset:80px; }
  #dock { position:absolute; left:16px; width:292px; background:#151520;
    bottom:calc(var(--workspace-bottom-offset) + var(--generate-action-space,76px));
    height:calc(100% - var(--workspace-left-top-offset) - var(--workspace-bottom-offset) - var(--generate-action-space,76px)); }
  #footer {position:fixed; bottom:16px; left:16px; width:292px; border-radius:8px; overflow:hidden;}
  </style><aside id="dock">参考图 / 提示词区域</aside><div id="footer"></div><script type="module" src="/__action.mjs"></script>`); }); }
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage(), errors = [];
  page.on('pageerror', error => { errors.push(error.message); console.error(error.message); });
  page.on('console', message => { if (message.type() === 'error') console.error(message.text()); });
  page.on('response', response => { if (response.status() >= 400) console.error(response.status(), response.url()); });
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__action`);
  await page.waitForFunction(() => typeof window.renderCase === 'function');
  let cases = 0;
  for (const height of [720, 900, 1080]) for (const width of [292, 312]) for (const mode of ['single', 'multi', 'gpt', 'remote']) {
    await page.setViewportSize({ width: 1280, height });
    await page.evaluate(({width, mode}) => { document.getElementById('footer').style.width = `${width}px`; window.renderCase(mode); }, {width, mode});
    await page.waitForFunction(mode => document.querySelectorAll('[aria-label="GPT 模型选择"]').length === (mode === 'remote' ? 0 : 1), mode);
    await page.waitForTimeout(80);
    const geometry = await page.evaluate(() => {
      const footer = document.getElementById('footer'), dock = document.getElementById('dock');
      const block = document.querySelector('[aria-label="GPT 生图参数"]');
      const button = document.querySelector('[data-texture-onboarding="generate-texture"] > button');
      return { gap: footer.getBoundingClientRect().top - dock.getBoundingClientRect().bottom,
        overflow: footer.scrollWidth > footer.clientWidth, button: button.getBoundingClientRect().top,
        controls: block?.getBoundingClientRect().bottom, height: dock.getBoundingClientRect().height };
    });
    assert(geometry.gap >= 11 && geometry.gap <= 13, JSON.stringify(geometry));
    assert(geometry.height > 0 && !geometry.overflow);
    if (mode !== 'remote') assert(geometry.controls <= geometry.button);
    cases++;
  }
  await page.evaluate(() => window.renderCase('gpt'));
  const model = page.getByRole('button', {name:'GPT 模型选择', exact:true});
  const quality = page.getByRole('button', {name:'GPT 生图质量', exact:true});
  assert.match(await model.textContent(), /Sunburst/);
  assert.match(await quality.textContent(), /质量 · 高/);
  assert((await model.boundingBox()).x < (await quality.boundingBox()).x);
  const choose = async (trigger, label, count) => {
    const before = await page.locator('#footer').boundingBox();
    await trigger.click();
    assert.equal(await page.getByRole('menu').count(), 1);
    assert.equal(await page.getByRole('menuitemradio').count(), count);
    const menu = await page.getByRole('menu').boundingBox();
    assert(menu.y >= 0 && menu.y + menu.height < (await model.boundingBox()).y);
    assert.deepEqual(await page.locator('#footer').boundingBox(), before, 'Overlay must not reflow footer');
    await page.getByRole('menuitemradio', {name:label, exact:true}).click();
    assert.equal(await page.getByRole('menu').count(), 0, 'Selection closes popup');
    assert(await trigger.evaluate(el => el === document.activeElement));
  };
  await choose(model, 'GPT-Image 2.5 Flare', 3);
  await choose(quality, '最高', 5);
  await choose(model, 'GPT-Image 2', 3);
  assert.match(await quality.textContent(), /质量 · 高/);
  assert.deepEqual(await page.evaluate(() => window.writes), [
    {textureGptModel:'gpt-image-2.5-flare', textureGptQuality:'high'},
    {textureGptQuality:'max'}, {textureGptModel:'gpt-image-2', textureGptQuality:'high'}]);
  await choose(quality, '低', 3);
  await choose(model, 'GPT-Image 2.5 Sunburst', 3);
  assert.match(await quality.textContent(), /质量 · 低/);
  await choose(quality, '高', 5);
  await model.click();
  await quality.click();
  assert.equal(await page.getByRole('menu').count(), 1);
  assert.equal(await page.getByRole('menu', {name:'选择质量'}).count(), 1);
  await page.keyboard.press('End');
  assert.equal(await page.evaluate(() => document.activeElement.textContent.trim()), '最高');
  await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('menu').count(), 0);
  assert(await quality.evaluate(el => el === document.activeElement));
  await model.click();
  await page.locator('#dock').click();
  assert.equal(await page.getByRole('menu').count(), 0);
  await model.click();
  await page.evaluate(() => window.renderCase('multi', true));
  await page.waitForFunction(() => document.querySelector('[aria-label="GPT 模型选择"]')?.disabled);
  assert.equal(await page.locator('[aria-label="GPT 生图参数"] button:not(:disabled)').count(), 0);
  assert.equal(await page.getByRole('menu').count(), 0);
  assert.equal(await page.getByText('1:1 方图', {exact:false}).count(), 0);
  assert.equal(await page.getByText('最多4张并发', {exact:false}).count(), 0);
  const cancel = page.getByRole('button', {name:'终止纹理贴图生成', exact:true});
  assert(await cancel.isVisible());
  await page.evaluate(() => window.renderCase('multi'));
  await page.waitForTimeout(100);
  await model.click();
  if (process.env.LICLICK_LAYOUT_SCREENSHOT) await page.screenshot({path:process.env.LICLICK_LAYOUT_SCREENSHOT});
  await page.evaluate(() => window.unmountCase());
  assert.equal(await page.getByRole('menu').count(), 0);
  assert.equal(await page.evaluate(() => document.body.style.getPropertyValue('--generate-action-space')), '');
  assert.deepEqual(errors, []);
  console.log(`Generation action: ${cases} layouts, selection, locks, cancel and cleanup passed.`);
} finally { await browser?.close(); await server.close(); }
