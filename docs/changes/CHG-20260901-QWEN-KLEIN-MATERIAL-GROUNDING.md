# CHG-20260901 Qwen → Klein 材质证据锚定

## 变更身份

- 主模块：`M04` 生成编排；协作界面：`UI-05` 生成面板。
- 算法：`ALG-GEN-005` v1.9.0。
- 主实现：`apps/server/src/services/promptPolishService.ts`、`apps/web/src/services/localRepaintPromptPolishInputs.ts`。

## 问题与证据

用户要求“修复接缝”时，旧模板允许 Qwen 凭空扩写 `brushed steel base`、`clean weld bead`、`slight chamfer` 和“无缝铸造”。这些词与 Image 1 中明亮、均匀的局部几何占位叠加后，会诱导 FLUX.2 Klein 把白灰表面当成干净新金属保留；同时像素包围盒对 Klein 没有稳定的视觉定位价值。

使用固定种子和 `Flux2 Klein TrueV3-双图材质编辑-局部重绘` 工作流，以独立 mask、完整多视图参考和带白灰占位的当前效果图实测。将提示词改为先正面描述参考证据支持的真实目标材质，再用一句明确约束完整替换白灰 clay/primer/flat placeholder/untextured surface 后，进料槽恢复为对应参考中的深色旧钢结构，白膜消失，蒙版外构图保持。

## 实现

1. Qwen 先综合 Image 2 对应部件、第四张未修改 Image 1 选区裁切和 mask 外邻域，确定真实结构、底色、材质、粗糙度和磨损；不得把选区内异常外观当成目标。
2. 只有上述视觉证据共同表明纯白、浅灰或均匀光滑区域是未完成材质、几何预览或占位表面时，最终英文才必须要求用目标内容完整替换 clay/primer/flat placeholder/untextured surface。真实白色、浅灰材质和金属高光继续保留。
3. 修缝任务继续保护真实开口、槽道、装配间隙、焊缝、硬边和接触阴影。除非用户明确要求或图像证据支持，不得发明 brushed steel、clean metal、new weld bead、chamfer 或无缝铸造结构。
4. 最终 Klein 提示词不输出像素坐标或包围盒；实际编辑范围仍由独立 mask 决定。
5. 缓存策略升级为 `qwen-to-klein-material-grounding-v5`，避免复用旧模板生成的错误材质提示词。

## 影响、迁移与回滚

- 仅修改 M04 的 Qwen system content 和 UI-05 的提示词缓存策略；不修改 ModelView 的效果/白灰几何融合图、远端外扩 mask、作者 mask 或请求字段。
- 诊断次数、四图输入、GPU/CPU/Worker/shader、投影/UV/export、输出分辨率、Project/Layer/Generation/Capture Schema、Revision CAS、ownership 和对象资产均不变，无批量迁移。
- 回滚时恢复 v1.8.0 模板与 `qwen-to-klein-selection-crop-v4` 指纹；已有 Generation、图层、提示词和资产继续可读，不删除历史数据。

## 验证

- `pnpm --filter @liclick/server test:prompt-polish`
- `pnpm --filter @liclick/web typecheck`
- ComfyUI 固定种子真实 Klein 工作流视觉验证：白灰占位完整替换，参考材质、槽道结构和蒙版外画面保持。
