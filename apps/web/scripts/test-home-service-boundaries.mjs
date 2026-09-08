import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const source = await fs.readFile(
  path.resolve(import.meta.dirname, '../src/routes/HomePage.tsx'),
  'utf8',
);

const moduleSource = (eyebrow) => {
  const start = source.indexOf(`eyebrow="${eyebrow}"`);
  assert.notEqual(start, -1, `首页缺少 ${eyebrow} 模块`);
  const end = source.indexOf('/>', start);
  assert.notEqual(end, -1, `${eyebrow} 模块配置不完整`);
  return source.slice(start, end);
};

const texture = moduleSource('TEXTURE PAINTING');
assert.match(texture, /浏览器本机运行绘制/);
assert.match(texture, /badge="本机运行"/);
assert.match(texture, /本机绘制 · 云端 AI · 账号保存/);
assert.doesNotMatch(texture, /本地保存/);
assert.match(texture, /局部重绘连接云端生成服务/);
assert.doesNotMatch(texture, /ComfyUI/);

for (const [module, required] of [
  ['AUTO UV', /正式 UV 产物/],
  ['MODEL BAKING', /PBR 贴图返回浏览器/],
]) {
  const card = moduleSource(module);
  assert.match(card, /badge="云端服务"/, `${module} 必须标记为云端生产服务`);
  assert.match(card, /云端/, `${module} 必须说明云端任务边界`);
  assert.match(card, required, `${module} 必须说明正式交付产物`);
  assert.doesNotMatch(card, /本机运行|浏览器本机完成|服务器不补算|xatlas WASM|BVH 烘焙/);
}

const toolbox = moduleSource('PRODUCTION TOOLS');
assert.match(toolbox, /工具箱/);
assert.match(toolbox, /3ds Max · Blender · 独立工具/);
assert.doesNotMatch(source, /AI RETOPOLOGY|自动拓扑 V6|onOpenRetopology/);
assert.match(source, /4 个工作模块/);

const visualOrder = [
  'TEXTURE PAINTING',
  'AUTO UV',
  'MODEL BAKING',
  'PRODUCTION TOOLS',
].map((eyebrow) => source.indexOf(`eyebrow="${eyebrow}"`));
assert.deepEqual(
  visualOrder,
  [...visualOrder].sort((left, right) => left - right),
  '新增模块不得挤动原版 UV、烘焙和工具箱的卡片位置',
);

console.log('首页四个可用功能入口、隐藏自动拓扑与真实计算服务边界回归通过。');

// Render the actual homepage with server-provided capability snapshots.
const { createServer } = await import('vite');
const { createElement } = await import('react');
const { renderToStaticMarkup } = await import('react-dom/server');
const vite = await createServer({ root: path.resolve(import.meta.dirname, '..'), appType: 'custom', logLevel: 'silent', server: { middlewareMode: true } });
try {
  const { HomePage } = await vite.ssrLoadModule('/src/routes/HomePage.tsx');
  const { useAuthStore } = await vite.ssrLoadModule('/src/stores/authStore.ts');
  const initial = useAuthStore.getInitialState();
  const user = { id: 'test', displayName: '测试账号', role: 'maintainer', authSource: 'feishu-oauth' };
  const props = Object.fromEntries(['onOpenTexture', 'onOpenBake', 'onOpenToolbox', 'onOpenUv', 'onLogout'].map(key => [key, () => {}]));
  for (const allowed of [false, true, false]) {
    initial.user = { ...user, performanceLabAdmin: allowed };
    const html = renderToStaticMarkup(createElement(HomePage, props));
    assert.equal(html.includes('日志监测'), allowed);
    assert.equal(html.includes('performance-lab-admin'), allowed);
    assert.ok(html.includes(allowed ? '5 个工作模块' : '4 个工作模块'));
  }
  initial.user = undefined;
} finally { await vite.close(); }
