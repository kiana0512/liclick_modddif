# 固定显隐基线与拓扑 revision 可行性审计

2026-09-15；分析与基线记录，不修改生产代码、不构建、不部署。

## 固定条件与结果

- Chrome 当前工程 `project-4f91cea9-348c-4149-af58-ca2c01192316`（新项目1），base.obj，2K；入口 `index-c31mXh3K.js`。
- 固定图层“投射贴图 · 底”，ID `projected-layer-cd295b1c-ea24-4544-b9b7-640fafc49c80`。原状态可见，其他图层、相机与分辨率未操作。
- 执行 20 轮隐藏→显示，共 40 次。每次读取按钮眼睛状态与 DOM 诊断；发布 revision 从 3 连续到 42，40 次均 ready。结束时恢复可见并选择原图层，页面显示 Saved。
- 原页面已有六层可见投影的重算记录 436.2ms；本轮首次隐藏变成五层可见，产生唯一新阶段报告 447.9ms。此后 39 次显隐复用缓存报告，stage JSON 完全相同。
- 原始操作序列见 [CSV](20260915-fixed-visibility-baseline.csv)。无操作时间戳，不以自动化工具往返耗时冒充应用延迟。

### 唯一新重算样本

| 字段 | ms / 值 |
| --- | ---: |
| 总重算 | 447.9 |
| 投影 raster 缓存 | 5 命中 / 0 未命中 |
| 候选前缀复用 | 5 层 |
| maskPreparationMs | 146.1 |
| completeBakeMs | 217.6 |
| 光栅与回读整段 | 113.4 |
| 最终 resolve | 105.7 |
| 原始 RGBA 回读 | 41.2 |
| 回读加校正 | 82.4 |
| 拓扑准备 | 177.0 |
| 留边等待拓扑 | 38.1 |
| 留边实际查边 / 扩展 | 7.8 / 15.9 |
| 留边总计 | 62.0 |
| 底图合成 | 56.4 |
| 上传显示 | 27.7 |

这些字段有嵌套与重叠，不能直接相加；177ms 拓扑准备不等于可从总耗时直接减去 177ms，本轮进入留边后的直接等待为 38.1ms。

### 基线边界与采集缺口

这不是 40 个新重算耗时样本：只有 1 个有效新样本，不能据此提供可靠中位数/P95，也不能把热命中记为 0ms 或 447.9ms。首次隐藏仍有 GPU raster/拓扑缓存，不是从空缓存开始的冷加载。没有清空用户缓存、刷新标签页或变更其他图层以制造冷样本。

源码佐证：`ResidentProjectedUvDisplay.request()` 命中缓存直接 onReady；`SceneRoot` 的 onReady 每次增加 residentUvProjectionRevision，而 display duration/stages 只在真正重算完成时写入。因此 revision 增加代表发布，不代表重算。当前重复显隐已经绕过拓扑准备；P1 主要改善新组合或内容变化所触发的重算。

后续若要验收热显隐延迟，应增加每次操作唯一 trace ID、点击起点、cache-hit/rebuild 来源、发布耗时及首个新画面帧时间，再按来源统计 20 次以上。此次限定为基线与审计，没有新增这些生产埋点。

## revision 审计

现有 `projectionAttributeRevision` 记录 attribute/storage/array 对象身份、count、itemSize、normalized、version、offset/stride；能识别属性替换及显式更新，不能发现同一数组未标记更新的原地写入。目前没有统一覆盖所有拓扑修改的权威 revision。

