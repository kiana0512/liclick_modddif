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
assert.match(texture, /局部重绘连接云端 ComfyUI/);

for (const [module, required] of [
  ['AUTO UV', /正式 UV 产物/],
  ['AI RETOPOLOGY', /正式低模产物/],
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

console.log('首页五个原版功能入口与真实计算服务边界回归通过。');
