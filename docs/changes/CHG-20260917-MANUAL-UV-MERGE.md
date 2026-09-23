# 手动 UV 局部重绘合并与导出

日期：2026-09-17；主模块 M07，协作 M08/M11。
算法：`UV-MANUAL-PAINT-COMPOSITION/1.0.0`；UV merge composition 11 → 12；final preparation cache v3 → v4。
基线：master `945bb09d`。仅本地修改，未推送或部署。

## 根因与修复

显式新建绘制层使用普通 UUID、type=uv、无 role；selected-uv 发布只更新图片与 contentRevision，刻意保留用户属性。
旧合并筛选仅接受旧 native ID、merged-uv 和 content-aware；自动合并同样漏掉普通 UV。标准模型导出把普通 UV 画在投影之下。

- 增加共享 `isUvPaintLayer`：识别普通 UV 和旧 native UV；排除 imported/merged base、内部 draft、内容识别填补（包括旧 ID/generation 标记）。不依赖名称，不写回图层角色。
- 面板已有共享过滤器直接覆盖单层/多选/全部可见合并；自动合并将可见、同对象或历史全局 UV 绘制层作为 delta，不误复用旧 merged UV。纯绘制 UV 可合并，单独 sparse repair 不当作完整底图。
- 合并前先 source-under 底图与修补，再按既有 UV stack 顺序 source-over 绘制层。CPU、GPU Worker、后台最终 PNG 预热一致，保留 opacity 与透明覆盖。
- FBX 临时合并使用相同排序/方向，已合成层从 remaining UV 中移除，避免透明度应用两次。GLB/GLTF/OBJ 公共准备将绘制 UV 置于投影之上，并在读取图层前等待实时笔画提交。
- 旧非 native 重绘 UV 的最终覆盖/旧修复兼容路径保持，不重新生图、不批量改名或迁移资产。

## 对应路径审计

GPU/CPU/Worker：复用既有 sourceOver 参数与像素核，只改变分类与调用方向。EditorPage 仅编排，共享判定/排序在 engine。
Shader/视口/画笔：不改材质、蒙版、UV 绘制或像素采样；UV 层间顺序沿用 compareUvLayersForComposition。
持久化：保留原合并成功后的资产验证、图层消费/撤销、Revision CAS、ownership、Command 幂等；导出仍不写工程。
缓存：合并算法版本与预热缓存升级；旧持久合并图不自动重做，旧源层仍在时用户可重新合并。

## 验证

- native-uv-merge：普通 UUID/改名、原生层、空图、隐藏/跨对象、底图/draft/旧修补排除、透明度与排序、UV-only、已有 merged 后继续绘制。
- fbx-temporary-uv：场景/对象两入口，普通 UUID 层盖在投影之上且只应用一次 opacity；现有 1K–8K、取消/源状态变化/失败清理和无持久化回归保留。
- merge-final-preparation：预热向 Worker 传递普通绘制层 sourceOver，缓存失效和 live revision 取消保持。
- 真实 Edge/WebGL/WebGPU 2K 夹具：两个普通 UUID 绘制层（上层 50%）、隐藏/跨对象层；CPU/GPU Worker 全 RGBA 字节差 0，合并前 FBX 与合并后 FBX 全字节差 0；标准模型导出像素与独立 Canvas source-over 一致。Canvas 8-bit 预乘舍入与 CPU straight-alpha 舍入有既有差异，不能宣称二者全字节相同。
- 64px → 2K 异尺寸夹具在 CPU Canvas 与 Worker resize 路径存在插值差异；本轮字节一致验证使用原尺寸 2K 绘制资产，不改既有缩放算法、不据此声称异尺寸全字节一致。
- 手动目标层/合并消费及撤销/合并预览/自动颜色导出/投影预热/模型导出方向/原生重绘/旧有序重绘回归通过；web 类型检查通过。
- 用户原“新项目12”的真实 UI 重跑尚未进行；测试使用隔离夹具，不修改生产项目。
- Web 生产构建通过，lint 0 errors（GeneratePanel 两项既有 unused warning）；其余重绘结果合成/图层保留/产品门禁/预热资源/持久缓存回归通过。

## 迁移与回滚

无 Schema、数据库或图片迁移。已有普通 UV 只需在新代码下重新合并/导出，不需重新生成。
已合并并消费源层的旧错误结果不能凭空找回像素；需撤销或恢复仍含源层的历史版本，再重新合并。
回滚本次代码与版本号即可恢复旧行为；已生成的正确合并 PNG 仍可读取，勿删除资产或重写工程。
