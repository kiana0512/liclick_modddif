# ADR-2026-001：单视图采用核心优先、轮廓距离场接回底层

> 状态：Accepted
> 日期：2026-08-27
> 决策者：用户、Codex
> 关联 CHG：`CHG-20260827-TEXTURE-EDITOR-OPTIMIZATIONS`

## 背景

普通多视图投影使用 Top-3 quality blend，而后生成的单视图使用 ordered priority overlay。两者的生成模型、颜色和细节可能略有差异；如果单视图在捕获轮廓内快速变为不透明，边缘会形成明显割裂。把单视图整体改回普通质量混合又会削弱文字、Logo 和用户明确要求的新纹理。

另一个约束是供应方 PNG Alpha 不可信：可能为全不透明，也可能包含背景抠图结果。几何覆盖必须继续由捕获 mask 与 linear-view depth 决定，不能让供应方 Alpha 决定投影到哪些表面。

## 决策

保留两类图层的职责：多视图继续作为 Top-3 质量底层，单视图继续作为 ordered priority overlay。仅当同一对象已有可见普通 projected/UV 底层时，浏览器为单视图投影源生成编辑器作者的 inward distance-field Alpha：轮廓为 0.12，在 `max(24,min(128,maxDim×0.035))` 像素内平滑升到 1.0。没有底层时保持不透明源。

投影图片保持原捕获尺寸；capture mask/depth 始终是几何 footprint 权威。供应方 Alpha 默认忽略，只有创建阶段带 `projectionEdgeBlendMode=distance-field-v1` 的图片才持久化 `ignoreSourceAlpha=false`。实时材质、渐进预览和 GPU UV bake 消费同一 Layer/image/mask/depth 契约。

## 备选方案

| 方案 | 优点 | 缺点 | 未选择原因 |
|---|---|---|---|
| 单视图整体参加 Top-3 quality blend | 接缝自然 | 核心文字和新纹理可能被旧多视图稀释 | 不符合“单视图用于明确覆盖修正”的产品意图 |
| 单视图整张完全不透明 | 实现简单、核心稳定 | 边缘割裂明显，颜色差异直接形成硬边 | 已被真实资产复现否定 |
| 仅缩小 capture mask | 可减少轮廓污染 | 会丢失真实几何边缘，且不同分辨率难以稳定 | 几何 footprint 不应为视觉接缝让步 |
| 只做颜色匹配 | 不改变 Alpha | 生成内容差异较大时仍会看到结构硬边 | 单独不足以解决覆盖不连续 |
| 核心优先 + 轮廓距离场 | 核心清晰、边缘可融合、兼容现有 ordered stack | 需要生成投影专用 PNG，旧层不会自动获得新权重 | 选用 |

## 后果

- 正面影响：单视图核心保持权威；轮廓自然接回多视图/UV；GPT2 与远端共享同一投影契约；实时与烘焙一致。
- 成本与风险：创建投影层时增加一次全图 mask/RGB/距离场处理；通过复用 typed-array queue/distance buffer 控制 4K 峰值内存。
- 迁移步骤：无批量迁移；旧 Layer 显式/缺省 `ignoreSourceAlpha` 语义保持。用户重新生成单视图后获得新效果。
- 回退方式：关闭 `edgeBlend`、停止声明 `distance-field-v1` 并恢复 `ignoreSourceAlpha=true`；已保存资产仍可读取。
- 需要更新：`ALG-PROJ-002/003` 升级到 v3，`ALG-PROJ-005` 升级到 v2，`ALG-UV-004` 升级到 v3，维护手册升级到 2.4.0。

## 验证

- 单元回归覆盖轮廓 Alpha 单调上升、RGB 外扩和输入不变性。
- 图层回归覆盖旧层兼容、双提供方 capture mask/depth 契约及 source-alpha 开关。
- 实时常驻材质、渐进预览与 GPU UV bake 保持 surface-lock/source-alpha 同义。
- Web typecheck、生产构建与真实 Chrome 项目加载通过。
