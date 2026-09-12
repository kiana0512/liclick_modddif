import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const source = await fs.readFile(
  path.resolve(import.meta.dirname, '../src/routes/ModelingToolboxPage.tsx'),
  'utf8',
);

const originalTools = [
  '模型批量整理',
  'UV 辅助工具',
  'LiClick 批量图生 3D',
  'Max 桥接 Maya / Blender',
  '面加权法线',
  'Blender 批量图生 3D',
  'Blender 桥接 Max',
  '贴图通道工具',
  'DCC 降版本工具',
];

for (const tool of originalTools) {
  assert.match(source, new RegExp(`name: '${tool.replaceAll('/', '\\/')}'`), `工具箱缺少：${tool}`);
}
assert.match(source, /5 Max · 2 Blender · 2 独立工具/);
assert.match(source, /modeling-toolbox-v2\.0\.1\.exe/);
assert.match(source, /download="建模工具箱-v2\.0\.1\.exe"/);
assert.match(source, /manual_max\.html/);
assert.match(source, /下载 Windows 安装器/);
assert.match(source, /查看使用说明/);
assert.match(source, /\['平台', 'Windows'\]/);
assert.match(source, /\['安装包', '11\.0 MB'\]/);
assert.match(source, /安装器与说明书已上传到 Li3D，可直接从本页获取/);
assert.match(
  source,
  /<BrandMark onBack=\{onBack\} backLabel="返回功能首页" \/>/,
  '工具箱顶部 LI3D Logo 必须返回功能首页',
);
assert.doesNotMatch(source, /LIclick-3D-Texture-Local-Component-Setup\.exe/);

console.log('原版建模工具箱下载入口、9 项清单、顶部 Logo 导航与零组件边界门禁通过。');
