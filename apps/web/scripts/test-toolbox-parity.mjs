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
assert.match(source, /PS \/ DCC\s+集成已明确暂缓/);
assert.match(source, /Cloud 版不提供安装器或本机桥接入口/);
assert.doesNotMatch(
  source,
  /modeling-toolbox-v2\.0\.1\.exe|manual_max\.html|下载 Windows 安装器|查看使用说明/,
);

console.log('原版建模工具箱 9 项清单、暂缓边界与零安装门禁通过。');
