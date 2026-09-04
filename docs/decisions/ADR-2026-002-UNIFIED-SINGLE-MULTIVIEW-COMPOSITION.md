# ADR-2026-002：普通单视图与多视图统一采用质量合成

> 状态：Accepted
> 日期：2026-09-04
> 决策者：用户、Codex
> 关联 CHG：`CHG-20260904-UNIFIED-SINGLE-MULTIVIEW-COMPOSITION`

## 背景

普通多视图投影使用视角、深度、覆盖和边缘权重参与 Top-3 quality blend；普通单视图曾被标记为 `single-view-priority-v1`，在质量合成完成后按图层顺序做 source-over。这个特殊分支会让单视图看起来只是平面叠在旧纹理上，单视图与单视图之间也会出现硬覆盖、边缘割裂和顺序依赖。

单视图仍需要自己的捕获适配：服务返回图可能没有可信 Alpha，因此必须使用编辑器生成的 capture mask 和 linear-view depth 限制几何覆盖。但捕获适配不应改变图层的合成身份。

## 决策

普通单视图和多视图都作为普通投影候选进入同一套 Top-3 quality blend：

- 使用相同的 frustum、depth、backface、facing、opacity、strength、HSL 和 quality 计算；
- 单视图使用完整不透明 RGB 作为颜色源，并由 capture mask 与 linear-view depth 决定可投影区域；
- 多视图继续使用各视角自己的颜色、Alpha、深度和可见性资产；
- 图层顺序不再让普通单视图获得无条件覆盖权；同一点由有效覆盖和投影质量决定贡献；
- 局部重绘、用户显式 Overlay 和已定义的 UV Overlay 仍按图层顺序合成，不并入普通投影质量竞争。

删除运行时 `single-view-priority-v1`、`priorityOverlay` 和单视图轮廓距离场 Alpha 分支。保留一个只读兼容迁移：旧工程加载时剥离 `projectionCompositeMode`，把旧单视图规范化为 `capture-mask + ignoreSourceAlpha + standard visibility`。

## 一致性范围

以下路径必须使用相同身份划分：

- 常驻实时投影材质；
- 渐进预览合成器；
- GPU UV bake；
- CPU/Worker UV 合成与导出；
- 图层可见性切换、项目恢复和旧数据惰性迁移。

## 后果

- 正面影响：单视图/多视图、单视图/单视图交界不再由生成顺序硬覆盖；相同表面选择更可靠的投影视角，接缝连续性与多视图一致。
- 产品语义：普通投影图层的视觉优先级由质量决定，不等同于图层列表位置。需要明确压住底层时，应使用局部重绘或显式 Overlay。
- 性能：删除 priority source-over 和距离场预处理，不增加 sampler、纹理分辨率或额外 pass；单视图只增加原有 capture mask/depth 消费。
- 风险：过去依赖“后生成单视图一定压住旧层”的项目，加载后外观可能更接近质量融合结果。

## 迁移与回退

- 迁移：不批量改写项目文件。`normalizeLayer` 在加载旧层时删除 `single-view-priority-v1`，补齐 capture-mask、忽略供应方 Alpha 和标准 visibility；下一次正常保存写入新契约。
- 回退：恢复旧类型、优先 Overlay shader/UV 分支和距离场生成逻辑，并停止剥离旧标记。回退前须重新执行 GPU/CPU/Worker/UV/export 一致性测试。

## 验证

- 新建多个单视图与多视图层时均不产生优先覆盖标记；
- 旧 `single-view-priority-v1` 项目可惰性迁移且不丢 capture mask/depth；
- 常驻材质和渐进预览只对显式 Overlay 走 ordered alpha；
- UV merge/export 与实时预览保持普通投影质量融合、显式 Overlay 顺序覆盖；
- Web 类型检查、生产构建及投影/局部重绘/UV 专项回归通过。