| 入口 | 当前行为 | 对拓扑复用的要求 |
| --- | --- | --- |
| LayersPanel → layerStore.setLayerVisibility | 更新层 visible、活动层/工具，不修改模型几何 | 可以作为纯显隐入口，但须确认期间无几何修改 |
| 导入/替换模型 | 新 group/objectId/geometry；sceneStore 更新 importedModels | root/geometry 身份变化必须失效 |
| ViewportCanvas AcceleratedSceneRoot / drei Bvh | 默认 indirect=false；构建时可能原地重排索引；模型集合变化会重新挂载 Bvh | 必须在 BVH 完成之后确立稳定版本；重建前失效，完成后换代 |
| localUvUnwrap.applyAtlasResult | 替换 UV、index 及其他属性；作用于独立载入的模型后导出 | 属性身份可识别，不能只用 version 数字；正式服务结果重新导入也必须换代 |
| repairConcaveFbxPreview | 克隆修复几何，替换 child.geometry | geometry 身份变化可识别 |
| uvRepaint | 建立独立绘制场景和 owned geometry，不原地重写原模型 UV | 区分派生辅助网格与源模型拓扑，避免无关失效 |
| 原始 UV/index 数组写入 | Three 不自动增加 version | 未接管的修改保持精确扫描，不能无条件走快路径 |

导入 normalizeImportedModel 只改 group 平移/缩放；UV-only 拓扑本身不依赖这些世界变换。网格成员、UV/index 身份及辅助层排除标记仍应纳入拓扑签名，不能只检查 root.uuid。

### 隔离反例验证

使用当前已安装 three / three-mesh-bvh 0.7.8，创建 30×30 分段 PlaneGeometry（1800 三角面），保留索引数组副本后执行 `new MeshBVH(geometry, {maxLeafTris:12, verbose:false})`：

```json
{"sameAttribute":true,"sameArray":true,"versionBefore":0,"versionAfter":0,"changedIndexSlots":5386}
```

另对 UV 数组直接写入一个不同值，version 同样保持 0。验证只使用新建隔离几何，没有修改用户模型。该反例证明仅替换为现有 attribute revision 判断不足以保持当前精确扫描契约。

## 可行性结论与建议

P1 有条件可行，但不应现在直接删除所有字节扫描。

1. 为受管理的源几何建立明确生命周期：导入、FBX 修复、BVH 建立完成后发布稳定 topology revision；UV/index、网格结构修改及 BVH 重建均先失效再换代。
2. 仅让已纳入生命周期管理的稳定源几何使用轻量签名检查（网格/属性/数组身份、属性版本、布局、显式拓扑 revision）。这通常是按网格数量的检查，不是对所有三角形逐个扫描。
3. 未管理来源、进行中的重建、直接数组写入入口或不完整的修改通知继续原精确扫描。不能仅因为操作叫“显隐”就信任所有几何未变。
4. 新的几何 revision 必须同步失效拓扑 mask、投影 raster、候选前缀及最终显示缓存，避免只更新其中一层。
5. 验收覆盖直接 UV/index 写入、替换属性但 version 归零、BVH 原地重排、网格增删、辅助层、模型切换、快速取消和 Worker 失败；最终 mask/RGBA 一致。

先补足按操作区分热命中与重算的计时，是建立可靠中位数/P95 的前置条件。重复显隐已经命中最终缓存，本轮不能证明 P1 会进一步加快这 39 次热命中。

## 源码定位

- `apps/web/src/stores/layerStore.ts:434`：显隐入口。
- `apps/web/src/engine/bake/projectionBakeSignature.ts:15`：现有属性 revision。
- `apps/web/src/engine/bake/webGpuUvTopologyRaster.ts:158`：当前精确验证。
- `apps/web/src/engine/viewport/ViewportCanvas.tsx:490`：Bvh 生命周期入口。
- `apps/web/node_modules/@react-three/drei/core/Bvh.js`：当前依赖的构建选项与副作用。
- `apps/web/src/engine/uv/localUvUnwrap.ts:92`：UV/索引替换。
- `apps/web/src/features/workflow/repairFbxPreviewGeometry.ts:205`：修复几何替换。
- `apps/web/src/engine/localRepaint/uvRepaint.ts:359`：独立派生网格。
- `apps/web/src/engine/projection/ResidentProjectedUvDisplay.ts:94`、`apps/web/src/engine/viewport/SceneRoot.tsx:2622`：缓存发布与计时字段边界。
