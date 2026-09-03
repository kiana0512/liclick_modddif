# CHG-20260829 局部重绘自动提示词与融合输入

## 变更身份

- 主模块：`M08` 局部重绘；协作模块：`M04` 生成编排、`M03` 场景/相机/捕获。
- UI：`UI-05` 生成面板。
- 算法：`ALG-GEN-005` v1.4.0、`ALG-LR-002` v3.1.0、`ALG-LR-012` v1.0.2。

## 问题

原路径把用户原文直接发给 ModelView，空输入时完全依赖远端自行猜测。当前效果图只有材质色，细小缺口或接缝区域在 latent inpaint 中容易被视为需要保留的原结构；精确蒙版又缺少与周围像素的重采样余量，容易在边界留下硬缝。

## 实现

1. 局部“生成”按钮会自动解析提示词。用户有输入时，Qwen 按用户意图扩写；用户留空时，Qwen 先对照当前效果图与原始蒙版位置分析结构、材质、接缝或缺失问题，再按 FLUX.2 Klein 四段模板输出英文提示词。
2. Qwen 只接收干净 2K 当前效果图、完整多视图参考和未外扩原始蒙版。它不接收 clay 白/灰几何覆盖，也不接收远端混合边界。
3. Qwen 结果不回填用户文本框，只写入 Generation.prompt 及 `promptSource/promptFingerprint/userPrompt`。指纹由项目、对象、参考、用户原文、mask revision、冻结相机/对象矩阵和图层 content revision 组成；先查内存缓存，再查已持久化 Generation。
4. Worker 在原始连续 mask 内把同相机 clay-target 几何预览融入 flat BaseColor 当前效果图；蒙版外保持原效果像素。该融合图只提交给 ModelView。
5. ModelView 使用的 RGB mask 从原始二值核自适应外扩 `clamp(0.2×mask短边, 16, 48)px@2K`，再羽化 `clamp(0.2×外扩, 4, 10)px@2K`；相比 v1.0.0 外扩范围加倍、羽化宽度不变，原始核心恢复为 255，确保用户指定区域必定重生成。
6. 完成 Generation 同时记录作者 `maskUrl/authoredMaskUrl` 和 ModelView 实际 `submittedMaskUrl`。Capture、画笔授权与历史恢复只绑定作者 mask，ModelView 提交才使用外扩 mask；结果仍以 `direct-v1` 直出。v1.0.2 对已保存的双蒙版 Generation 优先读取 `authoredMaskUrl`，避免旧任务刷新后仍把远端 mask 误作画笔授权。

## 失败、迁移与回滚

- 无新 Schema 版本和旧数据批量迁移；新 metadata 字段是可选审计信息，历史 Generation 照常读取。
- Qwen 失败会阻断本次 ModelView 提交并显示明确错误，不会静默改用用户原文或空提示词。mask revision 在解析期间变化同样阻断。
- 回滚可移除生成时 Qwen 解析和 `ALG-LR-012` Worker，恢复 flat BaseColor + 原始 mask 远端输入。已生成 PNG、capture、mask、Layer、Project Revision 均不删除或改写。

## 验证

- `pnpm typecheck`
- `pnpm --filter @liclick/server test:prompt-polish`
- `pnpm --filter @liclick/web test:local-repaint-generation-input`
- `pnpm --filter @liclick/web test:local-repaint-performance-merge`
- `pnpm --filter @liclick/web test:local-repaint-result-composite`
- `pnpm build`
